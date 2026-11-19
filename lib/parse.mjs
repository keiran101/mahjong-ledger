/**
 * 自然语言 → RoundInput（结构化字段）。
 *
 * 两路解析：
 *  - LLM 模式：调用 lib/llm.mjs，让模型只抽取字段，输出严格 JSON。
 *  - 规则模式：确定性关键词解析器（未配置 LLM 或 LLM 连接失败时的兜底）。
 *
 * 铁律：两路都只产出 { winner?, zhaHuSeat?, pattern, hasGhost, horses, gangEvents, ghostEvents }，
 * 绝不产出分数。分数由 scoreRound() 计算，且结果必须过零和断言。
 * 炸胡局（v1.9）没有赢家：口述「炸胡/诈胡」时给 zhaHuSeat，winner 为空，horses 强制为空。
 * 所有字段都会被二次校验/归一化，模型输出不可信。
 */
import { RULES, SEATS, horseCountFor } from './rules.ts'
import { getConfig, chat } from './llm.mjs'

const SN = { E: '东', S: '南', W: '西', N: '北' }
const ALL_PATTERNS = RULES.scoreTable.flatMap((t) => t.patterns)

const SEAT_ALIAS = {
  E: ['东家', '东', '东位', '庄家', '庄'],
  S: ['南家', '南', '南位'],
  W: ['西家', '西', '西位'],
  N: ['北家', '北', '北位'],
}

/** 口语别名 → 规则表里的标准档位名 */
const PATTERN_SYNONYM = {
  平胡: '鸡胡', 屁胡: '鸡胡', 鸡糊: '鸡胡', 鸡和: '鸡胡', 无番: '鸡胡', 普通胡: '鸡胡', 杂胡: '鸡胡', 鸡胡牌: '鸡胡',
  对对胡: '碰碰胡', 碰碰和: '碰碰胡', 对对和: '碰碰胡', 碰碰胡牌: '碰碰胡',
  七小对: '七对', 七对子: '七对', 七对牌: '七对',
  清一: '清一色', 混一: '混一色',
  抢杠: '抢杠胡', 杠开: '杠上开花', 杠上花: '杠上开花', 海底: '海底捞月',
  豪华七小对: '豪华七对', 双豪华七小对: '双豪华七对', 三豪华七小对: '三豪华七对',
  混幺: '混幺九', 清幺: '清幺九', 字一: '字一色',
  十三幺九: '十三幺', 九莲宝灯: '九宝莲灯',
}

const GANG_TYPE = {
  暗杠: 'an', 暗: 'an', an: 'an', angang: 'an',
  补杠: 'bu', 加杠: 'bu', 补: 'bu', bu: 'bu',
  点杠: 'dian', 明杠: 'dian', 点: 'dian', dian: 'dian',
}

function seatName(s, ctx) {
  const nick = String(ctx.players?.[s]?.nickname || '').trim()
  return nick ? `${nick}（${SN[s]}家）` : `${SN[s]}家`
}

/** 把任意短 token 解析成座位。昵称优先于方位词，避免叫「阿东」的人被当成东家 */
function resolveSeat(raw, ctx) {
  if (raw === null || raw === undefined) return null
  const t = String(raw).trim()
  if (!t) return null
  const low = t.toLowerCase()
  if (['e', 's', 'w', 'n'].includes(low)) return low.toUpperCase()

  for (const s of SEATS) {
    const nick = String(ctx.players?.[s]?.nickname || '').trim()
    if (nick && low === nick.toLowerCase()) return s
  }
  let best = null
  let bestLen = 0
  for (const s of SEATS) {
    const nick = String(ctx.players?.[s]?.nickname || '').trim()
    if (nick && t.includes(nick) && nick.length > bestLen) { best = s; bestLen = nick.length }
  }
  if (best) return best

  if (/庄家?|^庄$/.test(t)) return ctx.dealer
  if (/下家/.test(t)) return SEATS[(SEATS.indexOf(ctx.dealer) + 1) % 4]
  if (/对家/.test(t)) return SEATS[(SEATS.indexOf(ctx.dealer) + 2) % 4]
  if (/上家/.test(t)) return SEATS[(SEATS.indexOf(ctx.dealer) + 3) % 4]

  for (const s of SEATS) {
    for (const a of SEAT_ALIAS[s]) {
      if (t === a || t.includes(a)) return s
    }
  }
  return null
}

