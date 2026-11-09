/**
 * 拍照认牌：图片 → 规范化牌面草稿。
 *
 * 铁律：本模块绝不调用 scoreRound、不产出四家净分。
 * VLM 只读牌；张数、横竖、杠型、鬼牌、特殊胡、牌型全部标成待确认项。
 */
import { horseCountFor, RULES, SEATS } from './rules.ts'
import { canonicalPattern, inferWinningPattern } from './pattern.ts'
import {
  normalizeTileName, relFromRotatedIndex, seatFromRel, TILES_34, YAO_13,
} from './tiles.ts'
import { chatText, chatVision, getVlmConfig } from './vlm.mjs'

const SN = { E: '东', S: '南', W: '西', N: '北' }
const REL_LABEL = { shang: '上家', dui: '对家', xia: '下家' }

const CONFIRM_REASONS = [
  '相同牌张数（三个一万还是四个）视觉模型容易数错',
  '横牌位置决定点杠来自上家/对家/下家，空间关系不稳定',
  '点杠 / 补杠 / 暗杠在照片里经常长得像',
  '马区、副露、手牌可能被划错行',
  '鬼牌在图上就是一张普通牌，模型不知道本局鬼是哪张',
  '天胡 / 地胡 / 杠上开花 / 海底捞月 / 抢杠胡牌面上没有',
  '胡法由读牌后的第二轮核算猜测（含鬼当赖子），已预选，请核对',
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
- ghostTile 图上看不出来就填 null（不要猜胡法，胡法第二轮再算）
- special 图上看不出来就填 none
- 逐张列出，不要写「四个一万」这种概括
- 绝对不要输出分数或四家净分`
}

function formatMeld(m) {
  const kind = { peng: '碰', dian: '点杠', bu: '补杠', an: '暗杠' }[m.kind] || m.kind
  return `${kind} ${m.tiles.join(' ')}`
}

function yaoBreakdown(hand) {
  const yaoSet = new Set(YAO_13)
  const present = []
  const missing = []
  const counts = new Map()
  for (const t of hand || []) counts.set(t, (counts.get(t) || 0) + 1)
  for (const y of YAO_13) {
    if (counts.get(y)) present.push(`${y}×${counts.get(y)}`)
    else missing.push(y)
  }
  const nonYao = []
  for (const [t, n] of counts) {
    if (!yaoSet.has(t)) nonYao.push(`${t}×${n}`)
  }
  return { present, missing, nonYao }
}

function buildGuessPrompt(draft) {
  const patterns = RULES.scoreTable.map((t) =>
    `第${t.times}档 ${t.patterns.join('、')}（有鬼${t.withGhost} / 硬胡${t.withoutGhost}）`).join('\n')
  const yao = yaoBreakdown(draft.hand || [])
  const meldStr = (draft.melds || []).map(formatMeld).join('；') || '无副露（门清）'
  return `你在给一副「已经胡了」的广东麻将赢家手牌定档。拍照的人已经自摸胡牌。你的任务不是判断能不能胡，而是在已经胡了的前提下，找出倍数最高的那一档，并指出哪张牌是鬼（赖子）。

绝对不要输出分数。绝对禁止因为「看不出对子/顺子/刻子」就报鸡胡。

————————————————
【铁律】
1. 这副牌已经胡了。若 14 张看起来杂乱、组不成面子，那一定是特殊牌型，不是鸡胡。
2. 鸡胡 = 必须能明确拆成 4 组面子（刻或暗顺）+ 1 对。拆不出来就不能报鸡胡。
3. 本桌有鬼。鬼是赖子，可当任意牌。鬼牌在照片上长着普通牌的脸（例如两张 5万 其实是两张鬼）。
4. 鬼只有一种牌面。手里若有 1～4 张相同的「格格不入」的牌，它们就是鬼。
5. 多档同时成立只报倍数最高的一档。

————————————————
【遇到杂乱 14 张、无副露时，按这个顺序想，不要跳】

第一步　对照十三幺的 13 种幺九字牌：
　${YAO_13.join('、')}
　列出：手里有哪几种、缺哪几种、哪些牌不在这 13 种里。

第二步　不在这 13 种里的牌 = 鬼牌候选。
　- 两张相同的非幺九（如 5万×2）→ 鬼就是 5万，两张都当赖子，去补所缺的幺九。
　- 缺 2 种幺九 + 多 2 张同一非幺九 → 就是「十三幺带两张鬼」。
　- 缺 1 种幺九 + 多 1 张非幺九 + 某幺九成对 → 也是十三幺。
　十三幺成立条件：13 种幺九齐（缺的用鬼补）+ 其中一种成对（多的那张可以是鬼）。

第三步　若不是十三幺，再问：
　- 七对 / 豪华七对：14 张配成 7 对，单张用鬼去配对。
　- 九莲宝灯：同一花色 1112345678999 + 任意一张该花色。
　- 大三元：中、发、白都成刻（缺的用鬼补）；小三元是其中两种刻、第三种成对。
　- 大四喜 / 小四喜：东南西北四刻 / 三刻+一对。
　- 字一色 / 清一色 / 混一色 / 碰碰胡。
　- 只有当你已经写出 4 面子 + 1 对时，才可以报鸡胡。

————————————————
【例子】
A. 手牌：1万 9万 1条 9条 1筒 9筒 东风 南风 西风 北风 红中 发财 5万 5万
　缺白板；两张 5万 不是幺九 → 5万是鬼，补白板，再剩一张鬼当对子 → 十三幺。禁止报鸡胡。

B. 手牌：1万 1万 9万 1条 9条 1筒 9筒 东 南 西 中 发 5万 5万
　缺北风、白板；5万×2 当鬼分别补北风和白板；1万成对 → 十三幺。

C. 红中×3 发财×3 白板×2 5万 2万×2 3万×3
　5万当鬼补白板 → 大三元。

————————————————
【合法胡法（pattern 必须是其中一字不差的一个）】
${patterns}

【当前牌面】
手牌（${(draft.hand || []).length}张）：${(draft.hand || []).join('、') || '（空）'}
副露：${meldStr}
马牌：${(draft.horses || []).join('、') || '无'}

【已替你对照十三幺】
已有幺九：${yao.present.join('、') || '无'}
缺少幺九：${yao.missing.join('、') || '无（13种齐）'}
非幺九牌（优先当鬼）：${yao.nonYao.join('、') || '无'}
${draft.ghostTile ? `规则引擎已猜鬼牌：${draft.ghostTile}` : '规则引擎尚未确定鬼牌'}
规则引擎意见：${draft.patternReason || '无'}
规则候选：${(draft.patternCandidates || []).filter(Boolean).join('、') || '无'}
${draft.patternComplete && draft.pattern && draft.pattern !== '鸡胡' ? `规则引擎已成胡并定为「${draft.pattern}」。你可以维持或改成更高档，禁止降成鸡胡。` : '规则引擎未确认成胡。请按上面三步推断，不要图省事报鸡胡。'}

————————————————
先在心里走完第一步～第三步，再输出一个 JSON（不要 Markdown 围栏）：
{
  "yaoPresent": ["已有的幺九"],
  "yaoMissing": ["缺少的幺九"],
  "nonYao": ["非幺九，即鬼候选"],
  "ghostTile": "5万",
  "hasGhost": true,
  "pattern": "十三幺",
  "reason": "缺白板和北风，两张5万当鬼补上，1万成对，十三幺"
}
硬胡时 ghostTile 为 null、hasGhost 为 false。pattern 必须是合法胡法列表中的名字。`
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

async function guessHuWithLlm(draft) {
  const { text, model } = await chatText({
    system: '你在给已经胡了的广东麻将定档。杂乱不成面子就去想十三幺和鬼牌，禁止无拆解地报鸡胡。只输出 JSON，不算分。',
    prompt: buildGuessPrompt(draft),
  })
  const obj = extractJson(text)
  return { guess: obj, model }
}

export async function recognizeHand(imageDataUrl, ctx = {}) {
  const cfg = getVlmConfig()
  if (!cfg.configured) throw new Error('尚未配置 Qwen3.7 拍照识别，请在「设置」里填入通义千问 API Key')
  const { text, model } = await chatVision({
    imageDataUrl,
    system: '你是广东麻将读牌助手。只认牌、只输出规范化描述和 JSON，绝不计算分数、不要猜胡法。',
    prompt: buildPrompt(ctx),
  })
  const raw = extractJson(text)
  const draft = buildDraft(raw, ctx)
  try {
    const { guess } = await guessHuWithLlm(draft)
    applyPatternGuess(draft, guess, 'llm')
  } catch (e) {
    draft.warnings.push(`第二轮胡法猜测失败，已用规则核算：${e.message}`)
  }
  return { model, draft }
}
