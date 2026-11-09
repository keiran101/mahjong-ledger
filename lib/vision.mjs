/**
 * 拍照认牌：图片 → 规范化牌面草稿。
 *
 * 铁律：本模块绝不调用 scoreRound、不产出四家净分。
 * VLM 只读牌；张数、横竖、杠型、鬼牌、特殊胡、牌型全部标成待确认项。
 */
import { horseCountFor, SEATS } from './rules.ts'
import { detectPattern } from './pattern.ts'
import {
  normalizeTileName, relFromRotatedIndex, seatFromRel, TILES_34,
} from './tiles.ts'
import { chatVision, getVlmConfig } from './vlm.mjs'

const SN = { E: '东', S: '南', W: '西', N: '北' }
const REL_LABEL = { shang: '上家', dui: '对家', xia: '下家' }

const CONFIRM_REASONS = [
  '相同牌张数（三个一万还是四个）视觉模型容易数错',
  '横牌位置决定点杠来自上家/对家/下家，空间关系不稳定',
  '点杠 / 补杠 / 暗杠在照片里经常长得像',
  '马区、副露、手牌可能被划错行',
  '鬼牌在图上就是一张普通牌，模型不知道本局鬼是哪张',
  '天胡 / 地胡 / 杠上开花 / 海底捞月 / 抢杠胡牌面上没有',
  '胡法由确认后的牌面判定，仍需人眼核对',
]

export function extractJson(content) {
  let t = String(content).trim()
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t)
  if (fence) t = fence[1].trim()
  const a = t.indexOf('{')
  const b = t.lastIndexOf('}')
  if (a < 0 || b <= a) throw new Error('识别结果里没有 JSON 对象，请重拍一张更清楚的照片')
  try { return JSON.parse(t.slice(a, b + 1)) } catch { throw new Error('识别结果 JSON 无法解析，请重拍') }
}

function asTileList(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const it of raw) {
    if (it && typeof it === 'object') {
      const n = normalizeTileName(it.tile ?? it.name ?? it.face)
      if (n) out.push({ tile: n, orient: it.orient === 'heng' || it.rotated || it.horizontal ? 'heng' : 'shu' })
    } else {
      const n = normalizeTileName(it)
      if (n) out.push({ tile: n, orient: 'shu' })
    }
  }
  return out
}

function guessGangKind(tiles, stacked, rawKind) {
  const k = String(rawKind || '').toLowerCase()
  if (k === 'bu' || k === '补杠' || k === '加杠') return 'bu'
  if (k === 'an' || k === '暗杠') return 'an'
  if (k === 'dian' || k === '点杠' || k === '明杠') return 'dian'
  if (k === 'peng' || k === '碰') return 'peng'
  if (stacked) return 'bu'
  const hasHeng = tiles.some((t) => t.orient === 'heng')
  if (tiles.length >= 4 && !hasHeng) return 'an'
  if (tiles.length >= 4 && hasHeng) return 'dian'
  return 'peng'
}

function fromOfMeld(tiles, winner) {
  const idx = tiles.findIndex((t) => t.orient === 'heng')
  if (idx < 0) return { rel: null, from: null, rotatedIndex: null }
  const rel = relFromRotatedIndex(idx, tiles.length)
  const from = rel && winner ? seatFromRel(rel, winner) : null
  return { rel, from, rotatedIndex: idx }
}

/**
 * 把 VLM 原始 JSON 收成可编辑草稿。不算分。
 * ctx: { dealer, photographer, players }
 */
