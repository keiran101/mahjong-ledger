/**
 * 规则算例验证：node --experimental-strip-types scripts/verify.ts
 * 每个算例打印四家净分、马命中、结算转账，并断言「零和」不变量。
 */
import assert from 'node:assert/strict'
import { RULES, SEATS, horseCountFor, type Seat } from '../lib/rules.ts'
import { scoreRound, type RoundInput } from '../lib/score.ts'
import { minTransfers, assertBalanced } from '../lib/settle.ts'

const NAME: Record<Seat, string> = { E: '东', S: '南', W: '西', N: '北' }

function show(title: string, input: RoundInput, rules: typeof RULES = RULES) {
  const d = scoreRound(input, rules)
  const row = SEATS.map((s) => `${NAME[s]} ${d.perPlayer[s] > 0 ? '+' : ''}${d.perPlayer[s]}`).join('  ')
  const hits = d.horseHits.length
    ? d.horseHits.map((h) => `${h.tile}→${NAME[h.seat]}${h.winnerSelf ? '(本人,计翻倍)' : '(不计)'}`).join(' ')
    : '无'
  const transfers = minTransfers(d.perPlayer, RULES)
  assertBalanced(d.perPlayer, transfers)

  console.log(`\n【${title}】`)
  console.log(`  胡法=${d.tierName} ${d.hasGhost ? '有鬼' : '硬胡(无鬼)'}  基数=${d.base}分  每家付=${d.zimoPerLoser}分  马倍=${d.selfHorseTimes}(${d.horseMode})`)
  console.log(`  马: ${hits}`)
  if (d.horseLines.length) console.log(`  马分: ${d.horseLines.join('; ')}`)
  if (d.gangLines.length) console.log(`  杠: ${d.gangLines.join('; ')}`)
  if (d.ghostLines.length) console.log(`  打鬼: ${d.ghostLines.join('; ')}`)
  console.log(`  四家净分: ${row}`)
  console.log(`  零和校验: ${d.totalCheck}  ${d.totalCheck === 0 ? 'OK' : 'FAIL'}`)
  console.log(`  结算: ${transfers.map((t) => `${NAME[t.from]}→${NAME[t.to]} ${t.points}分/${t.amount}元`).join('  ') || '无需转账'}`)

  assert.equal(d.totalCheck, 0, `${title} 账不平`)
  return d
}

// 例 1：鸡胡、有鬼、无马、庄家=赢家=东 → base 2，三家各付 2
show('例1 鸡胡有鬼·无马', {
  winner: 'E', dealer: 'E', pattern: '鸡胡', hasGhost: true, horses: [],
})

// 例 2：鸡胡有鬼 + 4 张马（庄家=东，赢家=东）→ 自己的马 2 张 → 胡分 ×3（v1.8 additive）
// 5万→东(本人,计翻倍) 红中→南(不计) 西风→西(不计) 9筒→东(本人,计翻倍)
// base 2 × (1+2) = 每家付 6，赢家收 18；其他家的马不产生任何收付
const d2 = show('例2 鸡胡有鬼·自己的马2张→×3', {
  winner: 'E', dealer: 'E', pattern: '鸡胡', hasGhost: true,
  horses: ['5万', '红中', '西风', '9筒'],
})
assert.equal(d2.ownHorseCount, 2)
assert.equal(d2.selfHorseTimes, 3)
assert.equal(d2.zimoPerLoser, 6)
assert.equal(d2.perPlayer.E, 18)
assert.equal(d2.perPlayer.S, -6)
assert.equal(d2.perPlayer.W, -6)

// 例 3：清一色、硬胡、无马 → base 16，赢家收 48
show('例3 清一色硬胡·无马', {
  winner: 'S', dealer: 'E', pattern: '清一色', hasGhost: false, horses: [],
})

// 例 4：七对有鬼 + 赢家自己暗杠
// 底分 2 → 暗杠「2 倍底分」= 其余三家各付 4 分（v1.2 前误按各 2 分）
show('例4 七对有鬼·带暗杠', {
  winner: 'W', dealer: 'E', pattern: '七对', hasGhost: true, horses: [],
  gangEvents: [{ type: 'an', by: 'W' }],
})

