/**
 * DeepSeek 语音输入 —— 宿主半。
 *
 * 职责：在 dsh 的 host Web 服务器上暴露两个同源路由，把浏览器录好的 16 kHz 单声道
 * PCM16 WAV 转发给 DeepSeek 官方语音识别接口，并把识别文本回给浏览器。
 *
 * 边界：
 * - 不落盘、不写 Session：音频是临时数据，只在内存里存活一次请求；识别文本由用户在
 *   输入框里确认后，走普通提交进入会话。
 * - 鉴权顺序：先过 dsh 自带的 Host/Origin/cookie 栅栏（`connection.requestRejection`），
 *   再取上游凭证。上游 DeepSeek ASR 目前只认平台 API Key（`Authorization: Bearer sk-…`），
 *   账号登录令牌（`x-dsh-auth-token`）实测会被 401 拒绝，因此仅在没配 Key 时兜底尝试。
 * - 上限对齐官方文档：单文件 ≤ 8 MiB、时长 ≤ 120 秒（默认值，可在插件 config 里调小）。
 *
 * @doc https://api-docs.deepseek.com/zh-cn/api/asr
 * @doc https://api-docs.deepseek.com/zh-cn/guides/asr
 */

/** 本插件在 Loader 里的名字。 */
export const name = 'voice-input-deepseek'

/** 依赖的宿主服务：Web 服务器与连接鉴权。 */
export const inject = ['webServer']

const ROUTE_PREFIX = '/api/voice-input-deepseek'
const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1/tools'
const DEFAULT_API_KEY_REF = 'DEEPSEEK_API_KEY'
/**
 * 依次尝试的凭据引用名。
 *
 * 设置页「Models」给某个 provider 填 Key 时，会按 provider 路由派生引用名
 * （`@deepseek-ai/dsh-client-ui-settings-models` 的 `deriveKeyRef`），例如 DeepSeek 官方
 * 路由写的是 `DEEPSEEK_OFFICIAL_API_KEY`，而模型适配器自己的默认值是 `DEEPSEEK_API_KEY`。
 * 两个都查一遍，用户不管从哪条路填的 Key 都能被本插件读到。
 */
const API_KEY_REFS = [DEFAULT_API_KEY_REF, 'DEEPSEEK_OFFICIAL_API_KEY', 'DEEPSEEK_ACCOUNT_API_KEY']
const ACCOUNT_TOKEN_HEADER = 'x-dsh-auth-token'
/** WAV 里允许的采样率，来自官方文档。 */
const ALLOWED_SAMPLE_RATES = new Set([8000, 16000, 22050, 24000, 32000, 44100, 48000])
/** 官方上限：8 MiB。 */
const UPSTREAM_MAX_BYTES = 8 * 1024 * 1024

/** 面向用户的失败：带上 HTTP 状态码与稳定错误码。 */
class RouteError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

/**
 * 配置项（默认值在代码里兜底；本插件故意不声明 schemastery Config，避免本地 link 安装的包
 * 去解析 dsh 安装目录里的内部包）：
 * - baseURL            官方接口基地址，默认 https://api.deepseek.com/v1/tools
 * - apiKey             直接写死平台 API Key（可选，优先用凭据服务）
 * - apiKeyEnv          凭据服务里的引用名，默认 DEEPSEEK_API_KEY
 * - maxDurationSeconds 录音上限，默认 120
 * - maxAudioBytes      上传字节上限，默认 8388608
 * - requestTimeoutMs   单次上游超时，默认 60000
 */

/** 读 config 字段：volatile 字段是 getter。 */
function readValue(field) {
  return typeof field?.get === 'function' ? field.get() : field
}

/** 统一 JSON 响应。 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store'
  })
  res.end(text)
}

/** 把异常翻译成路由响应。 */
function fail(res, error) {
  if (error instanceof RouteError) {
    sendJson(res, error.status, { ok: false, error: { code: error.code, message: error.message } })
    return
  }
  const message = error instanceof Error ? error.message : String(error)
  sendJson(res, 500, { ok: false, error: { code: 'internal', message: `语音识别请求失败：${message}` } })
}

/**
 * dsh 自带的请求栅栏：Host 必须是 loopback / trustedHosts，浏览器必须持有已配对 cookie。
 * 走远程隧道时 Host 是公网域名，这里会直接 403，避免把本机麦克风和控制台的 Key 暴露出去。
 * @param ctx - 宿主上下文。
 * @param req - 原始 HTTP 请求。
 * @param res - 被拒绝时持有的响应。
 * @returns 已拒绝并写完响应时为 true。
 */
