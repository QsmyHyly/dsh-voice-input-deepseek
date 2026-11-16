/**
 * 宿主半路由的离线验证：用一个本地假 DeepSeek ASR 服务替换上游，检查
 * 1) /config 路由返回内容；2) 合法 WAV 的完整转发（鉴权头、multipart 的 file 字段、响应解析）；
 * 3) 坏 WAV / 超长 WAV / 未配置 Key 的失败路径。
 *
 * 用法：npm test（或 node test/host-route.test.mjs）
 */
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const modulePath = join(here, '..', 'lib', 'index.js')
const plugin = await import(`file:///${modulePath.replace(/\\/gu, '/')}`)

assert.equal(typeof plugin.apply, 'function', 'host plugin exports apply()')

/** 收集上游收到的请求，供断言使用。 */
const seen = []
const upstream = createServer((req, res) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    const body = Buffer.concat(chunks)
    seen.push({ url: req.url, authorization: req.headers.authorization, contentType: req.headers['content-type'], body })
    const text = body.toString('latin1')
    if (req.headers.authorization !== 'Bearer test-key') {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'bad key', code: 'invalid_request_error' } }))
      return
    }
    if (!text.includes('name="file"')) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'missing file field' } }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ request_id: 'req_test', text: '上海今天天气怎么样？', duration_ms: 3200 }))
  })
})
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
const port = upstream.address().port

/** 收集 apply() 注册的路由。 */
const routes = new Map()
const stubCtx = {
  effect: (fn) => {
    fn()
  },
  get: (name) => {
    if (name === 'connection') return { requestRejection: () => undefined }
    if (name === 'credentials') {
      return {
        resolve: async (ref) => (ref === 'DEEPSEEK_API_KEY' ? { value: 'test-key', source: 'file' } : undefined),
        describe: async () => ({ configured: true })
      }
    }
    return undefined
  },
  webServer: {
    register: (route) => {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    }
  }
}

const config = {
  baseURL: `http://127.0.0.1:${port}/v1/tools`,
  maxDurationSeconds: 120,
  maxAudioBytes: 8 * 1024 * 1024,
  requestTimeoutMs: 10000
}
plugin.apply(stubCtx, config)
assert.ok(routes.has('/api/voice-input-deepseek/config'), 'config route registered')
assert.ok(routes.has('/api/voice-input-deepseek/asr'), 'asr route registered')

/** 极简的请求/响应替身。 */
function fakeExchange(method, body) {
  const req = Readable.from(body === undefined ? [] : [body])
  req.method = method
  req.socket = { remoteAddress: '127.0.0.1' }
  const captured = { status: 0, headers: {}, body: '' }
  const res = {
    writeHead(status, headers) {
      captured.status = status
      captured.headers = headers ?? {}
    },
    end(text) {
      captured.body = text ?? ''
      captured.done = true
    }
  }
  return { req, res, captured }
}

async function call(method, body) {
  const { req, res, captured } = fakeExchange(method, body)
  const handler = routes.get('/api/voice-input-deepseek/asr').handler
  await handler(req, res)
  return captured
}

/** 生成一段 16 kHz 单声道 PCM16 WAV。 */
function makeWave(seconds, sampleRate = 16000) {
  const samples = Math.max(1, Math.floor(seconds * sampleRate))
  const data = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i += 1) data.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / sampleRate)), i * 2)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

let failures = 0
async function check(name, fn) {
  try {
    await fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : error}`)
  }
}

await check('config 路由返回上限与凭据状态', async () => {
  const { req, res, captured } = fakeExchange('GET')
  await routes.get('/api/voice-input-deepseek/config').handler(req, res)
  assert.equal(captured.status, 200)
  const body = JSON.parse(captured.body)
  assert.equal(body.ok, true)
  assert.equal(body.maxDurationSeconds, 120)
  assert.equal(body.credentialReady, true)
})

await check('合法 WAV 完整转发并回传文本', async () => {
  const captured = await call('POST', makeWave(2))
  assert.equal(captured.status, 200, captured.body)
  const body = JSON.parse(captured.body)
  assert.equal(body.ok, true)
  assert.equal(body.text, '上海今天天气怎么样？')
  assert.equal(body.requestId, 'req_test')
  assert.equal(body.audioSeconds, 2)
  const last = seen.at(-1)
  assert.equal(last.url, '/v1/tools/asr')
  assert.equal(last.authorization, 'Bearer test-key')
  assert.match(last.contentType, /^multipart\/form-data; boundary=/u)
  assert.ok(last.body.includes('name="file"'))
  assert.ok(last.body.toString('latin1').includes('RIFF'), 'WAV bytes forwarded')
})

await check('坏 WAV 返回 400 invalid-audio', async () => {
  const captured = await call('POST', Buffer.from('not a wav at all'))
  assert.equal(captured.status, 400)
  assert.equal(JSON.parse(captured.body).error.code, 'invalid-audio')
})

await check('超过 120 秒返回 400 too-long', async () => {
  const captured = await call('POST', makeWave(130))
  assert.equal(captured.status, 400)
  assert.equal(JSON.parse(captured.body).error.code, 'too-long')
})

await check('未配置 Key 返回 401 credential-missing 并给引导', async () => {
  const barePluginPath = `file:///${modulePath.replace(/\\/gu, '/')}?bare`
  const bare = await import(barePluginPath)
  const bareRoutes = new Map()
  bare.apply(
    {
      effect: (fn) => {
        fn()
      },
      get: (name) => {
        if (name === 'connection') return { requestRejection: () => undefined }
        if (name === 'credentials') return { resolve: async () => undefined, describe: async () => ({ configured: false }) }
        return undefined
      },
      webServer: {
        register: (route) => {
          bareRoutes.set(route.path, route)
          return () => {}
        }
      }
    },
    { ...config, apiKeyEnv: 'DEEPSEEK_API_KEY' }
  )
  const { req, res, captured } = fakeExchange('POST', makeWave(1))
  await bareRoutes.get('/api/voice-input-deepseek/asr').handler(req, res)
  assert.equal(captured.status, 401)
  const body = JSON.parse(captured.body)
  assert.equal(body.error.code, 'credential-missing')
  assert.match(body.error.message, /设置 → 模型/u)
})

await check('上游拒绝 Key 时给出可操作提示', async () => {
  const badKeyPlugin = await import(`file:///${modulePath.replace(/\\/gu, '/')}?badkey`)
  const badRoutes = new Map()
  badKeyPlugin.apply(
    {
      effect: (fn) => {
        fn()
      },
      get: (name) => {
        if (name === 'connection') return { requestRejection: () => undefined }
        if (name === 'credentials') return { resolve: async () => ({ value: 'wrong-key' }), describe: async () => ({ configured: true }) }
        return undefined
      },
      webServer: {
        register: (route) => {
          badRoutes.set(route.path, route)
          return () => {}
        }
      }
    },
    config
  )
  const { req, res, captured } = fakeExchange('POST', makeWave(1))
  await badRoutes.get('/api/voice-input-deepseek/asr').handler(req, res)
  assert.equal(captured.status, 401)
  assert.equal(JSON.parse(captured.body).error.code, 'upstream-auth')
})

await new Promise((resolve) => upstream.close(resolve))
if (failures > 0) {
  console.error(`\n${failures} 项失败`)
  process.exit(1)
}
console.log('\n全部通过')