// 例 5：庄家不是东时马牌映射（庄家=南，6条→下家=西，红中→下家=西）
// 两张马都映射到西（非赢家）→ 一律不计，净分与无马完全相同（v1.5）
const d5 = show('例5 庄家=南·马映射·他家马不计', {
  winner: 'N', dealer: 'S', pattern: '碰碰胡', hasGhost: true,
  horses: ['6条', '红中'],
})
const d5plain = show('例5b 同局无马对照', {
  winner: 'N', dealer: 'S', pattern: '碰碰胡', hasGhost: true, horses: [],
})
assert.deepEqual(d5.perPlayer, d5plain.perPlayer, '他家马不得影响净分')
assert.equal(d5.selfHorseTimes, 1)

// 例 6：确认页手改兜底
const d6 = show('例6 手改覆盖', {
  winner: 'E', dealer: 'E', pattern: '鸡胡', hasGhost: true, horses: [],
  manualOverride: { E: 6, S: -2, W: -3, N: -1 },
})
assert.equal(d6.isManual, true)

// 例 7：非法胡法必须报错（用户只报表内档位）
assert.throws(() => scoreRound({
  winner: 'E', dealer: 'E', pattern: '不存在的牌型', hasGhost: true, horses: [],
}), /未知胡法/)

// 例 8：底分 = 2，鸡胡 = 1 倍底分 = 2 分（用户口径「鸡胡就是底分 2」）
assert.equal(RULES.baseUnit, 2)
assert.equal(RULES.hardMultiplier, 2)
assert.equal(RULES.scoreTable[0].times, 1)
assert.equal(RULES.scoreTable[0].withGhost, 2)
assert.equal(RULES.scoreTable[0].withoutGhost, 4)

// 例 9：表格数值回归（倍率生成后仍须与规则图完全一致）
assert.deepEqual(
  RULES.scoreTable.map((t) => [t.withGhost, t.withoutGhost]),
  [[2, 4], [4, 8], [8, 16], [12, 24], [16, 32], [20, 40], [24, 48]],
)

// 例 10：杠分按「底分 2」计 —— 点杠 6 / 补杠各 2 / 暗杠各 4
// 用「同一局有无杠分」的差值做精确断言，排除胡牌主分干扰
const baseInput: RoundInput = {
  winner: 'E', dealer: 'E', pattern: '鸡胡', hasGhost: true, horses: [],
}
const plain = scoreRound(baseInput)
const dian = scoreRound({ ...baseInput, gangEvents: [{ type: 'dian', by: 'E', from: 'S' }] })
const bu = scoreRound({ ...baseInput, gangEvents: [{ type: 'bu', by: 'E' }] })
const an = scoreRound({ ...baseInput, gangEvents: [{ type: 'an', by: 'E' }] })

assert.equal(dian.autoPerPlayer.S - plain.autoPerPlayer.S, -6, '点杠 3 倍底分 = 6 分')
assert.equal(dian.autoPerPlayer.E - plain.autoPerPlayer.E, 6)
for (const s of SEATS.filter((x) => x !== 'E')) {
  assert.equal(bu.autoPerPlayer[s] - plain.autoPerPlayer[s], -2, '补杠每家 1 倍底分 = 2 分')
  assert.equal(an.autoPerPlayer[s] - plain.autoPerPlayer[s], -4, '暗杠每家 2 倍底分 = 4 分')
}
assert.equal(bu.autoPerPlayer.E - plain.autoPerPlayer.E, 6)
assert.equal(an.autoPerPlayer.E - plain.autoPerPlayer.E, 12)
console.log('\n【例10 杠分按底分2】点杠 放杠者付6分 / 补杠 其余三家各付2分 / 暗杠 其余三家各付4分  OK')

// 例 11：摸马张数随有无鬼变化（v1.4）
assert.equal(horseCountFor(true), 4, '有鬼摸 4 张马')
assert.equal(horseCountFor(false), 6, '没鬼/硬胡摸 6 张马')
assert.equal(RULES.horse.countByGhost.withGhost, 4)
assert.equal(RULES.horse.countByGhost.withoutGhost, 6)
console.log('\n【例11 摸马张数】有鬼 4 张 / 没鬼(硬胡) 6 张  OK')

