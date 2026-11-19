/**
 * 计分引擎：纯函数，无 IO、无状态。
 * 输入「正常局：胡法档位 + 有无鬼 + 摸马牌面 + 杠分事件 + 打鬼事件」或
 * 「炸胡局（v1.9）：炸胡者 + 报出的虚胡档位」，输出四家净分与逐项明细。
 * 摸马张数由 horseCountFor(hasGhost) 决定（有鬼 4 / 没鬼 6），引擎只遍历数组、不假设张数。
 */
import {
  RULES, SEATS, horseCountFor, horseOffsetOf, seatFromOffset, selfHorseTimes,
  type RuleConfig, type Seat, type HorseTimesMode,
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
  winner?: Seat // 正常局：胡牌者；炸胡局为空
  zhaHuSeat?: Seat // 炸胡局（v1.9）：报胡后被查出没胡成的人；此时 winner 必须为空
  dealer: Seat
  pattern: string // 正常局=实际胡法档位；炸胡局=报出的（虚胡）档位，按它赔
  hasGhost: boolean // true = 有鬼；false = 硬胡（无鬼）
  horses: string[] // 本局中马的马牌牌面，最多 = horseCountFor(hasGhost) 张；炸胡局必须为空（没有赢家不摸马）
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
  kind: 'win' | 'zhaHu' // v1.9：win=正常胡牌局；zhaHu=炸胡局
  zhaHuSeat?: Seat // 炸胡局才有：报胡没胡成、赔三家的那个人
  tierName: string
  base: number // 该局胡法分数（查表原始值，未乘马倍）；炸胡局 = 按报的档位赔每家的金额
  hasGhost: boolean
  horseCount: number // 本局摸马张数上限；炸胡局 = 0（没有赢家不摸马）
  ownHorseCount: number // 赢家自己的马张数（v1.5）
  selfHorseTimes: number // 胡分倍数（v1.8 按 timesMode）
  zimoPerLoser: number
  horseHits: HorseHit[]
  horseMode: HorseTimesMode // v1.8 自马算术模式快照
  horseLines: string[] // flat 模式的独立马分流水（additive/geometric 为空）
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

  // v1.9：炸胡局（报胡后被查出没胡成）—— winner 为空、zhaHuSeat 必填、不摸马
  const isZhaHu = !input.winner && !!input.zhaHuSeat
  if (!isZhaHu && !input.winner) throw new Error('请选择胡牌玩家')
  if (isZhaHu && input.horses.length) throw new Error('炸胡局没有赢家，不摸马')

  const tier = rules.scoreTable.find((t) => t.patterns.includes(input.pattern))
  if (!tier) {
    const all = rules.scoreTable.flatMap((t) => t.patterns).join('、')
    throw new Error(`未知胡法「${input.pattern}」，可报：${all}`)
  }

  const base = input.hasGhost ? tier.withGhost : tier.withoutGhost
  const horseCount = isZhaHu ? 0 : horseCountFor(input.hasGhost, rules)
  if (!isZhaHu && input.horses.length > horseCount) {
    throw new Error(`本局${input.hasGhost ? '有鬼' : '硬胡(没鬼)'}最多摸 ${horseCount} 张马，实际录入 ${input.horses.length} 张`)
  }

  const per = zero()
  const gangLines: string[] = []
  const gangUnit = rules.baseUnit // 1 底分 = 1 分

  // 1) 摸马（v1.8）：马牌按庄家映射座位；只认赢家自马，其他座位的马一律不计。
  //    翻倍算术随 rules.horse.timesMode 切换（additive ×(1+N) / geometric ×2ⁿ / flat 独立马分）。
  //    炸胡局没有赢家，不摸马，跳过整段。
  const horseHits: HorseHit[] = []
  let ownHorseCount = 0
  let selfTimes = 1
  const horseLines: string[] = []
  if (!isZhaHu) {
    for (const tile of input.horses) {
      const offset = horseOffsetOf(tile, rules)
      if (offset === null) throw new Error(`无法识别马牌「${tile}」`)
      const seat = seatFromOffset(offset, input.dealer)
      const winnerSelf = seat === input.winner
      if (winnerSelf) ownHorseCount++
      horseHits.push({ tile, seat, winnerSelf })
    }
    const mode = rules.horse.timesMode
    selfTimes = selfHorseTimes(ownHorseCount, mode)
    if (mode === 'flat' && ownHorseCount > 0) {
      // flat 模式：马分独立，每张自马其余三家各付 flatBonus 分，不随档位缩放
      for (const h of horseHits) {
        if (!h.winnerSelf) continue
        for (const s of SEATS) {
          if (s === input.winner) continue
          per[s] -= rules.horse.flatBonus
          per[input.winner] += rules.horse.flatBonus
        }
        horseLines.push(`自马 ${h.tile}：其余三家各付 ${rules.horse.flatBonus} 分`)
      }
    }
  }

  // 2) 主分。
  //    正常局：只有自摸，三家各付 1 份，赢家收 3 份；胡分按马倍缩放（flat 模式 ×1）。
  //    炸胡局（v1.9）：胡什么牌赔什么牌 —— 报出的档位若有鬼胡成，三家各付 base，
  //    炸胡者把三份全包：付每家 base、共 3×base；硬胡按硬胡档位赔（hasGhost 决定）。
  let oneShare: number
  if (isZhaHu) {
    oneShare = base * rules.share.zimoPerLoser
    for (const s of SEATS) {
      if (s === input.zhaHuSeat) per[s] -= oneShare * 3
      else per[s] += oneShare
    }
  } else {
    oneShare = base * selfTimes * rules.share.zimoPerLoser
    for (const s of SEATS) {
      if (s === input.winner) per[s] += oneShare * 3
      else per[s] -= oneShare
    }
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
    kind: isZhaHu ? 'zhaHu' : 'win',
    ...(isZhaHu ? { zhaHuSeat: input.zhaHuSeat } : {}),
    tierName: input.pattern,
    base,
    hasGhost: input.hasGhost,
    horseCount,
    ownHorseCount,
    selfHorseTimes: selfTimes,
    zimoPerLoser: oneShare,
    horseHits,
    horseMode: rules.horse.timesMode,
    horseLines,
    gangLines,
    ghostLines,
    autoPerPlayer,
    perPlayer,
    isManual,
    totalCheck,
  }
}