function rejected(ctx, req, res) {
  const connection = ctx.get('connection')
  if (connection !== undefined) {
    const rejection = connection.requestRejection(req)
    if (rejection === undefined) return false
    res.writeHead(rejection, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' })
    res.end(rejection === 403 ? 'forbidden: untrusted host or origin\n' : 'authentication required\n')
    return true
  }
  // 没有 connection 服务时退化成 loopback-only。
  const address = req.socket?.remoteAddress ?? ''
  const loopback = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
  if (loopback) return false
  res.writeHead(403, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' })
  res.end('forbidden: loopback only\n')
  return true
}

/** 限制请求体大小，超限抛 RouteError。 */
function readBoundedBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > limit) {
        // 不销毁 socket：先回 413 让浏览器拿到明确错误，剩余字节由 Node 丢弃。
        settled = true
        req.resume()
        reject(new RouteError(413, 'too-large', `录音超过上传上限（${Math.round(limit / (1024 * 1024))} MiB），请缩短录音。`))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks))
    })
    req.on('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
  })
}

/** 解析 16 位 PCM WAV 头并核对时长；格式不对直接报错。 */
function inspectWave(bytes, maxDurationSeconds) {
  if (bytes.length < 44) throw new RouteError(400, 'invalid-audio', '录音数据不完整，请重试。')
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    throw new RouteError(400, 'invalid-audio', '录音不是 WAV 格式，请重试。')
  }
  let offset = 12
  let format
  let dataLength
  while (offset + 8 <= bytes.length) {
    const chunkId = bytes.toString('ascii', offset, offset + 4)
    const chunkSize = bytes.readUInt32LE(offset + 4)
    const body = offset + 8
    if (chunkId === 'fmt ') {
      if (chunkSize < 16 || body + 16 > bytes.length) throw new RouteError(400, 'invalid-audio', '录音的 WAV 头不完整。')
      const channels = bytes.readUInt16LE(body + 2)
      const sampleRate = bytes.readUInt32LE(body + 4)
      const bitsPerSample = bytes.readUInt16LE(body + 14)
      format = { channels, sampleRate, bitsPerSample }
    } else if (chunkId === 'data') {
      dataLength = Math.min(chunkSize, bytes.length - body)
    }
    offset = body + chunkSize + (chunkSize % 2)
  }
  if (format === undefined || dataLength === undefined) throw new RouteError(400, 'invalid-audio', '录音缺少 WAV 音频数据。')
  if (format.bitsPerSample !== 16 || (format.channels !== 1 && format.channels !== 2)) {
    throw new RouteError(400, 'invalid-audio', '录音必须是 16 位 PCM 单声道或双声道 WAV。')
  }
  if (!ALLOWED_SAMPLE_RATES.has(format.sampleRate)) {
    throw new RouteError(400, 'invalid-audio', `录音采样率 ${format.sampleRate} Hz 不被支持。`)
  }
  const seconds = dataLength / (format.sampleRate * format.channels * 2)
  if (seconds > maxDurationSeconds + 0.25) {
    throw new RouteError(400, 'too-long', `录音时长 ${seconds.toFixed(1)} 秒超过上限 ${maxDurationSeconds} 秒。`)
  }
  return { seconds, ...format }
}

/** 上游端点。 */
function asrEndpoint(config) {
  return `${String(readValue(config.baseURL) || DEFAULT_BASE_URL).replace(/\/+$/u, '')}/asr`
}

/** 配置里显式指定的引用名排在最前，其余按约定顺序兜底。 */
function candidateRefs(config) {
  const configured = readValue(config.apiKeyEnv)
  const refs = typeof configured === 'string' && configured.length > 0 ? [configured] : []
  for (const ref of API_KEY_REFS) if (!refs.includes(ref)) refs.push(ref)
  return refs
}

/** 从凭据服务（含环境变量兜底）取平台 API Key。 */
async function resolveApiKey(ctx, config) {
  const literal = readValue(config.apiKey)
  if (typeof literal === 'string' && literal.length > 0) return literal
  const credentials = ctx.get('credentials')
  if (credentials === undefined) return undefined
  for (const reference of candidateRefs(config)) {
    const resolved = await credentials.resolve(reference)
    if (resolved !== undefined && resolved.value.length > 0) return resolved.value
  }
  return undefined
}

/** 账号登录令牌；只在没有 API Key 时兜底（ASR 目前不认它）。 */
async function resolveAccountToken(ctx, endpoint) {
  const account = ctx.get('deepseekAccount')
  if (account === undefined) return undefined
  try {
    const token = await account.resolveToken(endpoint)
    return typeof token === 'string' && token.length > 0 ? token : undefined
  } catch {
    return undefined
  }
}

/** 凭证是否已配置（只报状态，用来给按钮提前提示）。 */
async function credentialReady(ctx, config) {
  const literal = readValue(config.apiKey)
  if (typeof literal === 'string' && literal.length > 0) return true
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    for (const reference of candidateRefs(config)) {
      try {
        if ((await credentials.describe(reference)).configured) return true
      } catch {
        // 存储读不出来时按未配置处理，真实请求会给出明确错误。
      }
    }
  }
  return false
}

