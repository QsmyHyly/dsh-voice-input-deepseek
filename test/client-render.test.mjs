/**
 * 浏览器半的离线渲染测试：用最小 React/浏览器 API 替身驱动组件，验证
 * 1) 模块格式（__ModuleLoader__.load + factory + apply）；
 * 2) 槽注册与收起态麦克风按钮；
 * 3) 录音中真的渲染出「已录秒数/上限秒数」（15/120）；
 * 4) 到上限自动停止 → 调识别路由 → 文本插入输入框。
 *
 * 用法：npm test（或 node test/client-render.test.mjs）
 */
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'lib', 'client.js')

// ---------------------------------------------------------------- React 替身
let hooks = []
let cursor = 0
let dirty = false
let pendingEffects = []
let cleanups = new Map()
let rerender

const Fragment = Symbol('fragment')

function depsChanged(previous, next) {
  if (previous === undefined) return true
  if (next === undefined) return true
  if (previous.length !== next.length) return true
  return previous.some((value, index) => !Object.is(value, next[index]))
}

function createElement(type, props, ...children) {
  return { type, props: props ?? {}, children }
}
function useState(initial) {
  const index = cursor
  cursor += 1
  if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial
  const set = (next) => {
    hooks[index] = typeof next === 'function' ? next(hooks[index]) : next
    dirty = true
  }
  return [hooks[index], set]
}
function useRef(initial) {
  const index = cursor
  cursor += 1
  if (!(index in hooks)) hooks[index] = { current: initial }
  return hooks[index]
}
function useEffectImpl(effect, deps) {
  const index = cursor
  cursor += 1
  const previous = hooks[index]
  if (previous !== undefined && !depsChanged(previous.deps, deps)) return
  hooks[index] = { deps }
  pendingEffects.push({ index, effect })
}
function useCallback(callback, deps) {
  const index = cursor
  cursor += 1
  const previous = hooks[index]
  if (previous !== undefined && !depsChanged(previous.deps, deps)) return previous.callback
  hooks[index] = { deps, callback }
  return callback
}

const React = {
  createElement,
  Fragment,
  useState,
  useRef,
  useEffect: useEffectImpl,
  useLayoutEffect: useEffectImpl,
  useCallback
}

function renderTree(node) {
  if (node === null || node === undefined || node === false || node === true) return null
  if (Array.isArray(node)) return node.map(renderTree)
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (typeof node.type === 'function') return renderTree(node.type({ ...node.props, children: node.children }))
  return { tag: node.type, props: node.props, children: node.children.map(renderTree) }
}

function flatten(node, into = []) {
  if (node === null || node === undefined) return into
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, into)
    return into
  }
  if (typeof node === 'string') return into
  into.push(node)
  for (const child of node.children) flatten(child, into)
  return into
}

function textOf(node) {
  const parts = []
  const walk = (current) => {
    if (current === null || current === undefined) return
    if (typeof current === 'string') {
      parts.push(current)
      return
    }
    if (Array.isArray(current)) {
      current.forEach(walk)
      return
    }
    for (const child of current.children) walk(child)
  }
  walk(node)
  return parts.join('')
}

// ------------------------------------------------------- 浏览器 API 替身
let intervalCallback
let clearedIntervals = 0
let clock = 0
let inserted = []
let postedAudio

globalThis.window = {
  addEventListener() {},
  removeEventListener() {},
  __ModuleLoader__: { load(spec) {
    globalThis.__moduleSpec = spec
  } }
}
globalThis.document = {
  hidden: false,
  addEventListener() {},
  removeEventListener() {}
}
globalThis.performance = { now: () => clock }
globalThis.setInterval = (callback) => {
  intervalCallback = callback
  return 1
}
globalThis.clearInterval = () => {
  clearedIntervals += 1
  intervalCallback = undefined
}

class FakeRecorder {
  constructor(stream) {
    this.stream = stream
    this.state = 'inactive'
    this.mimeType = 'audio/webm'
  }
  start() {
    this.state = 'recording'
  }
  stop() {
    if (this.state === 'inactive') return
    this.state = 'inactive'
    this.ondataavailable?.({ data: { size: 4096 } })
    this.onstop?.()
  }
}
globalThis.MediaRecorder = FakeRecorder
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    mediaDevices: {
      getUserMedia: async () => ({
        getTracks: () => [],
        getAudioTracks: () => [{ addEventListener() {}, stop() {} }]
      })
    }
  }
})
globalThis.AudioContext = class {
  async decodeAudioData() {
    return { duration: 120 }
  }
  async close() {}
}
globalThis.OfflineAudioContext = class {
  constructor(channels, frames) {
    this.frames = frames
  }
  createBufferSource() {
    return { buffer: undefined, connect() {}, start() {} }
  }
  get destination() {
    return {}
  }
  async startRendering() {
    return { getChannelData: () => new Float32Array(this.frames) }
  }
}
globalThis.fetch = async (input, init) => {
  if (input === 'api/voice-input-deepseek/config') {
    return { ok: true, json: async () => ({ ok: true, maxDurationSeconds: 120, maxAudioBytes: 8388608, credentialReady: true }) }
  }
  if (input === 'api/voice-input-deepseek/asr') {
    postedAudio = init?.body
    return { ok: true, json: async () => ({ ok: true, text: '你好，这是识别结果', durationMs: 15000 }) }
  }
  throw new Error(`unexpected fetch ${String(input)}`)
}

