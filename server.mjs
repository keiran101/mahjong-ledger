/**
 * 麻将记账 · 单端口 HTTP 服务
 * 启动：node --experimental-sqlite --experimental-strip-types server.mjs
 * 监听 PORT（默认 3000）并绑定 0.0.0.0，供发布为在线应用。
 */
import http from 'node:http'
import { readFileSync, statSync } from 'node:fs'
import { join, dirname, extname, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RULES, SEATS } from './lib/rules.ts'
import { scoreRound } from './lib/score.ts'
import {
  createRoom, roomExists, fullState, getRoomMeta, setPlayerName, setDealer,
  appendScore, correctEvent, voidEvent,
} from './lib/store.mjs'
import { getConfig, saveConfig, testConnection } from './lib/llm.mjs'
import { parseRound } from './lib/parse.mjs'
import { getVlmConfig, saveVlmConfig } from './lib/vlm.mjs'
import { recognizeHand } from './lib/vision.mjs'

const ROOT = dirname(fileURLToPath(import.meta.url))
const PUBLIC = join(ROOT, 'public')
const PORT = Number(process.env.PORT) || 3000

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  })
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body))
}

function fail(res, status, msg) {
  send(res, status, { error: msg })
}

async function readBody(req, maxBytes = 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > maxBytes) throw new Error('请求体过大')
    chunks.push(c)
  }
  if (!chunks.length) return {}
  const raw = Buffer.concat(chunks).toString('utf8')
  try { return JSON.parse(raw) } catch { throw new Error('JSON 格式错误') }
}

const patterns = () => RULES.scoreTable.map((t) => ({
  times: t.times,
  withGhost: t.withGhost,
  withoutGhost: t.withoutGhost,
  patterns: t.patterns,
}))

function ruleMeta() {
  return {
    baseUnit: RULES.baseUnit,
    hardMultiplier: RULES.hardMultiplier,
    // 摸马张数随有无鬼变：有鬼 4 张、没鬼（硬胡）6 张
    horseCount: RULES.horse.countByGhost,
    unitPrice: RULES.unitPrice,
    seats: SEATS,
    patterns: patterns(),
  }
}

/** 校验并规范化记分输入，服务端始终用房间当前庄家，不信任前端传入 */
function normalizeInput(code, body) {
  const meta = getRoomMeta(code)
  if (!meta) throw new Error('房间不存在')
  const winner = body.winner
  if (!SEATS.includes(winner)) throw new Error('请选择胡牌玩家')
  const pattern = String(body.pattern || '').trim()
  if (!pattern) throw new Error('请选择胡法')
  const hasGhost = body.hasGhost !== false
  const horses = Array.isArray(body.horses) ? body.horses.filter((x) => x && String(x).trim()).map((x) => String(x).trim()) : []
  const gangEvents = Array.isArray(body.gangEvents) ? body.gangEvents.map((g) => {
    if (!['dian', 'bu', 'an'].includes(g.type)) throw new Error('无效杠类型')
    if (!SEATS.includes(g.by)) throw new Error('无效杠牌玩家')
    if (g.type === 'dian' && !SEATS.includes(g.from)) throw new Error('点杠需选择放杠者')
    return { type: g.type, by: g.by, from: g.from }
  }) : []
  return { winner, dealer: meta.dealer, pattern, hasGhost, horses, gangEvents }
}