/** 调一次官方 ASR。 */
async function transcribeWithDeepSeek(ctx, config, bytes) {
  const endpoint = asrEndpoint(config)
  const apiKey = await resolveApiKey(ctx, config)
  let authorization
  if (apiKey !== undefined) {
    authorization = { authorization: `Bearer ${apiKey}` }
  } else {
    const token = await resolveAccountToken(ctx, endpoint)
    if (token === undefined) {
      throw new RouteError(
        401,
        'credential-missing',
        '还没有配置 DeepSeek API Key。请到「设置 → 模型」里填写 DeepSeek 平台 API Key（或设置 DEEPSEEK_API_KEY 环境变量）后重试。'
      )
    }
    authorization = { [ACCOUNT_TOKEN_HEADER]: token }
  }

  const form = new FormData()
  form.append('file', new Blob([bytes], { type: 'audio/wav' }), 'speech.wav')

  let response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { ...authorization, 'user-agent': 'deepseek-harness/0.0.1' },
      body: form,
      redirect: 'error',
      signal: AbortSignal.timeout(readValue(config.requestTimeoutMs) ?? 60000)
    })
  } catch (error) {
    if (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new RouteError(504, 'timeout', '语音识别超时，请稍后重试。')
    }
    throw new RouteError(502, 'network', `无法连接 DeepSeek 语音识别服务：${error instanceof Error ? error.message : String(error)}`)
  }

  if (!response.ok) {
    let detail = ''
    let upstreamCode = ''
    try {
      const parsed = await response.json()
      const error = parsed?.error
      detail = typeof error === 'string' ? error : typeof error?.message === 'string' ? error.message : ''
      upstreamCode = typeof error?.code === 'string' ? error.code : ''
    } catch {
      // 上游不是 JSON 时保留空详情。
    }
    if (response.status === 401) {
      throw new RouteError(
        401,
        'upstream-auth',
        `DeepSeek 拒绝了这个凭证（${detail || '401'}）。语音识别接口只接受平台 API Key（Bearer sk-…），账号登录令牌不行；请到「设置 → 模型」填写 API Key 后重试。`
      )
    }
    if (response.status === 429) throw new RouteError(429, 'busy', 'DeepSeek 语音识别并发已满，请稍后重试。')
    if (response.status === 413) throw new RouteError(413, 'too-large', '录音超过 DeepSeek 的 8 MiB 上限。')
    if (response.status === 408) throw new RouteError(408, 'upload-timeout', '上传录音超时，请重试。')
    throw new RouteError(
      response.status === 503 ? 503 : 502,
      'upstream',
      `DeepSeek 语音识别失败（HTTP ${response.status}${upstreamCode === '' ? '' : ` / ${upstreamCode}`}）${detail === '' ? '' : `：${detail}`}`
    )
  }

  const payload = await response.json().catch(() => undefined)
  if (payload === undefined || typeof payload.text !== 'string') {
    throw new RouteError(502, 'bad-response', 'DeepSeek 返回了无法解析的识别结果。')
  }
  return {
    text: payload.text,
    durationMs: typeof payload.duration_ms === 'number' ? payload.duration_ms : undefined,
    requestId: typeof payload.request_id === 'string' ? payload.request_id : undefined
  }
}

/**
 * 注册两个路由。两个都必须注册在 `ctx.effect` 里，插件卸载时自动摘除。
 * @param ctx - 宿主上下文。
 * @param config - 本插件的 Config。
 */
export function apply(ctx, config = {}) {
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/config`,
      handler: async (req, res) => {
        if (rejected(ctx, req, res)) return
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendJson(res, 405, { ok: false, error: { code: 'method', message: '只允许 GET。' } })
          return
        }
        try {
          const body = {
            ok: true,
            maxDurationSeconds: readValue(config.maxDurationSeconds) ?? 120,
            maxAudioBytes: Math.min(readValue(config.maxAudioBytes) ?? UPSTREAM_MAX_BYTES, UPSTREAM_MAX_BYTES),
            credentialReady: await credentialReady(ctx, config)
          }
          if (req.method === 'HEAD') {
            res.writeHead(200, { 'cache-control': 'no-store' })
            res.end()
            return
          }
          sendJson(res, 200, body)
        } catch (error) {
          fail(res, error)
        }
      }
    })
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/asr`,
      handler: async (req, res) => {
        if (rejected(ctx, req, res)) return
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: { code: 'method', message: '只允许 POST。' } })
          return
        }
        try {
          const limit = Math.min(readValue(config.maxAudioBytes) ?? UPSTREAM_MAX_BYTES, UPSTREAM_MAX_BYTES)
          const bytes = await readBoundedBody(req, limit)
          if (bytes.length === 0) throw new RouteError(400, 'empty', '没有收到录音数据。')
          const audio = inspectWave(bytes, readValue(config.maxDurationSeconds) ?? 120)
          const result = await transcribeWithDeepSeek(ctx, config, bytes)
          sendJson(res, 200, {
            ok: true,
            text: result.text,
            durationMs: result.durationMs,
            audioSeconds: Number(audio.seconds.toFixed(3)),
            requestId: result.requestId
          })
        } catch (error) {
          fail(res, error)
        }
      }
    })
  )
}
