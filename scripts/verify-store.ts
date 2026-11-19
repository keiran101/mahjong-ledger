/**
 * 账本层验证：赢家坐庄轮转 + 作废回滚 + 手选兜底
 * 运行：node --experimental-sqlite --experimental-strip-types scripts/verify-store.ts
 * 使用独立临时库（MJ_DB 指向 os.tmpdir），不碰真实 data/mahjong.db。
 */
import { join } from 'node:path'
import { tmpdir } from 'node:os'

process.env.MJ_DB = process.env.MJ_DB
  || join(tmpdir(), `mahjong-verify-store-${Date.now()}-${Math.floor(Math.random() * 1e6)}.db`)

const assert = (await import('node:assert/strict')).default
const { RULES, SEATS } = await import('../lib/rules.ts')
const store = await import('../lib/store.mjs')

type Seat = 'E' | 'S' | 'W' | 'N'

const label: Record<Seat, string> = { E: '东', S: '南', W: '西', N: '北' }
const net = (winner: Seat): Record<Seat, number> =>
  Object.fromEntries(SEATS.map((s) => [s, s === winner ? 6 : -2])) as Record<Seat, number>

function round(code: string, dealer: Seat, winner: Seat) {
  return {
    input: { winner, dealer, pattern: '鸡胡', hasGhost: true, horses: [], gangEvents: [] },
    detail: {},
    net: net(winner),
  }
}

function dealerOf(code: string): Seat {
  return store.fullState(code).dealer as Seat
}

const code = store.createRoom({ name: '赢家坐庄验证' })
assert.equal(dealerOf(code), 'E', '新房默认庄家东')

// 1. 手选庄：S（手选是兜底覆盖，随时可用）
store.setDealer(code, 'S')
assert.equal(dealerOf(code), 'S', '手选庄家生效')

// 2. 落账局1：赢家 W → 庄家自动变 W（赢家坐庄）
const id1 = store.appendScore(code, { payload: round(code, 'S', 'W'), author: '验证' })
assert.equal(dealerOf(code), 'W', '落账后庄家=该局赢家')

// 3. 落账局2：赢家 E → 庄家 E
const id2 = store.appendScore(code, { payload: round(code, 'W', 'E'), author: '验证' })
assert.equal(dealerOf(code), 'E', '第二局落账后庄家=第二局赢家')

// 4. 作废最后一局（局2）→ 庄家回滚到剩余最后一局（局1）的赢家 W
store.voidEvent(code, id2, '验证')
assert.equal(dealerOf(code), 'W', '作废后庄家=剩余最后一局的赢家')

// 5. 作废局1 → 无剩余局 → 退回局1开打前的庄家 S
store.voidEvent(code, id1, '验证')
assert.equal(dealerOf(code), 'S', '全部作废后庄家退回该局开打前')

// 6. correct（手改分数）不改变庄家
const id3 = store.appendScore(code, { payload: round(code, 'S', 'N'), author: '验证' })
assert.equal(dealerOf(code), 'N', '局3落账，赢家 N 坐庄')
store.correctEvent(code, id3, { E: 0, S: 0, W: 0, N: 0 }, '验证')
assert.equal(dealerOf(code), 'N', '手改分数不影响庄家')

// 7. 庄家永远是合法座位（机械不变量）
assert.ok(SEATS.includes(dealerOf(code)), '庄家必须是合法座位')
assert.equal(RULES.baseUnit, 2)

// 8. v1.9 炸胡：诈胡做庄 —— 炸胡局落账后庄家 = 炸胡者
const zhaHuRound = (code2: string, dealer: Seat, zhaHuSeat: Seat) => ({
  input: { kind: 'zhaHu', zhaHuSeat, dealer, pattern: '鸡胡', hasGhost: true, horses: [], gangEvents: [] },
  detail: {},
  net: Object.fromEntries(SEATS.map((s) => [s, s === zhaHuSeat ? -6 : 2])),
})
const id4 = store.appendScore(code, { payload: zhaHuRound(code, 'N', 'S'), author: '验证' })
assert.equal(dealerOf(code), 'S', '炸胡局落账后庄家=炸胡者（诈胡做庄）')

// 9. 作废炸胡局 → 庄家回滚到剩余最后一局（局3）的赢家 N
store.voidEvent(code, id4, '验证')
assert.equal(dealerOf(code), 'N', '作废炸胡局后庄家回滚到剩余最后一局的赢家')

// 10. 正常局之后炸胡，再作废正常局 → 庄家=炸胡局炸胡者
const id5 = store.appendScore(code, { payload: round(code, 'N', 'W'), author: '验证' })
assert.equal(dealerOf(code), 'W', '局4落账，赢家 W 坐庄')
const id6 = store.appendScore(code, { payload: zhaHuRound(code, 'W', 'E'), author: '验证' })
assert.equal(dealerOf(code), 'E', '局5炸胡，炸胡者 E 接庄')
store.voidEvent(code, id5, '验证')
assert.equal(dealerOf(code), 'E', '作废前面的正常局，庄家仍=最后一局炸胡者 E')

const tmpDb = process.env.MJ_DB as string
console.log('\n【账本验证】默认庄东 / 手选兜底 / 落账赢家坐庄 / 作废回滚 / 手改不动庄 / 炸胡做庄+回滚  全部通过')
// 临时库留在 os.tmpdir()（SQLite 连接仍持有句柄，Windows 下立即删除会 EBUSY）；系统会定期清理 %TEMP%
console.log(`临时库（可手动删）: ${tmpDb}`)