function resolvePattern(raw) {
  if (raw === null || raw === undefined) return null
  const t = String(raw).trim().replace(/[\s，,。、"'「」：:]/g, '')
  if (!t) return null
  if (ALL_PATTERNS.includes(t)) return t
  if (PATTERN_SYNONYM[t]) return PATTERN_SYNONYM[t]
  const stripped = t.replace(/[胡和糊]$/, '')
  if (ALL_PATTERNS.includes(stripped)) return stripped
  if (PATTERN_SYNONYM[stripped]) return PATTERN_SYNONYM[stripped]
  const candidates = [...ALL_PATTERNS, ...Object.keys(PATTERN_SYNONYM)].sort((a, b) => b.length - a.length)
  const hit = candidates.find((p) => t.includes(p))
  if (!hit) return null
  return ALL_PATTERNS.includes(hit) ? hit : PATTERN_SYNONYM[hit]
}

/** 否定优先：「没有鬼」里含「有鬼」，必须先判否定 */
function resolveGhost(raw) {
  if (typeof raw === 'boolean') return raw
  const t = String(raw ?? '').trim().toLowerCase()
  if (!t) return null
  if (/硬胡|无鬼|没鬼|没有鬼|无鬼牌|没鬼牌|无赖子|没赖子|无混|没混|无鬼儿/.test(t)) return false
  if (/有鬼|带鬼|有鬼牌|有赖子|有混|true|yes|^1$|^是$/.test(t)) return true
  if (/false|no|^0$|^否$/.test(t)) return false
  return null
}

function tileForSeat(seat, dealer) {
  const off = (SEATS.indexOf(seat) - SEATS.indexOf(dealer) + 4) % 4
  return ['1万', '2万', '3万', '4万'][off]
}

const CN_NUM = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
const TILE_ALIAS = {
  中: '红中', 红中: '红中', 发: '发财', 发财: '发财', 白: '白板', 白板: '白板',
  东: '东风', 东风: '东风', 南: '南风', 南风: '南风', 西: '西风', 西风: '西风', 北: '北风', 北风: '北风',
}

/** 摸马牌面归一化；也接受「南家」这类座位口述，按当前庄家反推一张等价牌面 */
function normalizeTile(raw, ctx) {
  let t = String(raw ?? '').trim().replace(/\s/g, '')
  if (!t) return null
  t = t.replace(/^([一二两三四五六七八九])([万条筒饼索])$/, (_, d, s) =>
    `${CN_NUM[d]}${s === '饼' ? '筒' : s === '索' ? '条' : s}`)
  if (TILE_ALIAS[t]) t = TILE_ALIAS[t]
  if (t in RULES.horse.mapping) return t
  if (/^[1-9][万条筒]$/.test(t)) return t
  const seat = resolveSeat(t, ctx)
  if (seat && /家|风|^[东南西北]$|庄|下家|对家|上家/.test(t)) return tileForSeat(seat, ctx.dealer)
  return null
}

function resolveHorses(raw, ctx, warnings, hasGhost) {
  let items = raw
  if (!Array.isArray(items)) {
    if (items === null || items === undefined || String(items).trim() === '') items = []
    else items = String(items).split(/[、,，\s]+/)
  }
  if (/^(无|没|没有|不中|未中|空|none|null)$/i.test(String(raw).trim())) return []
  const out = []
  for (const it of items) {
    const tile = normalizeTile(it, ctx)
    if (!tile) { warnings.push(`未能识别马牌「${String(it).slice(0, 12)}」，已忽略`); continue }
    out.push(tile)
  }
  // 摸马张数随有无鬼变：有鬼 4 张、没鬼（硬胡）6 张
  const max = horseCountFor(hasGhost)
  if (out.length > max) {
    warnings.push(`本局${hasGhost ? '有鬼' : '硬胡(没鬼)'}最多摸 ${max} 张马，只取前 ${max} 张`)
    return out.slice(0, max)
  }
  return out
}

function resolveGangType(raw) {
  return GANG_TYPE[String(raw ?? '').trim().toLowerCase()] || null
}

function resolveGang(raw, ctx, warnings) {
  if (!Array.isArray(raw) || !raw.length) return []
  const out = []
  for (const g of raw) {
    if (!g || typeof g !== 'object') { warnings.push('忽略一条格式错误的杠分'); continue }
    const type = resolveGangType(g.type)
    const by = resolveSeat(g.by, ctx)
    if (!type || !by) { warnings.push('忽略一条无法识别的杠分（需类型 + 杠牌人）'); continue }
    if (type === 'dian') {
      const from = resolveSeat(g.from, ctx)
      if (!from || from === by) { warnings.push('点杠缺少有效的放杠者，已忽略该条'); continue }
      out.push({ type, by, from })
    } else {
      out.push({ type, by })
    }
  }
  return out
}

function resolveGhostEvents(raw, ctx, warnings) {
  if (!Array.isArray(raw) || !raw.length) return []
  const out = []
  for (const g of raw) {
    if (!g || typeof g !== 'object') { warnings.push('忽略一条格式错误的打鬼'); continue }
    const by = resolveSeat(g.by, ctx)
    if (!by) { warnings.push('忽略一条无法识别的打鬼（需打鬼者座位）'); continue }
    out.push({ by })
  }
  return out
}

/** 所有解析路径的公共收口：严格校验 + 归一化 + 生成可读说明 */
function validateAndNormalize(obj, ctx, mode, extraWarnings = []) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('解析结果不是对象')
  const warnings = [...extraWarnings]
  const notes = []

  const winner = resolveSeat(obj.winner, ctx)
  const zhaSeat = resolveSeat(obj.zhaHu ?? obj.zhaHuSeat, ctx)
  const isZhaHu = !winner && !!zhaSeat
  if (winner && zhaSeat) {
    warnings.push('口述同时出现赢家和炸胡，按正常胡牌局处理；如要记炸胡请在表单重新录入')
  }
  if (!winner && !zhaSeat) {
    throw new Error('没能识别「谁胡了」（或炸胡的是谁），请说清楚（例如「东家自摸」「南家炸胡」），或在下方表单手动选')
  }
  if (isZhaHu) {
    notes.push(`炸胡：${seatName(zhaSeat, ctx)}（胡什么牌赔什么牌）`)
  } else {
    notes.push(`赢家：${seatName(winner, ctx)}`)
  }

  const pattern = resolvePattern(obj.pattern)
  if (!pattern) throw new Error(`没能识别胡法「${String(obj.pattern ?? '空').slice(0, 16)}」，请报档位名（如鸡胡/清一色），或在下方手动选`)
  notes.push(isZhaHu ? `报出的胡法：${pattern}（按它赔三家）` : `胡法：${pattern}`)

  let hasGhost = resolveGhost(obj.hasGhost)
  if (hasGhost === null) {
    hasGhost = true
    warnings.push('口述没说明有无鬼，按「有鬼」处理')
  }
  notes.push(hasGhost ? '有鬼' : '硬胡（无鬼 ×2）')

  const rawHorses = resolveHorses(obj.horses, ctx, warnings, hasGhost)
  const horses = isZhaHu ? [] : rawHorses
  if (isZhaHu) {
    if (rawHorses.length) warnings.push('炸胡局没有赢家、不摸马，口述的马牌已忽略')
    notes.push('炸胡局不摸马')
  } else {
    notes.push(horses.length ? `摸马 ${horseCountFor(hasGhost)} 张，中马：${horses.join('、')}` : `摸马 ${horseCountFor(hasGhost)} 张，未中马`)
  }

  const gangEvents = resolveGang(obj.gangEvents, ctx, warnings)
  if (gangEvents.length) notes.push(`杠分：${gangEvents.length} 条`)

  const ghostEvents = resolveGhostEvents(obj.ghostEvents, ctx, warnings)
  if (ghostEvents.length) notes.push(`打鬼罚分：${ghostEvents.length} 次`)

  return {
    mode,
    input: isZhaHu
      ? { kind: 'zhaHu', zhaHuSeat: zhaSeat, dealer: ctx.dealer, pattern, hasGhost, horses: [], gangEvents, ghostEvents }
      : { kind: 'win', winner, dealer: ctx.dealer, pattern, hasGhost, horses, gangEvents, ghostEvents },
    notes,
    warnings,
  }
}

function extractJson(content) {
  let t = String(content).trim()
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t)
  if (fence) t = fence[1].trim()
  const a = t.indexOf('{')
  const b = t.lastIndexOf('}')
  if (a < 0 || b <= a) throw new Error('LLM 未返回 JSON 对象')
  try { return JSON.parse(t.slice(a, b + 1)) } catch { throw new Error('LLM 返回的 JSON 无法解析') }
}

