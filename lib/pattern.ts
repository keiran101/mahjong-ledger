/**
 * 牌面 → 胡法档位。纯函数，不计算分数。
 * 多档同时成立时取倍数最高的一个，与「系统不叠加、只报一档」一致。
 */
import { RULES } from './rules.ts'
import {
  countsOf, isHonor, isYao, normalizeTileName, suitOf, tileIndex,
} from './tiles.ts'

export type MeldKind = 'peng' | 'dian' | 'bu' | 'an'
export type SpecialWin = 'none' | 'qianggang' | 'gangkai' | 'haidi' | 'tian' | 'di'

export interface Meld {
  kind: MeldKind
  tiles: string[]
}

export interface PatternInput {
  hand: string[]
  melds?: Meld[]
  ghostTile?: string | null
  special?: SpecialWin | null
}

export interface PatternResult {
  pattern: string
  candidates: string[]
  complete: boolean
  hasGhostInHand: boolean
}

const SPECIAL_NAME: Record<Exclude<SpecialWin, 'none'>, string> = {
  qianggang: '抢杠胡',
  gangkai: '杠上开花',
  haidi: '海底捞月',
  tian: '天胡',
  di: '地胡',
}

function timesOf(name: string): number {
  const t = RULES.scoreTable.find((x) => x.patterns.includes(name))
  return t ? t.times : 0
}

function pickHighest(names: string[]): string {
  let best = names[0] || '鸡胡'
  let bestT = timesOf(best)
  for (const n of names) {
    const t = timesOf(n)
    if (t > bestT) { best = n; bestT = t }
  }
  return best
}

function splitGhost(tiles: string[], ghost: string | null): { counts: Int8Array, jokers: number, total: number } {
  const faces: string[] = []
  let jokers = 0
  for (const raw of tiles) {
    const n = normalizeTileName(raw)
    if (!n) continue
    if (ghost && n === ghost) jokers++
    else faces.push(n)
  }
  return { counts: countsOf(faces), jokers, total: faces.length + jokers }
}

function copyCounts(c: Int8Array): Int8Array {
  return Int8Array.from(c)
}

function consume(counts: Int8Array, i: number, need: number, jokers: number): number | null {
  const have = counts[i]
  const use = Math.min(have, need)
  const rest = need - use
  if (rest > jokers) return null
  counts[i] = (have - use) as number
  return jokers - rest
}

function canMeld(counts: Int8Array, jokers: number, n: number): boolean {
  if (n === 0) {
    if (jokers !== 0) return false
    for (let i = 0; i < 34; i++) if (counts[i]) return false
    return true
  }
  let i = -1
  for (let k = 0; k < 34; k++) if (counts[k] > 0) { i = k; break }
  if (i < 0) return jokers === 3 * n

  // 刻子
  {
    const c = copyCounts(counts)
    const j = consume(c, i, 3, jokers)
    if (j !== null && canMeld(c, j, n - 1)) return true
  }
  // 顺子：最小牌可作顺子的左/中/右
  if (i < 27) {
    const p = i % 9
    const bases: number[] = []
    if (p <= 6) bases.push(i)
    if (p >= 1 && p <= 7) bases.push(i - 1)
    if (p >= 2) bases.push(i - 2)
    for (const b of bases) {
      if (Math.floor(b / 9) !== Math.floor(i / 9)) continue
      const c = copyCounts(counts)
      let j = jokers
      let ok = true
      for (let d = 0; d < 3; d++) {
        const nj = consume(c, b + d, 1, j)
        if (nj === null) { ok = false; break }
        j = nj
      }
      if (ok && canMeld(c, j, n - 1)) return true
    }
  }
  return false
}

function canStandard(counts: Int8Array, jokers: number, setsNeeded: number): boolean {
  if (setsNeeded < 0) return false
  // 对子：两张鬼
  if (jokers >= 2 && canMeld(counts, jokers - 2, setsNeeded)) return true
  for (let i = 0; i < 34; i++) {
    if (counts[i] + jokers < 2) continue
    const c = copyCounts(counts)
    const j = consume(c, i, 2, jokers)
    if (j !== null && canMeld(c, j, setsNeeded)) return true
  }
  return false
}

function canPongOnly(counts: Int8Array, jokers: number, setsNeeded: number): boolean {
  if (setsNeeded < 0) return false
  if (jokers >= 2) {
    const left = tryPongSets(counts, jokers - 2, setsNeeded)
    if (left) return true
  }
  for (let i = 0; i < 34; i++) {
    if (counts[i] + jokers < 2) continue
    const c = copyCounts(counts)
    const j = consume(c, i, 2, jokers)
    if (j !== null && tryPongSets(c, j, setsNeeded)) return true
  }
  return false
}