export function buildDraft(raw, ctx = {}) {
  const photographer = SEATS.includes(ctx.photographer) ? ctx.photographer : null
  const winnerRaw = String(raw?.winnerGuess || raw?.winner || '').toUpperCase()
  const winner = SEATS.includes(winnerRaw) ? winnerRaw : photographer

  const handObjs = asTileList(raw?.hand)
  const hand = handObjs.map((t) => t.tile)

  const melds = []
  const meldSrc = Array.isArray(raw?.melds) ? raw.melds : []
  for (const m of meldSrc) {
    const tiles = asTileList(m?.tiles || m)
    if (tiles.length < 3) continue
    const kind = guessGangKind(tiles, !!m?.stacked, m?.gangGuess || m?.kind || m?.type)
    const { rel, from, rotatedIndex } = fromOfMeld(tiles, winner)
    melds.push({
      kind,
      tiles: tiles.map((t) => t.tile),
      orients: tiles.map((t) => t.orient),
      stacked: !!m?.stacked,
      rel,
      from: kind === 'dian' ? from : null,
      rotatedIndex,
    })
  }

  const horses = asTileList(raw?.horses).map((t) => t.tile)
  const ghostTile = normalizeTileName(raw?.ghostTile) 
  const specialRaw = String(raw?.special || 'none').toLowerCase()
  const specialMap = {
    none: 'none', 无: 'none', 普通: 'none', 自摸: 'none',
    qianggang: 'qianggang', 抢杠: 'qianggang', 抢杠胡: 'qianggang',
    gangkai: 'gangkai', 杠上开花: 'gangkai', 杠开: 'gangkai',
    haidi: 'haidi', 海底: 'haidi', 海底捞月: 'haidi',
    tian: 'tian', 天胡: 'tian',
    di: 'di', 地胡: 'di',
  }
  const special = specialMap[specialRaw] || 'none'

  const uncertain = Array.isArray(raw?.uncertain)
    ? raw.uncertain.map((x) => String(x).slice(0, 80)).filter(Boolean)
    : []

  const description = String(raw?.description || '').trim().slice(0, 800)

  const warnings = [...uncertain]
  const counts = new Map()
  for (const t of [...hand, ...melds.flatMap((m) => m.tiles), ...horses]) {
    counts.set(t, (counts.get(t) || 0) + 1)
  }
  for (const [t, n] of counts) {
    if (n > 4) warnings.push(`「${t}」一共出现了 ${n} 张（一副牌最多 4 张），请核对`)
  }

  const expectedHand = 14 - 3 * melds.length
  if (hand.length && expectedHand > 0 && hand.length !== expectedHand) {
    warnings.push(`按 ${melds.length} 组副露，手牌应为 ${expectedHand} 张，识别到 ${hand.length} 张`)
  }

  const hasGhostInHand = !!(ghostTile && hand.includes(ghostTile))
  let hasGhost = true
  if (ghostTile) hasGhost = hasGhostInHand
  else if (typeof raw?.hasGhost === 'boolean') hasGhost = raw.hasGhost

  const maxHorses = horseCountFor(hasGhost)
  if (horses.length > maxHorses) {
    warnings.push(`本局最多摸 ${maxHorses} 张马，识别到 ${horses.length} 张，请删到上限以内`)
  }

  const gangEvents = []
  if (winner) {
    for (const m of melds) {
      if (m.kind === 'peng') continue
      const g = { type: m.kind, by: winner }
      if (m.kind === 'dian') g.from = m.from || null
      gangEvents.push(g)
      if (m.kind === 'dian' && !m.from) warnings.push('有一组点杠没读出横牌位置，请选择放杠者')
    }
  }

  const detected = detectPattern({
    hand, melds, ghostTile, special,
  })
  const pattern = detected.pattern

  const notes = []
  if (description) notes.push(description)
  if (detected.complete) notes.push(`按当前牌面可判：${detected.candidates.join('、') || pattern}`)
  else notes.push('未能验证成胡，请务必手核胡法')

  return {
    winner,
    photographer,
    dealer: ctx.dealer || null,
    hand,
    melds,
    horses,
    ghostTile,
    hasGhost,
    special,
    pattern,
    patternCandidates: detected.candidates,
    patternComplete: detected.complete,
    gangEvents,
    description,
    notes,
    warnings,
    confirmReasons: CONFIRM_REASONS,
    tiles: TILES_34,
  }
}

function buildPrompt(ctx) {
  const seats = SEATS.map((s) => `${SN[s]}(${s})=${ctx.players?.[s]?.nickname || SN[s] + '家'}`).join('，')
  const who = ctx.photographer ? `${SN[ctx.photographer]}家（拍照人，默认赢家）` : '未知'
  return `你是广东麻将读牌助手。只描述照片里的牌，不要计算分数，不要猜测谁赢了多少分。

【拍照规范（赢家视角，镜头正对牌面）】
- 上排：马牌，全部竖摆
- 中排：副露，一组一组，组与组之间有空隙
- 下排：手牌，全部翻开、全部竖摆
- 点杠：四张一字排开，放杠那张横摆。横在最左=上家（镜头左手边），横在中间=对家，横在最右=下家（右手边）
- 暗杠：四张全竖，没有横牌
- 补杠：在原碰上把第 4 张叠在那张横牌上（stacked=true）
- 碰：三张，被碰的那张横摆，位置含义同上

【当前座位】${seats}
【拍照人】${who}
【庄家】${ctx.dealer ? SN[ctx.dealer] + '家' : '未知'}

先用中文写一段规范化描述（按「马 / 副露 / 手牌」从左到右逐张点名，并标明哪张是横的），然后输出一个 JSON 对象。
只输出这段描述和 JSON，JSON 前后不要 Markdown 代码块以外的解释。

JSON 结构：
{
  "description": "规范化中文描述",
  "winnerGuess": "E",
  "hand": [{"tile":"1万","orient":"shu"}],
  "melds": [
    {
      "kind": "dian",
      "stacked": false,
      "gangGuess": "dian",
      "tiles": [{"tile":"1万","orient":"shu"},{"tile":"1万","orient":"shu"},{"tile":"1万","orient":"shu"},{"tile":"1万","orient":"heng"}]
    }
  ],
  "horses": [{"tile":"6万","orient":"shu"}],
  "ghostTile": null,
  "special": "none",
  "uncertain": ["列出你没看清的地方"]
}

约束：
- tile 只能用：1-9万、1-9条、1-9筒、东风、南风、西风、北风、红中、发财、白板
- orient 只能是 shu（竖）或 heng（横）
- kind / gangGuess：peng / dian / bu / an
- winnerGuess 只能是 E/S/W/N，不确定就填拍照人座位
- ghostTile 图上看不出来就填 null
- special 图上看不出来就填 none
- 逐张列出，不要写「四个一万」这种概括
- 绝对不要输出分数或四家净分`
}

export async function recognizeHand(imageDataUrl, ctx = {}) {
  const cfg = getVlmConfig()
  if (!cfg.configured) throw new Error('尚未配置 Qwen3.7 拍照识别，请在「设置」里填入通义千问 API Key')
  const { text, model } = await chatVision({
    imageDataUrl,
    system: '你是广东麻将读牌助手。只认牌、只输出规范化描述和 JSON，绝不计算分数。',
    prompt: buildPrompt(ctx),
  })
  const raw = extractJson(text)
  const draft = buildDraft(raw, ctx)
  return { model, draft }
}
