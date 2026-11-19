/**
 * 计分引擎：纯函数，无 IO、无状态。
 * 输入「用户报的胡法档位 + 有无鬼 + 本局摸马牌面 + 杠分事件 + 打鬼事件」，输出四家净分与逐项明细。
 * 摸马张数由 horseCountFor(hasGhost) 决定（有鬼 4 / 没鬼 6），引擎只遍历数组、不假设张数。
 */
import {
  RULES, SEATS, horseCountFor, horseOffsetOf, seatFromOffset, selfHorseTimes,
  type RuleConfig, type Seat,
} from './rules.ts'

export type GangType = 'dian' | 'bu' | 'an'

export interface GangEvent {
  type: GangType
  by: Seat // 杠的人
  from?: Seat // 点杠时的放杠者
}

export interface GhostEvent {
  by: Seat // 打出鬼牌的人（v1.7：罚给其余每家各 ghost.penalty 分）
}

export interface RoundInput {
  winner: Seat
  dealer: Seat
  pattern: string // 用户报的胡法档位名（必须是 scoreTable 中的别名）
  hasGhost: boolean // true = 有鬼；false = 硬胡（无鬼）
  horses: string[] // 本局中马的马牌牌面，最多 = horseCountFor(hasGhost) 张
  gangEvents?: GangEvent[]
  ghostEvents?: GhostEvent[] // 本局打鬼事件（v1.7），一局可多次
  manualOverride?: Partial<Record<Seat, number>> // 确认页手改：直接给最终净分
}

export interface HorseHit {
  tile: string
  seat: Seat
  winnerSelf: boolean // 中马者=赢家本人 → 计入翻倍；其他座位的马不计
}

export interface ScoreDetail {
  tierName: string
  base: number // 该局胡法分数（查表原始值，未乘马倍）
  hasGhost: boolean
  horseCount: number // 本局摸马张数上限
  ownHorseCount: number // 赢家自己的马张数（v1.5）
  selfHorseTimes: number // 胡分倍数 = max(1, ownHorseCount)（v1.5）
  zimoPerLoser: number
  horseHits: HorseHit[]
  gangLines: string[]
  ghostLines: string[] // 打鬼罚分流水（v1.7）
  autoPerPlayer: Record<Seat, number> // 自动算出的四家净分
  perPlayer: Record<Seat, number> // 手改后的最终净分
  isManual: boolean
  totalCheck: number // 必须 = 0（零和），否则账不平
}

function zero(): Record<Seat, number> {
  return { E: 0, S: 0, W: 0, N: 0 }
}

export function scoreRound(input: RoundInput, rules: RuleConfig = RULES): ScoreDetail {
  if (!rules.allowDianpao && 'winType' in input) {
    throw new Error('本桌不启用点炮')
  }

  const tier = rules.scoreTable.find((t) => t.patterns.includes(input.pattern))
  if (!tier) {
    const all = rules.scoreTable.flatMap((t) => t.patterns).join('、')
    throw new Error(`未知胡法「${input.pattern}」，可报：${all}`)
  }

  const base = input.hasGhost ? tier.withGhost : tier.withoutGhost
  const horseCount = horseCountFor(input.hasGhost, rules)
  if (input.horses.length > horseCount) {
    throw new Error(`本局${input.hasGhost ? '有鬼' : '硬胡(没鬼)'}最多摸 ${horseCount} 张马，实际录入 ${input.horses.length} 张`)
  }

  const per = zero()
  const gangLines: string[] = []
  const gangUnit = rules.baseUnit // 1 底分 = 1 分

  // 1) 摸马（v1.5）：马牌按庄家映射座位；只认赢家自己的马 —— N 张 → 胡分 ×N
  //    （1 张 = ×1 不翻，0 张 = 原分）；其他座位的马一律不计。
  const horseHits: HorseHit[] = []
  let ownHorseCount = 0
  for (const tile of input.horses) {
    const offset = horseOffsetOf(tile, rules)
    if (offset === null) throw new Error(`无法识别马牌「${tile}」`)
    const seat = seatFromOffset(offset, input.dealer)
    const winnerSelf = seat === input.winner
    if (winnerSelf) ownHorseCount++
    horseHits.push({ tile, seat, winnerSelf })
  }
  const selfTimes = selfHorseTimes(ownHorseCount)

  // 2) 胡牌主分：只有自摸，三家各付 1 份，赢家收 3 份；胡分按自己的马张数翻倍
  const oneShare = base * selfTimes * rules.share.zimoPerLoser
  for (const s of SEATS) {
    if (s === input.winner) per[s] += oneShare * 3
    else per[s] -= oneShare
  }

  // 3) 打鬼罚分（v1.7）：打出鬼牌者付其余每家各 ghost.penalty 分，逐次结算
  const ghostLines: string[] = []
  for (const g of input.ghostEvents ?? []) {
    const amount = rules.ghost.penalty
    for (const s of SEATS) {
      if (s === g.by) continue
      per[s] += amount
      per[g.by] -= amount
    }
    ghostLines.push(`打鬼：${g.by} 付其余每家 ${amount} 分`)
  }

  // 4) 杠分：立即结算，独立流水，单位固定为「底分」，不随胡法分数缩放
  for (const g of input.gangEvents ?? []) {
    if (g.type === 'dian') {
      if (!g.from) throw new Error('点杠必须提供放杠者 from')
      const amount = rules.gang.dianGang * gangUnit
      per[g.from] -= amount
      per[g.by] += amount
      gangLines.push(`点杠：${g.from} 付 ${g.by} ${amount} 分`)
    } else {
      const times = g.type === 'bu' ? rules.gang.buGang : rules.gang.anGang
      const amount = times * gangUnit
      for (const s of SEATS) {
        if (s === g.by) continue
        per[s] -= amount
        per[g.by] += amount
      }
      gangLines.push(`${g.type === 'bu' ? '补杠' : '暗杠'}：其余三家各付 ${g.by} ${amount} 分`)
    }
  }

  const autoPerPlayer = { ...per }
  const isManual = !!input.manualOverride && Object.keys(input.manualOverride).length > 0
  const perPlayer = isManual ? { ...per, ...input.manualOverride } : { ...per }
  const totalCheck = SEATS.reduce((sum, s) => sum + perPlayer[s], 0)

  return {
    tierName: input.pattern,
    base,
    hasGhost: input.hasGhost,
    horseCount,
    ownHorseCount,
    selfHorseTimes: selfTimes,
    zimoPerLoser: oneShare,
    horseHits,
    gangLines,
    ghostLines,
    autoPerPlayer,
    perPlayer,
    isManual,
    totalCheck,
  }
}