function tryPongSets(counts: Int8Array, jokers: number, n: number): boolean {
  if (n === 0) {
    if (jokers !== 0) return false
    for (let i = 0; i < 34; i++) if (counts[i]) return false
    return true
  }
  let i = -1
  for (let k = 0; k < 34; k++) if (counts[k] > 0) { i = k; break }
  if (i < 0) return jokers === 3 * n
  const c = copyCounts(counts)
  const j = consume(c, i, 3, jokers)
  if (j === null) return false
  return tryPongSets(c, j, n - 1)
}

/** 七对：14 张、无副露。返回豪华级数 0–3，不成七对返回 -1 */
function qiDuiLevel(counts: Int8Array, jokers: number, total: number): number {
  if (total !== 14) return -1
  const c = Int8Array.from(counts)
  let j = jokers
  let quads = 0
  let pairs = 0
  // 先把已有 4 张当成豪华对
  for (let i = 0; i < 34; i++) {
    while (c[i] >= 4) { c[i] -= 4; quads++; pairs += 2 }
    if (c[i] >= 2) { c[i] -= 2; pairs++ }
  }
  let singles = 0
  for (let i = 0; i < 34; i++) singles += c[i]
  // 单张各配一张鬼成对
  const pairFromSingle = Math.min(singles, j)
  j -= pairFromSingle
  pairs += pairFromSingle
  singles -= pairFromSingle
  if (singles > 0) return -1
  // 剩余鬼两两成对；若还能给已有对升级成四张，记豪华
  if (j % 2 !== 0) return -1
  const extraPairs = j / 2
  pairs += extraPairs
  // 用两对鬼把已有对升成四张：每升 1 豪华消耗 2 张鬼 = 1 extraPair
  const canUpgrade = Math.min(extraPairs, pairs - extraPairs)
  quads += canUpgrade
  if (pairs !== 7) return -1
  return Math.min(3, quads)
}

function allTiles(hand: string[], melds: Meld[]): string[] {
  const a = [...hand]
  for (const m of melds) a.push(...m.tiles)
  return a
}

function suitProfile(tiles: string[], ghost: string | null): { suits: Set<number>, honors: boolean, yaoOnly: boolean, honorOnly: boolean } {
  const suits = new Set<number>()
  let honors = false
  let yaoOnly = true
  let honorOnly = true
  for (const raw of tiles) {
    const n = normalizeTileName(raw)
    if (!n) continue
    if (ghost && n === ghost) continue
    const i = tileIndex(n)
    if (i === null) continue
    if (isHonor(i)) { honors = true; continue }
    honorOnly = false
    suits.add(suitOf(i))
    if (!isYao(i)) yaoOnly = false
  }
  if (!honors) honorOnly = false
  return { suits, honors, yaoOnly, honorOnly }
}

function windPongs(melds: Meld[], handCounts: Int8Array, jokers: number): { pongs: number, pair: boolean } {
  // 东风..北风 = 27..30
  const pong = [false, false, false, false]
  for (const m of melds) {
    const i = tileIndex(m.tiles[0] || '')
    if (i !== null && i >= 27 && i <= 30) pong[i - 27] = true
  }
  let pair = false
  for (let w = 0; w < 4; w++) {
    if (pong[w]) continue
    const n = handCounts[27 + w]
    if (n + jokers >= 3) pong[w] = true
    else if (n + jokers >= 2) pair = true
  }
  return { pongs: pong.filter(Boolean).length, pair }
}

function dragonPongs(melds: Meld[], handCounts: Int8Array, jokers: number): { pongs: number, pair: boolean } {
  const pong = [false, false, false]
  for (const m of melds) {
    const i = tileIndex(m.tiles[0] || '')
    if (i !== null && i >= 31 && i <= 33) pong[i - 31] = true
  }
  let pair = false
  for (let d = 0; d < 3; d++) {
    if (pong[d]) continue
    const n = handCounts[31 + d]
    if (n + jokers >= 3) pong[d] = true
    else if (n + jokers >= 2) pair = true
  }
  return { pongs: pong.filter(Boolean).length, pair }
}

function matchesNineBase(counts: Int8Array, jokers: number, suit: number): boolean {
  const need = [3, 1, 1, 1, 1, 1, 1, 1, 3]
  let j = jokers
  for (let p = 0; p < 9; p++) {
    const have = counts[suit * 9 + p]
    if (have > need[p]) return false
    j -= need[p] - have
    if (j < 0) return false
  }
  return j === 0
}

