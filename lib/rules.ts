/**
 * 广东麻将计分规则配置（外置）
 * 来源：用户提供的规则图 + 口头确认
 * 改规则只改本文件，不动 score.ts。
 *
 * 关键口径（v1.5：摸马只认赢家自己的马）：
 * - 底分 = 2 分。鸡胡有鬼 = 1 倍底分 = 2 分，即「鸡胡就是底分 2」
 * - 表格各档 = 底分 × 倍数（1/2/4/6/8/10/12）；硬胡(无鬼) = 有鬼 ×2
 * - 无点炮：所有胡牌都是自摸（或抢杠胡），三家各付 1 份，赢家收 3 份
 * - 用户直接报胡法档位，系统不识别牌型、不判定叠加
 * - 摸马（非买马）：胡牌后按有无鬼摸固定张数 —— 有鬼摸 4 张、没鬼（硬胡）摸 6 张；
 *   马牌按牌面映射到座位（庄家 = 1/5/9/东本位）；
 *   v1.5 结算：只认赢家自己的马，N 张 → 胡分 ×N（1 张 = ×1 不翻，0 张 = 原分），
 *   其他座位的马一律不计、不产生任何收付
 * - 杠分立即结算：「N 倍底分」按底分 2 计 → 点杠 6 / 补杠各 2 / 暗杠各 4
 */

export type Seat = 'E' | 'S' | 'W' | 'N' // 东 / 南 / 西 / 北
export const SEATS: Seat[] = ['E', 'S', 'W', 'N']
export type HorseOffset = 0 | 1 | 2 | 3 // 相对庄家：本家 / 下家 / 对家 / 上家

export interface ScoreTierDef {
  patterns: string[] // 该档位所有可报名称
  times: number // 相对底分的倍数
}

export interface ScoreTier extends ScoreTierDef {
  withGhost: number // 有鬼 = times × 底分
  withoutGhost: number // 无鬼 = 硬胡（再 ×2）
}

export interface RuleConfig {
  scoreTable: ScoreTier[]
  baseUnit: number // 底分 = 2 分
  hardMultiplier: number // 硬胡(无鬼) 倍数 = 2
  horse: {
    countByGhost: { withGhost: number; withoutGhost: number } // 摸马张数：有鬼 4 / 没鬼 6
    mapping: Record<string, HorseOffset>
  }
  share: { zimoPerLoser: number }
  gang: {
    dianGang: number // 点杠：收放杠者几倍底分
    buGang: number // 补杠：收其他玩家各几倍底分
    anGang: number // 暗杠：收其他玩家各几倍底分
  }
  unitPrice: number // 1 分 = ? 元（默认 1，可在房间改）
  allowDianpao: boolean // 本桌不启用点炮
}

/** 单一真相源：底分 2、硬胡 ×2。改这两处，整张表与杠分同步变化。 */
const BASE_UNIT = 2
const HARD_MULTIPLIER = 2

const TIER_DEFS: ScoreTierDef[] = [
  { patterns: ['鸡胡'], times: 1 },
  { patterns: ['碰碰胡', '混一色', '抢杠胡', '杠上开花', '海底捞月'], times: 2 },
  { patterns: ['七对', '清一色'], times: 4 },
  { patterns: ['豪华七对', '混幺九'], times: 6 },
  { patterns: ['双豪华七对', '小四喜', '小三元'], times: 8 },
  { patterns: ['三豪华七对', '地胡', '天胡', '清幺九', '字一色'], times: 10 },
  { patterns: ['十八罗汉', '九宝莲灯', '大四喜', '大三元', '十三幺'], times: 12 },
]

function buildTable(defs: ScoreTierDef[]): ScoreTier[] {
  return defs.map((d) => ({
    ...d,
    withGhost: d.times * BASE_UNIT,
    withoutGhost: d.times * BASE_UNIT * HARD_MULTIPLIER,
  }))
}

/** 万/条/筒 1-9 → 相对庄家偏移 */
const NUMBER_OFFSET: Record<number, HorseOffset> = {
  1: 0, 2: 1, 3: 2, 4: 3,
  5: 0, 6: 1, 7: 2, 8: 3,
  9: 0,
}

/** 字牌 → 相对庄家偏移（东风本家、南风/红中下家、西风/发财对家、北风/白板上家） */
const HONOR_OFFSET: Record<string, HorseOffset> = {
  东: 0, 东风: 0,
  南: 1, 南风: 1, 中: 1, 红中: 1,
  西: 2, 西风: 2, 发: 2, 发财: 2,
  北: 3, 北风: 3, 白: 3, 白板: 3,
}

function buildHorseMapping(): Record<string, HorseOffset> {
  const m: Record<string, HorseOffset> = {}
  for (const suit of ['万', '条', '筒']) {
    for (let n = 1; n <= 9; n++) {
      m[`${n}${suit}`] = NUMBER_OFFSET[n]
    }
  }
  return { ...m, ...HONOR_OFFSET }
}

export const RULES: RuleConfig = {
  scoreTable: buildTable(TIER_DEFS),
  baseUnit: BASE_UNIT,
  hardMultiplier: HARD_MULTIPLIER,
  horse: {
    countByGhost: { withGhost: 4, withoutGhost: 6 },
    mapping: buildHorseMapping(),
  },
  share: { zimoPerLoser: 1 },
  gang: { dianGang: 3, buGang: 1, anGang: 2 },
  unitPrice: 1,
  allowDianpao: false,
}

/** 本局该摸几张马：有鬼 4 张、没鬼（硬胡）6 张。全链路唯一口径。 */
export function horseCountFor(hasGhost: boolean, rules: RuleConfig = RULES): number {
  return hasGhost ? rules.horse.countByGhost.withGhost : rules.horse.countByGhost.withoutGhost
}

/**
 * v1.5 摸马结算口径（固定约定，不进配置）：
 * 赢家自己的马 N 张 → 胡分 ×N；1 张 = ×1 不翻，0 张 = 原分。
 * 其他座位的马一律不计。
 */
export function selfHorseTimes(ownCount: number): number {
  return Math.max(1, ownCount)
}

/** 牌面 → 相对庄家偏移；无法识别返回 null */
export function horseOffsetOf(tile: string, rules: RuleConfig = RULES): HorseOffset | null {
  const t = tile.trim()
  if (t in rules.horse.mapping) return rules.horse.mapping[t]
  const m = /^([1-9])/.exec(t)
  if (m) return NUMBER_OFFSET[Number(m[1])]
  return null
}

/** 相对庄家偏移 → 绝对座位（东南西北逆时针） */
export function seatFromOffset(offset: HorseOffset, dealer: Seat): Seat {
  return SEATS[(SEATS.indexOf(dealer) + offset) % 4]
}
