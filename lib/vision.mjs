/**
 * 拍照认牌：图片 → 规范化牌面草稿。
 *
 * 铁律：本模块绝不调用 scoreRound、不产出四家净分。
 * 一次看图思考：只认最下一排胡牌，忽略牌河，同时找出鬼和胡法。
 */
import { horseCountFor, RULES, SEATS } from './rules.ts'
import { canonicalPattern, inferWinningPattern } from './pattern.ts'
import {
  normalizeTileName, relFromRotatedIndex, seatFromRel, TILES_34, YAO_13,
} from './tiles.ts'
import { chatVision, getVlmConfig } from './vlm.mjs'

const SN = { E: '东', S: '南', W: '西', N: '北' }
const REL_LABEL = { shang: '上家', dui: '对家', xia: '下家' }

const CONFIRM_REASONS = [
  '相同牌张数（三个一万还是四个）视觉模型容易数错',
  '横牌位置决定点杠来自上家/对家/下家，空间关系不稳定',
  '点杠 / 补杠 / 暗杠在照片里经常长得像',
  '最容易把上半桌牌河认成手牌：只该认最下面一排',
  '鬼牌在图上就是一张普通牌，要靠胡法反推哪张是赖子',
  '天胡 / 地胡 / 杠上开花 / 海底捞月 / 抢杠胡牌面上没有',
  '胡法由对着照片思考（含鬼当赖子）预选，请核对',
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

  const detected = inferWinningPattern({
    hand, melds, ghostTile, special,
  })
  let pattern = detected.pattern
  let resolvedGhost = ghostTile || detected.inferredGhost
  if (!ghostTile && detected.inferredGhost) {
    resolvedGhost = detected.inferredGhost
    hasGhost = detected.hasGhostInHand
  }
  const patternComplete = detected.complete
  const patternCandidates = detected.candidates
  const patternReason = detected.complete
    ? `规则核算：${resolvedGhost ? `把「${resolvedGhost}」当鬼（赖子）` : '按无鬼'}判为「${pattern}」${detected.candidates.length > 1 ? `（同时可成立：${detected.candidates.join('、')}，取最高档）` : ''}`
    : '规则核算按面值不成胡；若有鬼当赖子，交给第二轮 LLM 猜'

  const notes = []
  if (description) notes.push(description)
  notes.push(patternReason)

  return {
    winner,
    photographer,
    dealer: ctx.dealer || null,
    hand,
    melds,
    horses,
    ghostTile: resolvedGhost,
    hasGhost,
    special,
    pattern,
    patternCandidates,
    patternComplete,
    patternReason,
    patternSource: 'engine',
    gangEvents,
    description,
    notes,
    warnings,
    confirmReasons: CONFIRM_REASONS,
    tiles: TILES_34,
  }
}

function buildThinkPrompt(ctx) {
  const seats = SEATS.map((s) => `${SN[s]}(${s})=${ctx.players?.[s]?.nickname || SN[s] + '家'}`).join('，')
  const who = ctx.photographer ? `${SN[ctx.photographer]}家（拍照人，默认赢家）` : '未知'
  const patterns = RULES.scoreTable.map((t) =>
    `第${t.times}档 ${t.patterns.join('、')}`).join('\n')
  return `你在看一张广东麻将「已经胡了」的桌面照片。先锁定画面最下面一排胡牌，再找鬼（百搭/赖子），再定最高档胡法。

【当前座位】${seats}
【拍照人 / 默认赢家】${who}
【庄家】${ctx.dealer ? SN[ctx.dealer] + '家' : '未知'}

════════════════════════════════
一、只看哪里（最重要，想错这里后面全错）
════════════════════════════════
1. 只认「画面最下方、最靠近桌子边缘」的那一横排正面朝上的牌 = 赢家胡牌（hand）。
2. 画面中上部、大片散落或成行的弃牌是「牌河」，一张都不能算进手牌、副露或马。
3. 不要因为牌河里有三张一样的，就把手牌里那张也当成刻子的一部分。
4. 副露（碰/杠）只有紧贴最下一排外侧、明显成组的 3～4 张才算赢家副露。牌河中央不是副露。
5. 马牌只有手牌旁另有一小撮刚翻开、大约 4 或 6 张的独立小排才算。牌河不是马。
6. 手牌通常 14 张（有杠则 14+杠数，或门清十四张）。若有杠才会多张，最多四杠也就是最多18张牌。

════════════════════════════════
二、这排牌已经胡了
════════════════════════════════
拍照的人已经自摸。你不是在判断「能不能胡」，而是在已经胡了的前提下读准最下一排胡的牌是什么牌型、首先找出鬼牌、再定档决定是什么牌型。
若最下一排看起来杂乱、没有对子/顺子/刻子，那一定是特殊牌型，或者有多张鬼牌（但鬼牌只会有一种）。
鸡胡必须能从最下一排拆出 4 组面子（刻或暗顺）+ 1 对。拆不出来就不能报鸡胡。

════════════════════════════════
三、思考鬼牌（百搭）
════════════════════════════════
本桌有鬼。鬼只有一种牌面，在图上长得和普通牌一样，可当任意牌。
请在思考里明确写出：
- 最下一排从左到右逐张点名（不要概括成「四个一万」）。
- 对照十三幺 13 种幺九字牌：${YAO_13.join('、')}
- 最下一排里有哪几种、缺哪几种、哪些牌不在这 13 种里。
- 不在这 13 种里、且彼此相同的牌 = 鬼牌候选。两张 5万 这种「格格不入」的重复牌，几乎就是两张鬼。
- 用鬼补上所缺幺九后，是否刚好十三幺（13 种齐 + 其中一种成对）。
- 若不是十三幺：七对、九莲、大三元/小三元、大四喜/小四喜、字一色、清一色、混一色、碰碰胡。
- 只有写出 4 面子 + 1 对之后，才允许报鸡胡。

例子（都只发生在最下一排，与牌河无关）：
A. 1万 9万 1条 9条 1筒 9筒 东 南 西 北 中 发 5万 5万 → 缺白板，5万×2 是鬼 → 十三幺
B. 1万 1万 9万 1条 9条 1筒 9筒 东 南 西 中 发 5万 5万 → 缺北风白板，5万×2 当鬼，1万成对 → 十三幺
C. 中×3 发×3 白×2 5万 2万×2 3万×3 → 5万当鬼补白 → 大三元

════════════════════════════════
四、合法胡法（pattern 必须用下面其中一个原名）
════════════════════════════════
${patterns}
多档同时成立只报倍数最高的一档。

════════════════════════════════
五、思考结束后只输出一个 JSON（不要 Markdown 围栏）
════════════════════════════════
{
  "description": "最下一排从左到右：……。上半桌牌河已忽略。鬼是……，胡法是……",
  "winnerGuess": "${ctx.photographer || 'E'}",
  "hand": [{"tile":"1万","orient":"shu"}],
  "melds": [],
  "horses": [],
  "yaoPresent": ["1万"],
  "yaoMissing": ["白板"],
  "nonYao": ["5万"],
  "ghostTile": "5万",
  "hasGhost": true,
  "pattern": "十三幺",
  "special": "none",
  "reason": "最下一排缺白板，两张5万当鬼补上，十三幺。牌河未计入。",
  "uncertain": []
}

约束：
- tile 只能用：1-9万、1-9条、1-9筒、东风、南风、西风、北风、红中、发财、白板
- orient 只能 shu 或 heng；横牌只出现在紧贴手牌的副露里
- hand 只能来自最下面一排，禁止把牌河抄进去
- ghostTile 为鬼的牌面；硬胡则 null 且 hasGhost false
- 不要输出分数`
}

