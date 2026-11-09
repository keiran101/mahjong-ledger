/**
 * 麻将牌面编码与归一化（34 张基础牌，无花牌）。
 * 视觉通道、牌型判定共用，不涉及分数。
 */
export const TILES_34: string[] = (() => {
  const a: string[] = []
  for (const suit of ['万', '条', '筒']) {
    for (let n = 1; n <= 9; n++) a.push(`${n}${suit}`)
  }
  return a.concat(['东风', '南风', '西风', '北风', '红中', '发财', '白板'])
})()

const CN_NUM: Record<string, number> = {
  一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
}

const TILE_ALIAS: Record<string, string> = {
  中: '红中', 红中: '红中', 發: '发财', 发: '发财', 发财: '发财',
  白: '白板', 白板: '白板', 东: '东风', 东风: '东风',
  南: '南风', 南风: '南风', 西: '西风', 西风: '西风',
  北: '北风', 北风: '北风',
}

const INDEX = new Map(TILES_34.map((t, i) => [t, i]))

export type RelSeat = 'shang' | 'dui' | 'xia'
export type Seat = 'E' | 'S' | 'W' | 'N'
export const SEATS: Seat[] = ['E', 'S', 'W', 'N']

/** 任意口语/数字牌面 → 标准名；无法识别返回 null */
export function normalizeTileName(raw: unknown): string | null {
  let t = String(raw ?? '').trim().replace(/\s/g, '')
  if (!t) return null
  t = t.replace(/^([一二两三四五六七八九])([万条筒饼索])$/, (_, d, s) => {
    const suit = s === '饼' ? '筒' : s === '索' ? '条' : s
    return `${CN_NUM[d]}${suit}`
  })
  t = t.replace(/^([1-9])([饼索])$/, (_, n, s) => `${n}${s === '饼' ? '筒' : '条'}`)
  if (TILE_ALIAS[t]) t = TILE_ALIAS[t]
  if (INDEX.has(t)) return t
  if (/^[1-9][万条筒]$/.test(t)) return t
  return null
}

export function tileIndex(name: string): number | null {
  const n = normalizeTileName(name)
  if (!n) return null
  const i = INDEX.get(n)
  return i === undefined ? null : i
}

export function countsOf(tiles: string[]): Int8Array {
  const c = new Int8Array(34)
  for (const t of tiles) {
    const i = tileIndex(t)
    if (i !== null) c[i]++
  }
  return c
}

export function isHonor(i: number): boolean {
  return i >= 27
}

export function isYao(i: number): boolean {
  if (i >= 27) return true
  const p = i % 9
  return p === 0 || p === 8
}

export function suitOf(i: number): number {
  return Math.floor(i / 9) // 0万 1条 2筒 3字
}

/**
 * 横牌在一组副露中的下标 → 相对赢家的来源。
 * 最左=上家，中间=对家，最右=下家（右手边）。
 */
export function relFromRotatedIndex(index: number, groupSize: number): RelSeat | null {
  if (index < 0 || groupSize < 3) return null
  if (index === 0) return 'shang'
  if (index === groupSize - 1) return 'xia'
  return 'dui'
}

export function seatFromRel(rel: RelSeat, winner: Seat): Seat {
  const i = SEATS.indexOf(winner)
  if (rel === 'xia') return SEATS[(i + 1) % 4]
  if (rel === 'dui') return SEATS[(i + 2) % 4]
  return SEATS[(i + 3) % 4]
}
