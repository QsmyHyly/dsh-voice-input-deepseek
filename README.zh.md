# dsh-voice-input-deepseek

输入框工具栏里的语音听写：录音 → DeepSeek 官方语音识别 → 文本插入输入框。

- 接口：`POST https://api.deepseek.com/v1/tools/asr`（16 位 PCM WAV，≤ 8 MiB，≤ 120 秒，语种自动识别）。
- 录音时按钮会展开为一行状态，右侧显示「已录秒数/上限秒数」（例如 `15/120`），到达上限自动停止。
- 凭据：优先读 dsh 凭据服务里的 `DEEPSEEK_API_KEY`（设置 → 模型里填写，或 `DEEPSEEK_API_KEY` 环境变量）；
  也可在插件 config 里写死 `apiKey`。**账号登录令牌不能用于 ASR**，接口只认平台 API Key。
- 传输：浏览器把音频 POST 到同源的 `/api/voice-input-deepseek/asr`，由宿主进程带上 Key 调上游；
  Key 不会进入浏览器。路由过 dsh 自带的 Host/Origin/cookie 栅栏，远程隧道访问一律 403。
- 关闭随包实验性语音输入的麦克风控件（它用本地 SenseVoice 模型且不显示时长），槽位让给本插件。

## 安装

这是 **DSH（DeepSeek Harness）** 的插件，运行前需要：DSH 桌面版 + 一个 DeepSeek 平台 API Key
（ASR 走平台接口，账号登录令牌不能替代）。

1. 克隆本仓库到本地任意目录：

   ```bash
   git clone https://github.com/QsmyHyly/dsh-voice-input-deepseek.git
   ```

2. 在 DSH 里以**本地目录**方式安装这个 bundle：让 agent 调用 `plugin_manager` 的 `install_bundle`，
   `target` 填克隆目录的绝对路径；或在 DSH 的插件管理界面里选择安装本地 bundle 并指向该目录。
3. 安装会写进当前 profile（`~/.dsh/profiles/<profile>/package.json` 里增加一条 `link:` 依赖并
   启用 bundle），对所有会话生效、重启后保留。卸载用 `plugin_manager` 的 `remove_bundle`。

本包 `private: true`，不通过 npm 发布，安装来源就是本仓库目录。

## 配置项

写在本插件那一行 `cordis.patch.yml` 的 `config` 里：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `baseURL` | `https://api.deepseek.com/v1/tools` | 官方接口基地址，插件追加 `/asr` |
| `apiKey` | 空 | 直接写 Key（不推荐，优先凭据服务） |
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | 凭据引用名 |
| `maxDurationSeconds` | `120` | 录音上限，官方上限 120 |
| `maxAudioBytes` | `8388608` | 上传上限，官方上限 8 MiB |
| `requestTimeoutMs` | `60000` | 单次上游超时 |

## 开发

纯 ESM、零依赖、无构建步骤。测试在 `test/`，用 `npm test` 跑（不访问网络、不写磁盘）：

```bash
npm test
```

## English

Push-to-talk dictation for the composer backed by DeepSeek's official speech-to-text API
(`POST /v1/tools/asr`). Recording shows `elapsed/limit` (e.g. `15/120`) and stops at the limit.
The key is resolved on the Host from the `DEEPSEEK_API_KEY` credential (or the plugin config) and
never reaches the browser; audio goes to a same-origin route that passes dsh's Host/Origin fence.

## 链接

- 仓库：https://github.com/QsmyHyly/dsh-voice-input-deepseek
- 作者：QsmyHyly · [哔哩哔哩](https://space.bilibili.com/1525999910)
- 协议：[MIT](LICENSE)