// 例 12：有鬼局摸 4 张马（庄家=东，赢家=东）
// 5万→东(本人) 红中→南 西风→西 9筒→东(本人)：自己的马 2 张 → ×3（v1.8 additive），与他家马无关
const d12 = show('例12 鸡胡有鬼·摸满4张马', {
  winner: 'E', dealer: 'E', pattern: '鸡胡', hasGhost: true,
  horses: ['5万', '红中', '西风', '9筒'],
})
assert.equal(d12.horseCount, 4)
assert.equal(d12.horseHits.length, 4)
assert.equal(d12.ownHorseCount, 2)
assert.equal(d12.selfHorseTimes, 3)
assert.equal(d12.perPlayer.E, 18)

// 例 13：硬胡局摸 6 张马 —— 张数上限生效；自己的马 2 张 → ×3（v1.8 additive）
// 庄家=南：本家=南(1万) 下家=西(2万/6条) 对家=北(3万/7条) 上家=东(4万)
// 赢家=北 → 自己的马 = 3万、7条 共 2 张 → 胡分 ×3；其余马不计
const d13 = show('例13 清一色硬胡·摸满6张马·自己的马2张×3', {
  winner: 'N', dealer: 'S', pattern: '清一色', hasGhost: false,
  horses: ['1万', '2万', '3万', '4万', '6条', '7条'],
})
assert.equal(d13.horseCount, 6)
assert.equal(d13.horseHits.length, 6)
assert.equal(d13.ownHorseCount, 2)
assert.equal(d13.selfHorseTimes, 3)
assert.equal(d13.zimoPerLoser, 48, '清一色硬胡 16 × 3')
assert.equal(d13.totalCheck, 0)

// 例 14：超张数必须被机械拦截（有鬼 >4、硬胡 >6）
assert.throws(() => scoreRound({
  winner: 'E', dealer: 'E', pattern: '鸡胡', hasGhost: true,
  horses: ['1万', '2万', '3万', '4万', '5万'],
}), /最多摸 4 张马/)
assert.throws(() => scoreRound({
  winner: 'E', dealer: 'E', pattern: '鸡胡', hasGhost: false,
  horses: ['1万', '2万', '3万', '4万', '5万', '6万', '7万'],
}), /最多摸 6 张马/)
// 硬胡恰好 6 张合法（不抛错）
assert.doesNotThrow(() => scoreRound({
  winner: 'E', dealer: 'E', pattern: '鸡胡', hasGhost: false,
  horses: ['1万', '2万', '3万', '4万', '5万', '6万'],
}))
console.log('【例14 超张数拦截】有鬼>4 / 硬胡>6 均报错，硬胡恰好6张合法  OK')

// 例 15：自己的马 1 张 → ×2（v1.8 additive：每张自马加 1 个底分，1 张也翻）
// 庄家=南，赢家=北：3万→对家=北（唯一自己的马），其余不计
const d15 = show('例15 清一色硬胡·自己的马1张×2', {
  winner: 'N', dealer: 'S', pattern: '清一色', hasGhost: false,
  horses: ['3万', '1万', '2万'],
})
assert.equal(d15.ownHorseCount, 1)
assert.equal(d15.selfHorseTimes, 2)
assert.equal(d15.zimoPerLoser, 32, '清一色硬胡 16 × 2')
const d15plain = scoreRound({
  winner: 'N', dealer: 'S', pattern: '清一色', hasGhost: false, horses: [],
})
assert.equal(d15.perPlayer.N - d15plain.perPlayer.N, 48, '1 张自马比无马多收 48（每家 16×2×3 家）')

// 例 16：自己的马 4 张 → ×5（v1.8 additive 上限算例）
// 庄家=东，赢家=东：5万/9万/5条/东风 全部映射到东
const d16 = show('例16 鸡胡有鬼·自己的马4张×5', {
  winner: 'E', dealer: 'E', pattern: '鸡胡', hasGhost: true,
  horses: ['5万', '9万', '5条', '东风'],
})
assert.equal(d16.ownHorseCount, 4)
assert.equal(d16.selfHorseTimes, 5)
assert.equal(d16.zimoPerLoser, 10, '鸡胡有鬼 2 × 5')
assert.equal(d16.perPlayer.E, 30)
for (const s of SEATS.filter((x) => x !== 'E')) assert.equal(d16.perPlayer[s], -10)

// ───── v1.8 算术开关对照（同一组自马输入 × 三种模式）─────
// 输入统一：清一色有鬼（base=8/家），庄家=东 赢家=东，自马 2 张（5万、5条）
const modeInput: RoundInput = {
  winner: 'E', dealer: 'E', pattern: '清一色', hasGhost: true,
  horses: ['5万', '5条'],
}

