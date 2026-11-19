/**
 * 房间规则设置（v1.10）：看板可改的「挡位开关」集中在这里定义。
 *
 * 设计目标：后面还会增加其他开关（如打鬼罚分档位、杠分档位……），
 * 加开关只需两步，前后端自动生效：
 *   1. 在 SWITCH_DEFS 加一项（key / 标签 / 选项），并在 RoomSettings 补字段类型；
 *   2. 在 applySettings 里把该 key 映射到 RuleConfig 的对应字段。
 *
 * 原则：
 * - 白名单校验：只认 SWITCH_DEFS 里声明过的 key 和 value，其余一律拒绝；
 * - 默认值取 RULES 当前值（改 rules.ts 默认，存量房间不动、新房间跟随）；
 * - 存储层 rooms.settings 存「补全后的完整生效设置」（变更时冻结，后续改 rules.ts 默认不影响存量房间），
 *   读出后仍经 resolveSettings 兜底，损坏或缺字段回退默认；
 * - 历史对局的 detail 已冻结 horseMode 快照，改开关不改写历史，账本 append-only 不破。
 */
import {
  RULES, selfHorseTimes,
  type RuleConfig, type HorseTimesMode,
} from './rules.ts'

export interface SwitchOptionDef {
  value: string
  label: string // 看板按钮文字
  hint: string // 一句话说明算术，给确认的人看
}

export interface SwitchDef {
  key: string // 存储与 API 的字段名
  label: string // 开关名称
  description: string // 副标题
  options: SwitchOptionDef[]
}

export interface RoomSettings {
  horseTimesMode: HorseTimesMode
}

/** 看板开关定义（v1.10 目前一项：自马翻倍算术）。加新挡位开关从这里开始。 */
export const SWITCH_DEFS: SwitchDef[] = [
  {
    key: 'horseTimesMode',
    label: '自马算术',
    description: '赢家摸到自己的马时，胡牌分怎么翻',
    options: [
      { value: 'additive', label: '加法 ×(1+N)', hint: '每张自马加 1 个底分后随档位缩放' },
      { value: 'geometric', label: '几何 ×2ⁿ', hint: '每张自马胡分翻一番' },
      { value: 'flat', label: '独立马分', hint: '胡分不乘马倍，每张自马其余三家各付 2 分' },
    ],
  },
]

/** 各开关当前生效值的可读描述（供看板摘要与明细展示） */
export function settingsSummary(settings: RoomSettings): string[] {
  const lines: string[] = []
  const def = SWITCH_DEFS.find((d) => d.key === 'horseTimesMode')!
  const opt = def.options.find((o) => o.value === settings.horseTimesMode)!
  lines.push(`自马算术：${opt.label}`)
  return lines
}

/** 把用户提交的原始对象收敛成合法 RoomSettings：白名单 key + 白名单 value，非法直接报错 */
export function normalizeSettings(raw: unknown): Partial<RoomSettings> {
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw as Record<string, unknown> : {}
  const out: Record<string, string> = {}
  for (const def of SWITCH_DEFS) {
    const v = src[def.key]
    if (v === undefined || v === null || v === '') continue
    if (!def.options.some((o) => o.value === v)) {
      const all = def.options.map((o) => o.value).join(' / ')
      throw new Error(`「${def.label}」只支持：${all}`)
    }
    out[def.key] = String(v)
  }
  return out as Partial<RoomSettings>
}

/** 差异 + 默认 → 完整生效设置（rooms.settings 只存用户改过的部分） */
export function resolveSettings(patch: Partial<RoomSettings> | null | undefined): RoomSettings {
  return {
    horseTimesMode: patch?.horseTimesMode ?? RULES.horse.timesMode,
  }
}

/** 全局规则 + 房间设置 → 本房间生效的 RuleConfig（不改动全局 RULES） */
export function applySettings(rules: RuleConfig, settings: RoomSettings): RuleConfig {
  const merged: RuleConfig = { ...rules, horse: { ...rules.horse, timesMode: settings.horseTimesMode } }
  // 不变量自检：任一模式下，0 张自马的胡分倍数必须 = 1
  if (selfHorseTimes(0, merged.horse.timesMode) !== 1) {
    throw new Error(`自马算术 ${merged.horse.timesMode} 违反不变量：0 张自马必须 ×1`)
  }
  return merged
}