// ------------------------------------------------------------ 加载模块
await import(`file:///${clientPath.replace(/\\/gu, '/')}`)
const spec = globalThis.__moduleSpec
assert.ok(spec, 'client bundle calls __ModuleLoader__.load')
assert.equal(spec.id, 'dsh-voice-input-deepseek')
const exported = spec.factory((name) => {
  assert.equal(name, 'react', 'client only requires react')
  return React
})
assert.deepEqual(exported.inject, ['slots', 'locale'])

const registrations = []
const localeDictionaries = []
const ctx = {
  effect: (fn) => {
    fn()
  },
  locale: {
    register: (ns, dicts) => {
      localeDictionaries.push({ ns, dicts })
      return () => {}
    }
  },
  slots: {
    inject: (slotName, callback) => {
      callback()
      return () => {}
    },
    register: (options, component) => {
      registrations.push({ options, component })
      return () => {}
    }
  }
}
exported.apply(ctx)
assert.equal(localeDictionaries.length, 1)
assert.equal(localeDictionaries[0].ns, 'voice-input-deepseek')
assert.ok(localeDictionaries[0].dicts.zh.dictate.length > 0)
assert.equal(registrations.length, 1)
assert.equal(registrations[0].options.name, 'conversation.input.activity')

const VoiceInput = registrations[0].component
const props = {
  sessionId: 'session-test',
  inputActions: {
    captureInsertion: () => ({ span: 'test' }),
    insertText: (text, span) => {
      inserted.push({ text, span })
      return true
    }
  },
  onActiveChange: () => {},
  locked: false,
  t: (key, values) => {
    const dict = {
      dictate: '语音输入（DeepSeek）',
      start: '开始录音',
      cancel: '取消录音',
      stop: '停止并识别',
      retry: '重新录音',
      requesting: '正在打开麦克风…',
      recording: '正在录音',
      sending: '正在识别…',
      insertAgain: '插入文本',
      needsKeyHint: '还没有配置 DeepSeek API Key',
      durationTitle: '已录 {elapsed} 秒，上限 {max} 秒',
      empty: '没有识别到文字，请重试。',
      conflict: '输入框内容已变化，文字没有插入。',
      permission: '没有麦克风权限',
      deviceMissing: '没有找到可用的麦克风。',
      unavailable: '当前环境不支持录音。',
      interrupted: '麦克风被中断，请重试。',
      failed: '语音输入失败：{message}'
    }
    let text = dict[key] ?? key
    if (values !== undefined) for (const [name, value] of Object.entries(values)) text = text.replaceAll(`{${name}}`, value)
    return text
  }
}

/** 同步渲染直到不再有状态更新。 */
function render() {
  let guard = 0
  dirty = true
  while (dirty && guard < 50) {
    dirty = false
    cursor = 0
    pendingEffects = []
    rerender = renderTree(VoiceInput(props))
    for (const { index, effect } of pendingEffects) {
      cleanups.get(index)?.()
      const cleanup = effect()
      cleanups.set(index, typeof cleanup === 'function' ? cleanup : () => {})
    }
    guard += 1
  }
  return rerender
}

const findButton = (tree, label) => flatten(tree).find((element) => element.tag === 'button' && element.props['aria-label'] === label)
const findClassName = (tree, className) => flatten(tree).find((element) => typeof element.tag === 'string' && String(element.props.className ?? '').includes(className))

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

/** 让已经排进微任务队列的 async 流程跑完。 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 30))

await check('收起态渲染麦克风按钮', async () => {
  const tree = render()
  const button = findButton(tree, '开始录音')
  assert.ok(button, 'idle mic button rendered')
  assert.deepEqual(button.props.disabled, false)
})

await check('录音中渲染「已录秒数/120」', async () => {
  clock = 1000
  findButton(render(), '开始录音').props.onClick()
  await flush()
  let tree = render()
  assert.ok(findButton(tree, '停止并识别'), 'stop button appears while recording')
  clock = 1000 + 15000
  intervalCallback()
  tree = render()
  assert.ok(findClassName(tree, 'dsvi-dot'), 'recording dot rendered')
  assert.match(textOf(tree), /15\/120/u, `timer text expected 15/120, got ${JSON.stringify(textOf(tree))}`)
})

await check('到 120 秒自动停止并插入识别文本', async () => {
  clock = 1000 + 120000
  intervalCallback()
  await flush()
  await flush()
  assert.equal(postedAudio === undefined, false, 'audio posted to the asr route')
  assert.equal(inserted.length, 1, 'transcript inserted once')
  assert.equal(inserted[0].text, '你好，这是识别结果')
  assert.deepEqual(inserted[0].span, { span: 'test' })
  assert.ok(clearedIntervals > 0, 'timer cleared')
})

if (failures > 0) {
  console.error(`\n${failures} 项失败`)
  process.exit(1)
}
console.log('\n全部通过')