function buildPrompt(ctx) {
  const seats = SEATS.map((s) => `${SN[s]}(${s})=${ctx.players?.[s]?.nickname || SN[s] + '家'}`).join('，')
  const dealerSeat = `${SN[ctx.dealer]}(${ctx.dealer})`
  const offTiles = ['1万', '2万', '3万', '4万']
  const seatTiles = SEATS.map((s, i) => {
    const off = (i - SEATS.indexOf(ctx.dealer) + 4) % 4
    return `${SN[s]}家=${offTiles[off]}`
  }).join('，')
  return `你是广东麻将记账助手。把用户口述的一局结果抽取成 JSON，只输出一个 JSON 对象，不要解释、不要 Markdown 代码块。

【本桌固定规则】4 人，座位东/南/西/北对应 E/S/W/N。没有点炮，所有胡牌都是自摸。
【当前座位昵称】${seats}
【当前庄家】${dealerSeat}

【本桌摸马规则】胡牌后摸马，张数随有无鬼变：有鬼摸 4 张、硬胡（没鬼）摸 6 张。
计分只看赢家自己的马（马牌映射到自己座位的牌），其他座位的马不计；自马加成由系统按桌规自动算，你不要算分。
仍然把口述的所有「中马」马牌牌面放进 horses，没中或不确定的不要放；horses 不得超过该局摸马张数。

【必须严格按此结构输出】
{
  "winner": "E",
  "zhaHu": null,
  "pattern": "鸡胡",
  "hasGhost": true,
  "horses": ["5万", "红中"],
  "gangEvents": [],
  "ghostEvents": []
}
字段说明：
- winner：胡牌者座位，只能是 E/S/W/N；可用昵称或方位词，我会自行换算。炸胡局必须给 null。
- zhaHu：炸胡（诈胡/炸糊）者的座位，口述提到「炸胡/诈胡/查牌没胡成」时给出；正常局必须给 null。
- pattern：胡法档位名，只能从下面合法列表里选一个，不要自造、不要叠加。炸胡局给「报出的那个胡法」。
- hasGhost：true=有鬼（摸 4 张马），false=硬胡/没鬼（分数×2，摸 6 张马）。
- horses：本局「中马」的马牌牌面数组；有鬼最多 4 张、硬胡最多 6 张；炸胡局必须给 []（没有赢家不摸马）。
- gangEvents：本局杠分数组，元素形如 {"type":"an","by":"E"}；type 只能是 an(暗杠)/bu(补杠)/dian(点杠)；点杠必须额外给 "from"（放杠者座位）。没有杠就给 []。
- ghostEvents：本局打鬼数组，元素形如 {"by":"E"}，by=打出鬼牌者的座位；口述「打鬼/打出鬼牌」且能确定是谁就记一条，一局可多条。没提就给 []。

【合法胡法名（共 ${ALL_PATTERNS.length} 个，只能用这些）】
${ALL_PATTERNS.join('、')}

【马牌牌面】1万-9万、1条-9条、1筒-9筒、东风、南风、西风、北风、红中、发财、白板。
若口述直接说「中马的是南家和西家」这类座位而不是牌面，请按当前庄家换算成等价牌面：${seatTiles}。

【重要】只抽取字段，绝对不要计算或输出任何分数。信息缺失时 hasGhost 默认 true、horses 默认 []、gangEvents 默认 []、ghostEvents 默认 []；正常局 winner 与 pattern 必须给出，炸胡局 zhaHu 与 pattern 必须给出（winner=null、horses=[]）；实在无法确定就设为 null。

【口述】`
}

