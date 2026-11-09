/**
 * Qwen3.7 视觉调用（独立于 lib/llm.mjs 的文本通道）。
 *
 * 只负责把「图片 + 提示词」发给通义千问多模态接口，返回文本。
 * 不解析麻将、不算分。密钥只留服务端。
 *
 * 配置优先级：
 *   1. 环境变量 MJ_VLM_API_KEY / MJ_VLM_BASE_URL / MJ_VLM_MODEL
 *   2. data/vlm-config.json
 *   3. 若文本 LLM 配的是通义/DashScope，复用其 Key，模型仍用 qwen3.7-plus
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { secretConfig as secretLlmConfig } from './llm.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DATA_DIR = join(ROOT, 'data')
const CONF_PATH = process.env.MJ_VLM_CONF || join(DATA_DIR, 'vlm-config.json')

export const VLM_DEFAULTS = {
  label: '通义千问 Qwen3.7',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  model: 'qwen3.7-plus',
}

function envConfig() {
  const apiKey = (process.env.MJ_VLM_API_KEY || '').trim()
  if (!apiKey) return null
  return {
    enabled: process.env.MJ_VLM_DISABLED !== '1',
    baseUrl: (process.env.MJ_VLM_BASE_URL || VLM_DEFAULTS.baseUrl).trim(),
    model: (process.env.MJ_VLM_MODEL || VLM_DEFAULTS.model).trim(),
    apiKey,
    source: 'env',
  }
}

function fileConfig() {
  try {
    if (!existsSync(CONF_PATH)) return null
    const c = JSON.parse(readFileSync(CONF_PATH, 'utf8'))
    if (!c || typeof c !== 'object') return null
    return {
      enabled: c.enabled !== false,
      baseUrl: String(c.baseUrl || VLM_DEFAULTS.baseUrl).trim(),
      model: String(c.model || VLM_DEFAULTS.model).trim(),
      apiKey: String(c.apiKey || '').trim(),
      source: 'file',
    }
  } catch {
    return null
  }
}

function fallbackFromLlm() {
  const llm = secretLlmConfig()
  if (!llm || !llm.apiKey || llm.enabled === false) return null
  const url = String(llm.baseUrl || '')
  const isDash = llm.provider === 'qwen' || /dashscope/i.test(url)
  if (!isDash) return null
  return {
    enabled: true,
    baseUrl: url || VLM_DEFAULTS.baseUrl,
    model: VLM_DEFAULTS.model,
    apiKey: llm.apiKey,
    source: 'llm',
  }
}

export function secretVlmConfig() {
  return envConfig() || fileConfig() || fallbackFromLlm()
}

export function getVlmConfig() {
  const c = secretVlmConfig()
  if (!c) {
    return {
      configured: false, enabled: false, source: 'none',
      baseUrl: VLM_DEFAULTS.baseUrl, model: VLM_DEFAULTS.model, hasKey: false,
      defaults: VLM_DEFAULTS,
    }
  }
  return {
    configured: !!(c.enabled && c.apiKey && c.baseUrl && c.model),
    enabled: c.enabled,
    source: c.source,
    baseUrl: c.baseUrl,
    model: c.model,
    hasKey: !!c.apiKey,
    defaults: VLM_DEFAULTS,
  }
}

export function saveVlmConfig(body = {}) {
  if (envConfig()) throw new Error('拍照识别密钥由服务端环境变量提供，需在服务端修改')
  const old = fileConfig() || {}
  const baseUrl = String(body.baseUrl ?? old.baseUrl ?? VLM_DEFAULTS.baseUrl).trim().replace(/\/+$/, '')
  const model = String(body.model ?? old.model ?? VLM_DEFAULTS.model).trim()
  const keyRaw = body.apiKey
  const apiKey = (keyRaw === undefined || keyRaw === null || String(keyRaw).trim() === '')
    ? (old.apiKey || '')
    : String(keyRaw).trim()
  const enabled = body.enabled === undefined ? (old.enabled !== false) : !!body.enabled
  if (baseUrl && !/^https?:\/\//i.test(baseUrl)) throw new Error('接口地址需以 http:// 或 https:// 开头')
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(CONF_PATH, JSON.stringify({
    enabled, baseUrl: baseUrl || VLM_DEFAULTS.baseUrl, model: model || VLM_DEFAULTS.model, apiKey,
  }, null, 2), 'utf8')
  return getVlmConfig()
}

function contentToText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((p) => {
      if (typeof p === 'string') return p
      return String(p?.text || p?.content || '')
    }).join('')
  }
  if (content && typeof content === 'object') return String(content.text || '')
  return ''
}

/**
 * 新的视觉调用：OpenAI 兼容 /chat/completions + image_url。
 * 强制关闭 thinking，只要结构化读牌结果。
 */
export async function chatVision({ imageDataUrl, prompt, system, temperature = 0, maxTokens = 2500, timeout = 90000 } = {}) {
  const c = secretVlmConfig()
  if (!c || !c.enabled || !c.apiKey) throw new Error('尚未配置 Qwen3.7 拍照识别（请在设置里填通义千问 Key，或设置 MJ_VLM_API_KEY）')
  if (!imageDataUrl || !String(imageDataUrl).startsWith('data:image/')) {
    throw new Error('请提供一张照片')
  }
  const url = `${c.baseUrl.replace(/\/+$/, '')}/chat/completions`
  const userContent = [
    { type: 'image_url', image_url: { url: String(imageDataUrl) } },
    { type: 'text', text: String(prompt || '') },
  ]
  const messages = []
  if (system) messages.push({ role: 'system', content: String(system) })
  messages.push({ role: 'user', content: userContent })

  let r
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${c.apiKey}`,
      },
      body: JSON.stringify({
        model: c.model,
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: false,
        enable_thinking: false,
      }),
      signal: AbortSignal.timeout(timeout),
    })
  } catch (e) {
    const why = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? '请求超时' : (e?.message || '网络不通')
    throw new Error(`拍照识别连接失败：${why}`)
  }
  if (!r.ok) {
    const t = (await r.text().catch(() => '')).slice(0, 240)
    throw new Error(`拍照识别返回 ${r.status}：${t}`)
  }
  let j
  try { j = await r.json() } catch { throw new Error('拍照识别返回不是合法 JSON') }
  const msg = j?.choices?.[0]?.message
  const text = contentToText(msg?.content) || contentToText(msg?.reasoning_content)
  if (!String(text).trim()) throw new Error('拍照识别返回内容为空')
  return { text: String(text).trim(), model: c.model }
}
