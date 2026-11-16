# dsh-voice-input-deepseek

输入框工具栏里的语音听写：录音 → DeepSeek 官方语音识别（ASR）→ 文本插入输入框（不自动发送）。

## 安装

这是 **DSH（DeepSeek Harness）** 的插件，运行前需要：DSH 桌面版 + 一个 DeepSeek 平台 API Key
（ASR 走平台接口，账号登录令牌不能替代，配置方法见下方「凭据」）。

1. 克隆本仓库到本地任意目录：

   ```bash
   git clone https://github.com/QsmyHyly/dsh-voice-input-deepseek.git
   ```

2. 在 DSH 里以**本地目录**方式安装这个 bundle：让 agent 调用 `plugin_manager` 的 `install_bundle`，
   `target` 填克隆目录的绝对路径；或在 DSH 的插件管理界面里选择安装本地 bundle 并指向该目录。
3. 安装会写进当前 profile（`~/.dsh/profiles/<profile>/package.json` 里增加一条 `link:` 依赖并
   启用 bundle），对所有会话生效、重启后保留。卸载用 `plugin_manager` 的 `remove_bundle`。

本包 `private: true`，不通过 npm 发布，安装来源就是本仓库目录。

## 用法

点输入框工具栏上的麦克风按钮开始录音；录音中按钮展开成一行状态，右侧显示「已录秒数/上限秒数」
（例如 `15/120`），到上限自动停止。识别出的文字插入输入框，再由你自己提交。

## 接口与限制

- 接口：`POST https://api.deepseek.com/v1/tools/asr`
- 音频：16 位 PCM WAV（浏览器侧重采样成 16 kHz 单声道），≤ 8 MiB，≤ 120 秒，语种自动识别。
- 官方文档：[语音识别指南](https://api-docs.deepseek.com/zh-cn/guides/asr) ·
  [API 参考](https://api-docs.deepseek.com/zh-cn/api/asr)。

## 凭据

优先读 dsh 凭据服务里的 `DEEPSEEK_API_KEY`（「设置 → 模型」里填写，或 `DEEPSEEK_API_KEY`
环境变量）；也可在插件 config 里写死 `apiKey`。**账号登录令牌不能用于 ASR**，接口只认平台
API Key（`Authorization: Bearer sk-…`）。

## 传输

浏览器把音频 POST 到同源的 `/api/voice-input-deepseek/asr`，由宿主进程带上 Key 调上游，Key
不会进入浏览器。路由先过 dsh 自带的 Host/Origin/cookie 栅栏，远程隧道访问一律 403。

## 槽位

关闭随包实验性语音输入里的麦克风控件（它用本地 SenseVoice 模型且录音时不显示时长），把单占位槽
`conversation.input.activity` 让给本插件。

## 配置项

写在本插件那一行 `cordis.patch.yml` 的 `config` 里：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `baseURL` | `https://api.deepseek.com/v1/tools` | 官方接口基地址，插件追加 `/asr` |
| `apiKey` | 空 | 直接写 Key（不推荐，优先用凭据服务） |
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | 凭据引用名 |
| `maxDurationSeconds` | `120` | 录音上限，官方上限 120 |
| `maxAudioBytes` | `8388608` | 上传上限，官方上限 8 MiB |
| `requestTimeoutMs` | `60000` | 单次上游超时（毫秒） |

## 开发

纯 ESM、零依赖、无构建步骤，改 `lib/` 下的文件即可（DSH 以 `link:` 安装这个目录，重载插件后生效）。

```bash
npm test
```

测试在 `test/`：`host-route.test.mjs` 用本地假 DeepSeek 服务验证宿主路由（鉴权头、multipart 的
`file` 字段、各类错误路径），`client-render.test.mjs` 用假 React 渲染客户端控件，两者都不访问网络、
不写磁盘。

## English

Dictation for the DSH composer backed by DeepSeek's official speech-to-text API
(`POST /v1/tools/asr`). Requires the DSH desktop app and a DeepSeek platform API key.

Install: clone this repository and add the directory as a local bundle in DSH —
`plugin_manager` with `install_bundle` and the absolute path of the clone, or the local-bundle
option in DSH's plugin settings. The bundle is `private: true` and is not published to npm.

While recording, the button shows `elapsed/limit` (e.g. `15/120`) and stops at the limit. The key
is resolved on the Host from the `DEEPSEEK_API_KEY` credential (or the plugin config) and never
reaches the browser; audio goes to a same-origin route that passes DSH's Host/Origin fence.

## 链接

- 仓库：https://github.com/QsmyHyly/dsh-voice-input-deepseek
- 作者：QsmyHyly · [哔哩哔哩](https://space.bilibili.com/1525999910)
- 协议：[MIT](LICENSE)