/** 规则模式：确定性关键词抽取（兜底，允许不完美，但一定如实标注） */
function parseWithRules(rawText, ctx) {
  const t = String(rawText).replace(/\s+/g, ' ')
  const warnings = ['规则模式：仅按关键词抽取，请务必核对下方结果']

  const cands = []
  for (const s of SEATS) {
    const nick = String(ctx.players?.[s]?.nickname || '').trim()
    if (nick) cands.push({ w: nick, s })
    cands.push({ w: `${SN[s]}家`, s }, { w: SN[s], s })
  }
  cands.sort((a, b) => b.w.length - a.w.length)

  // v1.9 炸胡（诈胡）：口述提到炸胡时不找赢家，找炸胡者
  const zhaMatch = /(炸胡|诈胡|炸糊)/.exec(t)
  let zhaSeat = null
  if (zhaMatch) {
    const around = t.slice(Math.max(0, zhaMatch.index - 10), zhaMatch.index + 12)
    for (const c of cands) { if (around.includes(c.w)) { zhaSeat = c.s; break } }
    if (!zhaSeat) warnings.push('口述提到炸胡，规则模式无法确定是谁炸胡，请在表单手动选择')
  }

  const best = zhaMatch
    ? null
    : (() => {
        let best = null
        for (const c of cands) {
          let from = 0
          let idx
          while ((idx = t.indexOf(c.w, from)) >= 0) {
            const after = t.slice(idx + c.w.length, idx + c.w.length + 6)
            const before = t.slice(Math.max(0, idx - 8), idx)
            if (/自摸|胡了|胡牌|和了|胡/.test(after) || /自摸的是|胡的是|赢家|谁胡|这把|这局|本局/.test(before)) {
              if (!best || idx < best.idx) best = { idx, s: c.s, word: c.w }
              break
            }
            from = idx + c.w.length
          }
        }
        return best
      })()

  const candidates = [...ALL_PATTERNS, ...Object.keys(PATTERN_SYNONYM)].sort((a, b) => b.length - a.length)
  const hit = candidates.find((p) => t.includes(p))
  const pattern = hit ? (ALL_PATTERNS.includes(hit) ? hit : PATTERN_SYNONYM[hit]) : null

  let hasGhost = null
  if (/硬胡|无鬼|没鬼|没有鬼|无鬼牌|没鬼牌|无赖子|没赖子/.test(t)) hasGhost = false
  else if (/有鬼|带鬼|有鬼牌|有赖子|有混/.test(t)) hasGhost = true

  let horses = []
  if (!/没中马|无马|不中马|马没中|没有马|没摸马|没开马|不开马/.test(t)) {
    const tileRe = /([1-9][万条筒])|(红中|发财|白板|东风|南风|西风|北风)/g
    const found = []
    let m
    while ((m = tileRe.exec(t))) found.push(m[0])
    if (found.length) horses = found
    else if (/中马|马牌|摸马|开马|买马/.test(t)) {
      const seg = (/(?:中马|马牌?|摸马|开马|买马)[^，。；]{0,24}/.exec(t) || [''])[0]
      const seatRe = /([东南西北])(?:家|风)?/g
      let sm
      while ((sm = seatRe.exec(seg))) {
        const s = { 东: 'E', 南: 'S', 西: 'W', 北: 'N' }[sm[1]]
        if (s) horses.push(tileForSeat(s, ctx.dealer))
      }
    }
  }

  const gangEvents = []
  const gre = /(暗杠|补杠|加杠|点杠|明杠)/g
  let gm
  while ((gm = gre.exec(t))) {
    const type = resolveGangType(gm[1])
    const around = t.slice(Math.max(0, gm.index - 8), gm.index + 8)
    let by = null
    for (const c of cands) { if (around.includes(c.w)) { by = c.s; break } }
    if (!by || !type) continue
    if (type === 'dian') { warnings.push('点杠需指定放杠者，规则模式已忽略该条'); continue }
    gangEvents.push({ type, by })
  }

  const ghostEvents = []
  const ghostRe = /打鬼|打出鬼牌|鬼牌打出/g
  if (ghostRe.test(t)) {
    warnings.push('口述提到打鬼罚分，规则模式无法确定是谁打的鬼，请在表单「打鬼罚分」里手动补充')
  }

  return validateAndNormalize(
    { winner: best?.word ?? null, zhaHu: zhaSeat, pattern, hasGhost, horses, gangEvents, ghostEvents },
    ctx, 'rules', warnings
  )
}

/** 入口：有配置走 LLM，失败降级规则模式；校验失败不静默吞掉 */
export async function parseRound(text, ctx) {
  const cfg = getConfig()
  if (!cfg.configured) {
    const r = parseWithRules(text, ctx)
    r.warnings.unshift(cfg.source === 'none' ? '尚未配置 LLM，使用规则模式' : 'LLM 已停用，使用规则模式')
    return r
  }
  let obj
  try {
    const content = await chat([
      { role: 'system', content: '你是广东麻将记账助手，只做信息抽取，绝不计算分数。只输出一个 JSON 对象。' },
      { role: 'user', content: buildPrompt(ctx) + String(text) },
    ])
    obj = extractJson(content)
  } catch (e) {
    const r = parseWithRules(text, ctx)
    r.warnings.unshift(`LLM 不可用，已降级规则模式：${e.message}`)
    return r
  }
  return validateAndNormalize(obj, ctx, 'llm')
}