async function handleApi(req, res, pathname) {
  const parts = pathname.split('/').filter(Boolean) // ['api', ...]
  const method = req.method

  if (method === 'OPTIONS') return send(res, 204, '')
  if (pathname === '/api/health') return send(res, 200, { ok: true, baseUnit: RULES.baseUnit })
  if (pathname === '/api/rules' && method === 'GET') return send(res, 200, ruleMeta())

  // LLM 配置：密钥只进不出，GET 不返回密钥
  if (pathname === '/api/llm-config' && method === 'GET') return send(res, 200, getConfig())
  if (pathname === '/api/llm-config' && method === 'POST') {
    const b = await readBody(req)
    return send(res, 200, saveConfig(b))
  }
  if (pathname === '/api/llm-config/test' && method === 'POST') {
    try { return send(res, 200, await testConnection()) }
    catch (e) { return fail(res, 400, e.message) }
  }

  if (pathname === '/api/vlm-config' && method === 'GET') return send(res, 200, getVlmConfig())
  if (pathname === '/api/vlm-config' && method === 'POST') {
    const b = await readBody(req)
    return send(res, 200, saveVlmConfig(b))
  }

  // 创建房间
  if (pathname === '/api/rooms' && method === 'POST') {
    const b = await readBody(req)
    const code = createRoom({ name: b.name, nicknames: b.nicknames })
    return send(res, 200, { code, ...fullState(code) })
  }

  if (parts[0] === 'api' && parts[1] === 'rooms' && parts[2]) {
    const code = parts[2].toUpperCase()
    if (!roomExists(code)) return fail(res, 404, '房间不存在，请核对房间码')
    const tail = parts.slice(3)

    if (!tail.length && method === 'GET') {
      return send(res, 200, { ...fullState(code), rules: ruleMeta() })
    }

    if (tail[0] === 'player' && method === 'POST') {
      const b = await readBody(req)
      setPlayerName(code, b.seat, b.nickname)
      return send(res, 200, fullState(code))
    }

    if (tail[0] === 'dealer' && method === 'POST') {
      const b = await readBody(req)
      setDealer(code, b.dealer)
      return send(res, 200, fullState(code))
    }

    // 拍照认牌：只返回待确认草稿，绝不算分
    if (tail[0] === 'vision' && method === 'POST') {
      const b = await readBody(req, 5.5 * 1024 * 1024)
      const image = String(b.image || '')
      if (!/^data:image\/(jpeg|jpg|png|webp);base64,/i.test(image)) {
        throw new Error('请上传 jpeg / png / webp 照片')
      }
      const photographer = SEATS.includes(b.photographer) ? b.photographer : null
      const state = fullState(code)
      const result = await recognizeHand(image, {
        dealer: state.dealer,
        photographer,
        players: state.players,
      })
      if (result.draft && ('perPlayer' in result.draft || 'detail' in result.draft)) {
        throw new Error('内部错误：识别通道不得附带分数')
      }
      return send(res, 200, result)
    }

    // 语音/文字解析：自然语言 → 结构化字段 → 复用计分纯函数（只预览，不落账）
    if (tail[0] === 'parse' && method === 'POST') {
      const b = await readBody(req)
      const text = String(b.text || '').trim()
      if (!text) throw new Error('请先输入这一局的结果')
      if (text.length > 300) throw new Error('文字请精简到 300 字以内')
      const state = fullState(code)
      const parsed = await parseRound(text, { dealer: state.dealer, players: state.players })
      const input = normalizeInput(code, parsed.input)
      const detail = scoreRound(input)
      return send(res, 200, {
        mode: parsed.mode, notes: parsed.notes, warnings: parsed.warnings,
        input, detail,
      })
    }

    // 算分预览：不落账
    if (tail[0] === 'preview' && method === 'POST') {
      const b = await readBody(req)
      const input = normalizeInput(code, b)
      const detail = scoreRound(input)
      return send(res, 200, { detail, input })
    }

    // 落账：服务端重算，可选手改覆盖
    if (tail[0] === 'events' && !tail[1] && method === 'POST') {
      const b = await readBody(req)
      const input = normalizeInput(code, b)
      const detail = scoreRound(input)
      let net = detail.perPlayer
      if (b.manualOverride && Object.keys(b.manualOverride).length) {
        const clean = {}
        for (const s of SEATS) {
          const v = Number(b.manualOverride[s])
          if (!Number.isFinite(v)) throw new Error('手改分数必须是数字')
          clean[s] = v
        }
        net = clean
      }
      const sum = SEATS.reduce((a, s) => a + net[s], 0)
      if (sum !== 0) throw new Error(`四家分数之和必须为 0，当前为 ${sum}`)
      const payload = { input, detail: { ...detail, perPlayer: net, isManual: net !== detail.perPlayer }, net }
      const id = appendScore(code, { payload, author: String(b.author || '').slice(0, 12) })
      return send(res, 200, { id, ...fullState(code) })
    }

    if (tail[0] === 'events' && tail[1] && tail[2] === 'correct' && method === 'POST') {
      const b = await readBody(req)
      const sum = SEATS.reduce((a, s) => a + (Number(b.net?.[s]) || 0), 0)
      if (sum !== 0) throw new Error(`四家分数之和必须为 0，当前为 ${sum}`)
      correctEvent(code, Number(tail[1]), b.net, String(b.author || ''))
      return send(res, 200, fullState(code))
    }

    if (tail[0] === 'events' && tail[1] && tail[2] === 'void' && method === 'POST') {
      const b = await readBody(req)
      voidEvent(code, Number(tail[1]), String(b.author || ''))
      return send(res, 200, fullState(code))
    }
  }

  return fail(res, 404, '接口不存在')
}

function serveStatic(res, pathname) {
  let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  rel = normalize(rel).replace(/^(\.\.[/\\])+/, '')
  const file = join(PUBLIC, rel)
  if (!file.startsWith(PUBLIC)) return fail(res, 403, '禁止访问')
  try {
    if (!statSync(file).isFile()) throw new Error('not file')
    const buf = readFileSync(file)
    return send(res, 200, buf, MIME[extname(file)] || 'application/octet-stream')
  } catch {
    // 单页应用：未知路径回首页
    try {
      return send(res, 200, readFileSync(join(PUBLIC, 'index.html')), MIME['.html'])
    } catch {
      return fail(res, 404, '页面不存在')
    }
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname
    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname)
    return serveStatic(res, pathname)
  } catch (err) {
    console.error('[error]', err.message)
    return fail(res, 400, err.message || '服务异常')
  }
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`麻将记账服务已启动: http://0.0.0.0:${PORT}`)
})