// 例 19：additive（默认）→ ×3 → 每家 24
const d19 = show('例19 additive×(1+N)·自马2张', modeInput)
assert.equal(d19.horseMode, 'additive')
assert.equal(d19.selfHorseTimes, 3)
assert.equal(d19.zimoPerLoser, 24)
assert.equal(d19.horseLines.length, 0, 'additive 模式无独立马分流水')

// 例 20：geometric → ×4 → 每家 32
const RULES_GEO = { ...RULES, horse: { ...RULES.horse, timesMode: 'geometric' as const } }
const d20 = show('例20 geometric×2ⁿ·自马2张', modeInput, RULES_GEO)
assert.equal(d20.horseMode, 'geometric')
assert.equal(d20.selfHorseTimes, 4)
assert.equal(d20.zimoPerLoser, 32)
assert.equal(d20.horseLines.length, 0)

// 例 21：flat → 胡分不乘马倍（8/家）+ 每张自马其余三家各付 2 分 → 每家 8+4=12
const RULES_FLAT = { ...RULES, horse: { ...RULES.horse, timesMode: 'flat' as const } }
const d21 = show('例21 flat独立马分·自马2张', modeInput, RULES_FLAT)
assert.equal(d21.horseMode, 'flat')
assert.equal(d21.selfHorseTimes, 1, 'flat 模式胡分不乘马倍')
assert.equal(d21.zimoPerLoser, 8)
assert.equal(d21.horseLines.length, 2)
assert.equal(d21.perPlayer.E, 36, '24 胡分 + 2×6 马分')
for (const s of SEATS.filter((x) => x !== 'E')) assert.equal(d21.perPlayer[s], -12)
console.log('\n【例19-21 算术开关】additive 24 / geometric 32 / flat 12（同为清一色+自马2张）  OK')

// 例 22：flat 模式 1 张自马也有效（对照：无马）
const d22 = show('例22 flat·自马1张', {
  winner: 'E', dealer: 'E', pattern: '鸡胡', hasGhost: true,
  horses: ['5万'],
}, RULES_FLAT)
assert.equal(d22.horseLines.length, 1)
assert.equal(d22.perPlayer.E, 12, '6 胡分 + 6 马分')
for (const s of SEATS.filter((x) => x !== 'E')) assert.equal(d22.perPlayer[s], -4)

// 例 17：打鬼罚分（v1.7）—— 南家打鬼，罚给其余每家各 1 分（共 3 分）
// 鸡胡有鬼 base=2：赢家东收 6；南再付打鬼 3（每家 1）→ 东 +7、南 -5、西/北 各 -1
const d17 = show('例17 鸡胡有鬼·南家打鬼一次', {
  winner: 'E', dealer: 'E', pattern: '鸡胡', hasGhost: true,
  horses: [],
  ghostEvents: [{ by: 'S' }],
})
assert.equal(d17.ghostLines.length, 1)
assert.equal(d17.perPlayer.E, 7)
assert.equal(d17.perPlayer.S, -5)
assert.equal(d17.perPlayer.W, -1)
assert.equal(d17.perPlayer.N, -1)
assert.equal(d17.totalCheck, 0)

// 例 18：一局两次打鬼 + 杠分叠加 —— 打鬼者不同，逐次独立结算
// 鸡胡有鬼 base=2；胡分 E+6 S/W/N -2；打鬼①西：西-3 E/S/N各+1；打鬼②北：北-3 E/S/W各+1；暗杠东：其余三家各付4
// E: 6+1+1+12 = 20；S: -2+1+1-4 = -4；W: -2-3+1-4 = -8；N: -2+1-3-4 = -8
const d18 = show('例18 鸡胡有鬼·两次打鬼+暗杠', {
  winner: 'E', dealer: 'E', pattern: '鸡胡', hasGhost: true,
  horses: [],
  ghostEvents: [{ by: 'W' }, { by: 'N' }],
  gangEvents: [{ type: 'an', by: 'E' }],
})
assert.equal(d18.ghostLines.length, 2)
assert.deepEqual(d18.perPlayer, { E: 20, S: -4, W: -8, N: -8 })
assert.equal(d18.totalCheck, 0)

console.log('\n全部算例通过：零和、马映射/张数/自马三算术开关、杠分、打鬼罚分、手改、非法输入、底分与表值回归均 OK')