function timesOfName(name) {
  if (!name) return 0
  const t = RULES.scoreTable.find((x) => x.patterns.includes(name))
  return t ? t.times : 0
}

export function applyPatternGuess(draft, guess, source = 'llm') {
  if (!draft || !guess) return draft
  const llmPattern = canonicalPattern(guess.pattern)
  const enginePattern = canonicalPattern(draft.pattern)
  const engineTimes = timesOfName(enginePattern)
  const llmTimes = timesOfName(llmPattern)
  const engineSpecial = !!(draft.patternComplete && enginePattern && enginePattern !== '鸡胡')

  // 引擎已成胡的高档（十三幺/大三元等）禁止被 LLM 降成鸡胡或更低档
  let pattern = llmPattern
  if (engineSpecial && (!llmPattern || llmPattern === '鸡胡' || llmTimes < engineTimes)) {
    pattern = enginePattern
  }
  if (!pattern) pattern = enginePattern || ''

  const ghost = guess.ghostTile == null || guess.ghostTile === '' || guess.ghostTile === 'null'
    ? null
    : normalizeTileName(guess.ghostTile)
  if (pattern) draft.pattern = pattern
  if (ghost) {
    draft.ghostTile = ghost
    draft.hasGhost = true
  } else if (pattern === enginePattern && draft.ghostTile) {
    draft.hasGhost = true
  } else if (guess.hasGhost === false && !engineSpecial) {
    draft.hasGhost = false
    if (!draft.ghostTile) draft.ghostTile = null
  } else if (typeof guess.hasGhost === 'boolean') {
    draft.hasGhost = guess.hasGhost
  }
  const reason = String(guess.reason || '').trim().slice(0, 280)
  const keptEngine = pattern === enginePattern && engineSpecial && llmPattern !== enginePattern
  if (keptEngine) {
    draft.patternReason = `规则核算维持「${enginePattern}」（LLM 报了「${llmPattern || '鸡胡'}」已忽略降档）。${draft.patternReason || ''}`
  } else if (reason) {
    draft.patternReason = `LLM 核算：${reason}`
  }
  draft.notes = [...(draft.notes || []).filter((n) => !String(n).startsWith('规则核算') && !String(n).startsWith('LLM 核算')), draft.patternReason].filter(Boolean)
  draft.patternSource = keptEngine ? 'engine' : source
  if (pattern && !(draft.patternCandidates || []).includes(pattern)) {
    draft.patternCandidates = [pattern, ...(draft.patternCandidates || [])]
  }
  return draft
}

export async function recognizeHand(imageDataUrl, ctx = {}) {
  const cfg = getVlmConfig()
  if (!cfg.configured) throw new Error('尚未配置拍照识别，请在右上角「设置」里填入 API Key')
  const think = !!cfg.enableThinking
  const { text, model } = await chatVision({
    imageDataUrl,
    system: think
      ? '你对着广东麻将照片思考：只认最下面一排胡牌，忽略牌河，找出百搭鬼牌并定最高档胡法。思考完只输出 JSON，不算分。'
      : '你对着广东麻将照片读牌：只认最下面一排胡牌，忽略牌河，标出百搭鬼牌并给出最高档胡法。只输出 JSON，不算分。',
    prompt: buildThinkPrompt(ctx),
    enableThinking: think,
    maxTokens: think ? 8192 : 2500,
    timeout: think ? 180000 : 90000,
  })
  const raw = extractJson(text)
  const draft = buildDraft(raw, ctx)
  applyPatternGuess(draft, raw, 'vlm')
  return { model, draft }
}