function isNineGates(hand: string[], ghost: string | null): boolean {
  if (hand.length !== 14) return false
  const { counts, jokers } = splitGhost(hand, ghost)
  let suit = -1
  for (let i = 0; i < 27; i++) {
    if (!counts[i]) continue
    const s = suitOf(i)
    if (suit < 0) suit = s
    else if (s !== suit) return false
  }
  if (suit < 0) return false
  for (let i = 27; i < 34; i++) if (counts[i]) return false
  // 抽出第 14 张（本花色 1–9 或一张鬼），剩下必须是 1112345678999
  for (let p = 0; p < 9; p++) {
    const i = suit * 9 + p
    if (counts[i] > 0) {
      const c = Int8Array.from(counts)
      c[i]--
      if (matchesNineBase(c, jokers, suit)) return true
    }
  }
  if (jokers >= 1 && matchesNineBase(counts, jokers - 1, suit)) return true
  return false
}

function isThirteenOrphans(hand: string[], ghost: string | null): boolean {
  if (hand.length !== 14) return false
  const yaoIdx = [0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32, 33]
  const { counts, jokers } = splitGhost(hand, ghost)
  for (let i = 0; i < 34; i++) {
    if (!yaoIdx.includes(i) && counts[i] > 0) return false
  }
  let missing = 0
  let extra = 0
  for (const i of yaoIdx) {
    if (counts[i] === 0) missing++
    else extra += counts[i] - 1
  }
  if (missing > jokers) return false
  return extra + (jokers - missing) === 1
}

export function detectPattern(input: PatternInput): PatternResult {
  const hand = (input.hand || []).map(normalizeTileName).filter((x): x is string => !!x)
  const melds = (input.melds || []).map((m) => ({
    kind: m.kind,
    tiles: (m.tiles || []).map(normalizeTileName).filter((x): x is string => !!x),
  }))
  const ghost = input.ghostTile ? normalizeTileName(input.ghostTile) : null
  const hasGhostInHand = !!(ghost && hand.includes(ghost))
  const { counts, jokers, total } = splitGhost(hand, ghost)
  const setsNeeded = 4 - melds.length
  const completeStd = canStandard(counts, jokers, setsNeeded)
  const pongPong = canPongOnly(counts, jokers, setsNeeded) && melds.every((m) => m.kind !== 'peng' || true)
  // 副露若是顺子本桌不存在；碰/杠都算刻
  const exposedAllPongs = melds.every((m) => m.tiles.length >= 3)
  const isPongHand = completeStd && pongPong && exposedAllPongs

  const qiLevel = melds.length === 0 ? qiDuiLevel(counts, jokers, total) : -1
  const thirteen = melds.length === 0 && isThirteenOrphans(hand, ghost)
  const nine = melds.length === 0 && isNineGates(hand, ghost)

  const profile = suitProfile(allTiles(hand, melds), ghost)
  const kongs = melds.filter((m) => m.kind === 'dian' || m.kind === 'bu' || m.kind === 'an').length

  const names: string[] = []
  const complete = completeStd || qiLevel >= 0 || thirteen

  if (thirteen) names.push('十三幺')
  if (nine) names.push('九宝莲灯')
  if (kongs === 4 && completeStd) names.push('十八罗汉')
  if (qiLevel >= 3) names.push('三豪华七对')
  else if (qiLevel === 2) names.push('双豪华七对')
  else if (qiLevel === 1) names.push('豪华七对')
  else if (qiLevel === 0) names.push('七对')

  if (profile.honorOnly && complete) names.push('字一色')
  if (profile.suits.size === 1 && !profile.honors && complete) names.push('清一色')
  if (profile.suits.size === 1 && profile.honors && complete) names.push('混一色')
  if (profile.yaoOnly && !profile.honors && complete) names.push('清幺九')
  if (profile.yaoOnly && profile.honors && !profile.honorOnly && complete) names.push('混幺九')
  if (isPongHand) names.push('碰碰胡')

  const winds = windPongs(melds, counts, jokers)
  const dragons = dragonPongs(melds, counts, jokers)
  if (complete && winds.pongs === 4) names.push('大四喜')
  else if (complete && winds.pongs === 3 && winds.pair) names.push('小四喜')
  if (complete && dragons.pongs === 3) names.push('大三元')
  else if (complete && dragons.pongs === 2 && dragons.pair) names.push('小三元')

  if (completeStd && names.length === 0) names.push('鸡胡')
  if (!complete && names.length === 0) names.push('鸡胡')

  const special = input.special && input.special !== 'none' ? SPECIAL_NAME[input.special] : null
  if (special) names.push(special)

  const uniq = [...new Set(names)]
  return {
    pattern: pickHighest(uniq),
    candidates: uniq.sort((a, b) => timesOf(b) - timesOf(a)),
    complete,
    hasGhostInHand,
  }
}
