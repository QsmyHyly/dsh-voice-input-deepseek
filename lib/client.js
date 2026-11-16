/**
 * DeepSeek 语音输入 —— 浏览器半。
 *
 * 职责：占用输入框工具栏的 `conversation.input.activity` 槽，提供一个麦克风按钮：点一下开始
 * 录音，录音过程中显示「已录秒数/最大秒数」（例如 15/120），达到上限自动停止，然后把浏览器
 * 重采样出来的 16 kHz 单声道 PCM16 WAV 直接 POST 给宿主半的同源路由，拿回文字插入输入框
 * （不自动发送，仍由用户自己提交）。
 *
 * 边界：
 * - 只在槽里渲染自己的控件，不碰别人 DOM、不加载 dsh 内部客户端包，样式只用 --dsw-alias-* token。
 * - 音频不上传附件、不写会话；识别文本只是普通插入到输入框。
 * - 录音上限与字节上限来自宿主半 `/api/voice-input-deepseek/config`，与 DeepSeek 官方限制一致。
 *
 * @doc https://api-docs.deepseek.com/zh-cn/api/asr
 */
window.__ModuleLoader__.load({
  id: 'dsh-voice-input-deepseek',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'voice-input-deepseek'
    const CONFIG_ROUTE = 'api/voice-input-deepseek/config'
    const ASR_ROUTE = 'api/voice-input-deepseek/asr'

    /** 官方上限：8 MiB。宿主半也会校验，这里先拦一次省一次往返。 */
    const MAX_AUDIO_BYTES = 8 * 1024 * 1024

    const zh = {
      dictate: '语音输入（DeepSeek）',
      start: '开始录音',
      cancel: '取消录音',
      stop: '停止并识别',
      retry: '重新录音',
      requesting: '正在打开麦克风…',
      recording: '正在录音',
      sending: '正在识别…',
      insertAgain: '插入文本',
      needsKeyHint: '还没有配置 DeepSeek API Key，请到「设置 → 模型」里填写',
      durationTitle: '已录 {elapsed} 秒，上限 {max} 秒',
      empty: '没有识别到文字，请重试。',
      conflict: '输入框内容已变化，文字没有插入。',
      permission: '没有麦克风权限，请在系统设置里允许 DSH 使用麦克风。',
      deviceMissing: '没有找到可用的麦克风。',
      unavailable: '当前环境不支持录音。',
      interrupted: '麦克风被中断，请重试。',
      failed: '语音输入失败：{message}'
    }

    const en = {
      dictate: 'Voice input (DeepSeek)',
      start: 'Start recording',
      cancel: 'Cancel recording',
      stop: 'Stop and transcribe',
      retry: 'Record again',
      requesting: 'Opening the microphone…',
      recording: 'Recording',
      sending: 'Transcribing…',
      insertAgain: 'Insert text',
      needsKeyHint: 'No DeepSeek API key yet. Add one in Settings → Models.',
      durationTitle: '{elapsed} seconds recorded, limit {max} seconds',
      empty: 'No speech was recognised. Try again.',
      conflict: 'The input changed, so the text was not inserted.',
      permission: 'Microphone permission is denied. Allow DSH to use the microphone in system settings.',
      deviceMissing: 'No usable microphone was found.',
      unavailable: 'Recording is not available in this environment.',
      interrupted: 'The microphone was interrupted. Try again.',
      failed: 'Voice input failed: {message}'
    }

    const CSS = `
.dsvi-trigger{flex:none;width:28px;height:28px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
.dsvi-trigger:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dsvi-trigger:disabled{opacity:.4;cursor:default}
.dsvi-row{display:flex;align-items:center;gap:10px;width:100%;min-width:0;min-height:32px}
.dsvi-round{flex:none;width:28px;height:28px;padding:0;border:0;border-radius:50%;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
.dsvi-round:hover{background:var(--dsw-alias-bg-layer-1)}
.dsvi-stop{background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-bg-base)}
.dsvi-stop:hover{background:var(--dsw-alias-state-error-primary)}
.dsvi-status{flex:1;min-width:0;display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.dsvi-label{overflow:hidden;text-overflow:ellipsis}
.dsvi-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-error-primary);animation:dsvi-pulse 1s ease-in-out infinite}
.dsvi-timer{flex:none;font-variant-numeric:tabular-nums;font-size:12px;font-weight:500;color:var(--dsw-alias-label-primary)}
.dsvi-inline{flex:none;border:0;border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12px;padding:3px 10px;cursor:pointer}
.dsvi-inline:hover{background:var(--dsw-alias-bg-layer-1)}
@keyframes dsvi-pulse{0%,100%{opacity:1}50%{opacity:.25}}
`

    function microphoneIcon(size) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
        h('rect', { x: 9, y: 3, width: 6, height: 11, rx: 3, fill: 'currentColor' }),
        h('path', {
          d: 'M5.5 11.5a6.5 6.5 0 0 0 13 0',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round'
        }),
        h('path', { d: 'M12 18v3', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' })
      )
    }

    function closeIcon(size) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
        h('path', { d: 'M6 6l12 12M18 6L6 18', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' })
      )
    }

    function stopIcon(size) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': true },
        h('rect', { x: 6, y: 6, width: 12, height: 12, rx: 2, fill: 'currentColor' })
      )
    }

    /** 把浮点采样编码成 16 位 PCM 单声道 WAV。 */
    function encodeWave(samples) {
      const bytes = new Uint8Array(44 + samples.length * 2)
      const view = new DataView(bytes.buffer)
      const text = (at, value) => {
        for (let i = 0; i < value.length; i += 1) bytes[at + i] = value.charCodeAt(i)
      }
      text(0, 'RIFF')
      view.setUint32(4, bytes.length - 8, true)
      text(8, 'WAVE')
      text(12, 'fmt ')
      view.setUint32(16, 16, true)
      view.setUint16(20, 1, true)
      view.setUint16(22, 1, true)
      view.setUint32(24, 16000, true)
      view.setUint32(28, 32000, true)
      view.setUint16(32, 2, true)
      view.setUint16(34, 16, true)
      text(36, 'data')
      view.setUint32(40, samples.length * 2, true)
      for (let i = 0; i < samples.length; i += 1) {
        const value = Math.max(-1, Math.min(1, samples[i]))
        view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true)
      }
      return bytes
    }

    /** MediaRecorder 的 opus 数据 → 16 kHz 单声道 PCM16 WAV。 */
    async function toWave(chunks, mimeType, maxSeconds) {
      const context = new AudioContext()
      try {
        const blob = new Blob(chunks, { type: mimeType })
        if (blob.size === 0) throw new Error('empty')
        const decoded = await context.decodeAudioData(await blob.arrayBuffer())
        const seconds = Math.max(0, Math.min(decoded.duration, maxSeconds))
        const frames = Math.max(1, Math.floor(seconds * 16000))
        const offline = new OfflineAudioContext(1, frames, 16000)
        const source = offline.createBufferSource()
        source.buffer = decoded
        source.connect(offline.destination)
        source.start()
        const rendered = await offline.startRendering()
        return encodeWave(rendered.getChannelData(0))
      } finally {
        await context.close().catch(() => undefined)
      }
    }

    function stopTracks(stream) {
      if (!stream) return
      for (const track of stream.getTracks()) track.stop()
    }

    function stopRecorder(recorder) {
      if (!recorder) return Promise.resolve()
      if (recorder.state !== 'recording') return Promise.resolve()
      return new Promise((resolve) => {
        recorder.onstop = () => resolve(undefined)
        recorder.onerror = () => resolve(undefined)
        try {
          recorder.stop()
        } catch {
          resolve(undefined)
        }
      })
    }

    async function fetchConfig() {
      const response = await fetch(CONFIG_ROUTE, { headers: { accept: 'application/json' } })
      const body = await response.json().catch(() => undefined)
      if (!response.ok || body === undefined || body.ok !== true) throw new Error(`config HTTP ${response.status}`)
      return body
    }

    /**
     * 工具栏里的麦克风控件。录音中显示「已录秒数/上限秒数」，到点自动停。
     * @param props - 槽提供的标准属性 + locale 翻译函数。
     * @returns 收起态的一个按钮，或展开态的录音行。
     */
    function VoiceInput(props) {
      const { inputActions, onActiveChange, locked, t } = props
      const [mode, setMode] = React.useState('idle')
      const [elapsed, setElapsed] = React.useState(0)
      const [message, setMessage] = React.useState('')
      const [pending, setPending] = React.useState('')
      const [limits, setLimits] = React.useState(undefined)
      const [credentialReady, setCredentialReady] = React.useState(true)
      const session = React.useRef(undefined)
      const generation = React.useRef(0)
      const expanded = mode !== 'idle'

      React.useEffect(() => {
        let cancelled = false
        fetchConfig()
          .then((body) => {
            if (cancelled) return
            setLimits({
              maxDurationSeconds: typeof body.maxDurationSeconds === 'number' ? body.maxDurationSeconds : 120
            })
            setCredentialReady(body.credentialReady !== false)
          })
          .catch(() => undefined)
        return () => {
          cancelled = true
        }
      }, [])

      React.useLayoutEffect(() => {
        onActiveChange(expanded)
        return () => {
          onActiveChange(false)
        }
      }, [expanded, onActiveChange])

      const maxSeconds = limits?.maxDurationSeconds ?? 120

      const release = React.useCallback(() => {
        const active = session.current
        session.current = undefined
        if (active === undefined) return
        clearInterval(active.timer)
        stopTracks(active.stream)
        if (active.recorder && active.recorder.state !== 'inactive') {
          try {
            active.recorder.stop()
          } catch {
            // 已停时忽略。
          }
        }
      }, [])

      const cancel = React.useCallback(() => {
        generation.current += 1
        release()
        setMode('idle')
        setMessage('')
        setPending('')
        setElapsed(0)
      }, [release])

      React.useEffect(() => {
        const escape = (event) => {
          if (event.key === 'Escape' && session.current !== undefined) {
            event.preventDefault()
            cancel()
          }
        }
        const blur = () => {
          if (session.current !== undefined && session.current.phase !== 'sending') cancel()
        }
        const visibility = () => {
          if (document.hidden && session.current !== undefined && session.current.phase !== 'sending') cancel()
        }
        document.addEventListener('keydown', escape)
        window.addEventListener('blur', blur)
        document.addEventListener('visibilitychange', visibility)
        return () => {
          document.removeEventListener('keydown', escape)
          window.removeEventListener('blur', blur)
          document.removeEventListener('visibilitychange', visibility)
          generation.current += 1
          release()
        }
      }, [cancel, release])

      const feedback = (text) => {
        setMessage(text)
        setMode('feedback')
      }

      const failureText = (error) => {
        if (error instanceof DOMException) {
          if (error.name === 'NotAllowedError') return t('permission')
          if (error.name === 'NotFoundError' || error.name === 'OverconstrainedError') return t('deviceMissing')
        }
        return t('failed', { message: error instanceof Error ? error.message : String(error) })
      }

      const start = async () => {
        if (session.current !== undefined) return
        if (!credentialReady) {
          feedback(t('needsKeyHint'))
          return
        }
        if (!navigator.mediaDevices || typeof MediaRecorder === 'undefined') {
          feedback(t('unavailable'))
          return
        }
        const run = (generation.current += 1)
        const max = maxSeconds
        const active = {
          run,
          max,
          phase: 'requesting',
          span: inputActions.captureInsertion(),
          stream: undefined,
          recorder: undefined,
          chunks: [],
          timer: undefined,
          startedAt: 0
        }
        session.current = active
        setMessage('')
        setPending('')
        setElapsed(0)
        setMode('requesting')
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true },
            video: false
          })
          if (run !== generation.current || session.current !== active) {
            stopTracks(stream)
            return
          }
          active.stream = stream
          const recorder = new MediaRecorder(stream)
          active.recorder = recorder
          recorder.ondataavailable = (event) => {
            if (event.data.size > 0) active.chunks.push(event.data)
          }
          recorder.onerror = () => {
            if (session.current === active) {
              generation.current += 1
              release()
              feedback(t('interrupted'))
            }
          }
          const track = stream.getAudioTracks()[0]
          if (track !== undefined) {
            track.addEventListener('ended', () => {
              if (session.current === active && active.phase === 'recording') {
                generation.current += 1
                release()
                feedback(t('interrupted'))
              }
            })
          }
          recorder.start()
          active.phase = 'recording'
          active.startedAt = performance.now()
          setMode('recording')
          active.timer = setInterval(() => {
            if (session.current !== active) return
            const seconds = (performance.now() - active.startedAt) / 1000
            setElapsed(Math.min(max, seconds))
            if (seconds >= max) finish()
          }, 100)
        } catch (error) {
          release()
          if (run === generation.current) feedback(failureText(error))
        }
      }

      const finish = async () => {
        const active = session.current
        if (active === undefined || active.phase !== 'recording') return
        active.phase = 'sending'
        const run = active.run
        clearInterval(active.timer)
        setMode('sending')
        try {
          await stopRecorder(active.recorder)
          stopTracks(active.stream)
          // MediaRecorder 不设 timeslice 时，最后一段数据是在 stop 事件里才发出的，
          // 所以必须在 stopRecorder 之后再取 chunks，否则会拿到空音频。
          const chunks = active.chunks.slice()
          const mimeType = active.recorder?.mimeType
          if (run !== generation.current) return
          if (chunks.length === 0) {
            session.current = undefined
            feedback(t('empty'))
            return
          }
          const bytes = await toWave(chunks, mimeType, active.max)
          if (run !== generation.current) return
          if (bytes.length > MAX_AUDIO_BYTES) {
            session.current = undefined
            feedback(t('failed', { message: `audio exceeds ${MAX_AUDIO_BYTES} bytes` }))
            return
          }
          const response = await fetch(ASR_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'audio/wav' },
            body: bytes
          })
          const body = await response.json().catch(() => undefined)
          if (run !== generation.current) return
          if (!response.ok || body === undefined || body.ok !== true) {
            session.current = undefined
            const reason = body?.error?.message ?? `HTTP ${response.status}`
            feedback(t('failed', { message: reason }))
            return
          }
          const transcript = typeof body.text === 'string' ? body.text.trim() : ''
          if (transcript === '') {
            session.current = undefined
            feedback(t('empty'))
            return
          }
          if (!inputActions.insertText(transcript, active.span)) {
            session.current = undefined
            setPending(transcript)
            feedback(t('conflict'))
            return
          }
          session.current = undefined
          setMode('idle')
          setMessage('')
          setPending('')
          setElapsed(0)
        } catch (error) {
          session.current = undefined
          if (run === generation.current) feedback(failureText(error))
        }
      }

      const insertPending = () => {
        if (pending === '') return
        if (inputActions.insertText(pending, inputActions.captureInsertion())) {
          setPending('')
          setMessage('')
          setMode('idle')
        } else {
          feedback(t('conflict'))
        }
      }

      if (!expanded) {
        return h(
          React.Fragment,
          null,
          h('style', null, CSS),
          h(
            'button',
            {
              type: 'button',
              className: 'dsvi-trigger',
              title: credentialReady ? t('dictate') : t('needsKeyHint'),
              'aria-label': t('start'),
              disabled: locked === true,
              onMouseDown: (event) => event.preventDefault(),
              onClick: () => {
                start()
              }
            },
            microphoneIcon(18)
          )
        )
      }

      const statusText =
        mode === 'recording'
          ? t('recording')
          : mode === 'requesting'
            ? t('requesting')
            : mode === 'sending'
              ? t('sending')
              : message

      return h(
        'div',
        { className: 'dsvi-row', 'data-voice-activity': mode },
        h('style', null, CSS),
        h(
          'button',
          { type: 'button', className: 'dsvi-round', title: t('cancel'), 'aria-label': t('cancel'), onClick: cancel },
          closeIcon(14)
        ),
        h(
          'div',
          { className: 'dsvi-status' },
          mode === 'recording' ? h('span', { className: 'dsvi-dot' }) : null,
          h('span', { className: 'dsvi-label', role: 'status', title: statusText }, statusText),
          mode === 'recording'
            ? h(
                'span',
                {
                  className: 'dsvi-timer',
                  title: t('durationTitle', { elapsed: String(Math.floor(elapsed)), max: String(maxSeconds) })
                },
                `${Math.floor(elapsed)}/${maxSeconds}`
              )
            : null
        ),
        mode === 'recording'
          ? h(
              'button',
              {
                type: 'button',
                className: 'dsvi-round dsvi-stop',
                title: t('stop'),
                'aria-label': t('stop'),
                onClick: () => {
                  finish()
                }
              },
              stopIcon(14)
            )
          : null,
        mode === 'feedback'
          ? pending !== ''
            ? h('button', { type: 'button', className: 'dsvi-inline', onClick: insertPending }, t('insertAgain'))
            : h(
                'button',
                {
                  type: 'button',
                  className: 'dsvi-round',
                  title: t('retry'),
                  'aria-label': t('retry'),
                  disabled: locked === true,
                  onClick: () => {
                    start()
                  }
                },
                microphoneIcon(18)
              )
          : null
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }))
        ctx.slots.inject('conversation.input.activity', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.activity',
              locale: NS
            },
            VoiceInput
          )
        )
      }
    }
  }
})
