/**
 * 持久化层：node:sqlite 单文件 + 事件溯源账本。
 * 事件 append-only；「修改」= 追加 correct，「作废」= 追加 void。
 * 当前分数由重放得出，不存可变余额，天然支持多人并发写入。
 * 庄家（v1.6「赢家坐庄」）：落账事务内庄家=该局赢家；作废按剩余局回滚；
 * 看板手选按钮仍是兜底覆盖（手改后如再作废旧局，以剩余局重推为准，可再手选修正）。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RULES, SEATS } from './rules.ts'
import { minTransfers } from './settle.ts'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DB_PATH = process.env.MJ_DB || join(ROOT, 'data', 'mahjong.db')
mkdirSync(dirname(DB_PATH), { recursive: true })

const db = new DatabaseSync(DB_PATH)
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS rooms (
    code        TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    dealer      TEXT NOT NULL DEFAULT 'E',
    horse_count INTEGER NOT NULL DEFAULT 4,
    unit_price  REAL NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS players (
    room_code TEXT NOT NULL,
    seat      TEXT NOT NULL,
    nickname  TEXT NOT NULL,
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (room_code, seat)
  );
  CREATE TABLE IF NOT EXISTS events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    room_code    TEXT NOT NULL,
    round_no     INTEGER NOT NULL DEFAULT 0,
    type         TEXT NOT NULL,           -- score | correct | void
    payload      TEXT NOT NULL,           -- JSON
    author       TEXT NOT NULL DEFAULT '',
    ref_event_id INTEGER,
    created_at   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_events_room ON events(room_code, id);
`)

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function newCode() {
  for (let i = 0; i < 50; i++) {
    let c = ''
    for (let j = 0; j < 6; j++) c += ALPHABET[Math.floor(Math.random() * ALPHABET.length)]
    if (!db.prepare('SELECT 1 FROM rooms WHERE code=?').get(c)) return c
  }
  throw new Error('房间码生成失败')
}

function zero() {
  return { E: 0, S: 0, W: 0, N: 0 }
}

export function createRoom({ name, nicknames }) {
  const code = newCode()
  const now = Date.now()
  db.prepare('INSERT INTO rooms (code,name,dealer,horse_count,unit_price,created_at) VALUES (?,?,?,?,?,?)')
    .run(code, (name || '麻将牌局').trim().slice(0, 30), 'E', 4, 1, now)
  const ins = db.prepare('INSERT INTO players (room_code,seat,nickname,joined_at) VALUES (?,?,?,?)')
  SEATS.forEach((s, i) => {
    const n = (nicknames?.[i] || '').trim() || ({ E: '东家', S: '南家', W: '西家', N: '北家' })[s]
    ins.run(code, s, n.slice(0, 12), now)
  })
  return code
}

export function roomExists(code) {
  return !!db.prepare('SELECT 1 FROM rooms WHERE code=?').get(code)
}

export function getRoomMeta(code) {
  const r = db.prepare('SELECT * FROM rooms WHERE code=?').get(code)
  if (!r) return null
  const players = {}
  for (const p of db.prepare('SELECT seat,nickname FROM players WHERE room_code=?').all(code)) {
    players[p.seat] = { seat: p.seat, nickname: p.nickname }
  }
  return {
    code: r.code,
    name: r.name,
    dealer: r.dealer,
    horseCount: r.horse_count, // 遗留兼容列，规则真相源是 rules.ts 的 horse.countByGhost（随有无鬼 4/6）
    unitPrice: r.unit_price,
    createdAt: r.created_at,
    players,
  }
}

export function setPlayerName(code, seat, nickname) {
  if (!SEATS.includes(seat)) throw new Error('无效座位')
  const n = String(nickname || '').trim().slice(0, 12)
  if (!n) throw new Error('昵称不能为空')
  db.prepare('UPDATE players SET nickname=? WHERE room_code=? AND seat=?').run(n, code, seat)
}

export function setDealer(code, dealer) {
  if (!SEATS.includes(dealer)) throw new Error('无效庄家')
  db.prepare('UPDATE rooms SET dealer=? WHERE code=?').run(dealer, code)
}

function nextRoundNo(code) {
  const rows = db.prepare("SELECT type,ref_event_id FROM events WHERE room_code=? ORDER BY id").all(code)
  const voided = new Set(rows.filter((r) => r.type === 'void').map((r) => r.ref_event_id))
  const n = rows.filter((r) => r.type === 'score' && !voided.has(r.id)).length
  return n + 1
}

/** 追加一条记分事件（payload 必须含 net 四家净分）；同一事务内按「赢家坐庄」轮转庄家 */
export function appendScore(code, { payload, author }) {
  const roundNo = nextRoundNo(code)
  db.exec('BEGIN IMMEDIATE')
  try {
    const info = db.prepare(
      'INSERT INTO events (room_code,round_no,type,payload,author,ref_event_id,created_at) VALUES (?,?,?,?,?,?,?)'
    ).run(code, roundNo, 'score', JSON.stringify(payload), author || '', null, Date.now())
    const winner = payload?.input?.winner
    if (winner && SEATS.includes(winner)) {
      db.prepare('UPDATE rooms SET dealer=? WHERE code=?').run(winner, code)
    }
    db.exec('COMMIT')
    return Number(info.lastInsertRowid)
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

export function correctEvent(code, eventId, net, author) {
  const target = db.prepare("SELECT id FROM events WHERE id=? AND room_code=? AND type='score'").get(eventId, code)
  if (!target) throw new Error('目标记录不存在')
  const clean = {}
  for (const s of SEATS) {
    const v = Number(net?.[s])
    if (!Number.isFinite(v)) throw new Error('四家分数必须是数字')
    clean[s] = v
  }
  db.prepare(
    'INSERT INTO events (room_code,round_no,type,payload,author,ref_event_id,created_at) VALUES (?,?,?,?,?,?,?)'
  ).run(code, 0, 'correct', JSON.stringify({ net: clean }), author || '', eventId, Date.now())
}

/** 最后一个未作废记分局的赢家；没有则返回 fallback（作废局的庄家 / 现值） */
function dealerOfLastSurvivingRound(code, fallback) {
  const rows = db.prepare("SELECT id,type,payload,ref_event_id FROM events WHERE room_code=? ORDER BY id DESC").all(code)
  const voided = new Set(rows.filter((r) => r.type === 'void').map((r) => r.ref_event_id))
  for (const r of rows) {
    if (r.type !== 'score' || voided.has(r.id)) continue
    try {
      const w = JSON.parse(r.payload)?.input?.winner
      if (w && SEATS.includes(w)) return w
    } catch { /* payload 损坏则跳过 */ }
  }
  return fallback
}

export function voidEvent(code, eventId, author) {
  const target = db.prepare("SELECT id,payload FROM events WHERE id=? AND room_code=? AND type='score'").get(eventId, code)
  if (!target) throw new Error('目标记录不存在')
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(
      'INSERT INTO events (room_code,round_no,type,payload,author,ref_event_id,created_at) VALUES (?,?,?,?,?,?,?)'
    ).run(code, 0, 'void', JSON.stringify({}), author || '', eventId, Date.now())
    // 赢家坐庄回滚：作废后庄家 = 剩余最后一局的赢家；全部作废则退回该局开打前的庄家
    let fallback = null
    try {
      const d = JSON.parse(target.payload)?.input?.dealer
      if (d && SEATS.includes(d)) fallback = d
    } catch { /* 忽略 */ }
    if (!fallback) fallback = db.prepare('SELECT dealer FROM rooms WHERE code=?').get(code)?.dealer || 'E'
    const dealer = dealerOfLastSurvivingRound(code, fallback)
    db.prepare('UPDATE rooms SET dealer=? WHERE code=?').run(dealer, code)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

/** 重放所有事件，得出当前净分、有效记录、结算与统计 */
export function computeState(code) {
  const rows = db.prepare('SELECT * FROM events WHERE room_code=? ORDER BY id ASC').all(code)
  const voided = new Set()
  const corrections = new Map()
  for (const r of rows) {
    if (r.type === 'void') voided.add(r.ref_event_id)
    if (r.type === 'correct') corrections.set(r.ref_event_id, JSON.parse(r.payload).net)
  }

  const net = zero()
  const events = []
  for (const r of rows) {
    if (r.type === 'void' || r.type === 'correct') continue
    let payload
    try { payload = JSON.parse(r.payload) } catch { payload = {} }
    const n = corrections.has(r.id) ? corrections.get(r.id) : (payload.net || zero())
    const isVoided = voided.has(r.id)
    if (!isVoided) for (const s of SEATS) net[s] += Number(n[s]) || 0
    events.push({
      id: r.id,
      type: r.type,
      roundNo: r.round_no,
      author: r.author,
      createdAt: r.created_at,
      payload,
      net: n,
      isCorrected: corrections.has(r.id),
      isVoided,
    })
  }
  events.reverse()

  // 统计
  const active = events.filter((e) => !e.isVoided && e.type === 'score').slice().reverse()
  const wins = zero()
  for (const e of active) {
    const w = e.payload?.input?.winner
    if (w && w in wins) wins[w] += 1
  }
  const cum = zero()
  const trend = []
  for (const e of active) {
    for (const s of SEATS) cum[s] += Number(e.net[s]) || 0
    trend.push({ round: e.roundNo, E: cum.E, S: cum.S, W: cum.W, N: cum.N })
  }
  const ranking = SEATS.slice().sort((a, b) => net[b] - net[a])
  const stats = {
    rounds: active.length,
    wins,
    winRate: Object.fromEntries(SEATS.map((s) => [s, active.length ? +(wins[s] / active.length * 100).toFixed(1) : 0])),
    ranking,
    trend,
  }

  return {
    net,
    events,
    stats,
    settlement: minTransfers(net, RULES),
  }
}

export function fullState(code) {
  const meta = getRoomMeta(code)
  if (!meta) return null
  return { ...meta, ...computeState(code) }
}
