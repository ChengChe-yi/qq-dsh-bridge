# dsh web 侧要配的东西：一个插件 + 两个 MCP

桥接进程自己只做「QQ 消息 ↔ dsh 会话」的搬运。让 agent **知道规矩**、**能动手**的配置全在 dsh web 那边：

| 要配的 | 少了会怎样 |
| --- | --- |
| 插件 `qq-prompt-sections` | agent 没有读消息格式、防注入底线、`qq_*` 工具用法这几段规则，也不会有**人格卡**（角色卡正文就是它注入的） |
| MCP `qq` | 模型没有 `qq_*` 工具：不能发消息、不能翻聊天记录、不能 `qq_wait` |
| MCP `image` | 不能把 base64 换成短 URL（可选，不发图可以不配） |

下面的占位符：

- `<REPO>` = 本仓库位置，
- `<HOME>` = dsh 的 home，**必须与 `config.json` 里 `dsh.home` 是同一个**（密钥从 `<HOME>/.credentials.yaml` 读，不一致就是 401）

所有路径写**绝对路径**。dsh 拉起插件和 MCP 时的工作目录不是仓库，相对路径一定会挂。

---

## 0. 前提

1. 桥接起着：`node src/main.js`（或 `Launch.bat`），日志走到「就绪。等 QQ 消息触发投递。」
2. `config.json` 里 `dsh.baseUrl` 指向这个 dsh web，`api.port` 默认 `3110`
3. `dsh.agentPreset` 填 `qq`（见第 4 节）

---

## 1. 插件 `qq-prompt-sections`

### 1.1 放进 home 的插件目录

把仓库里的 `plugins/qq-prompt-sections` 整个复制到 `<HOME>\plugins\qq-prompt-sections`。

仓库那份是源，home 里那份是运行副本。改了仓库的代码要重新复制一次。

### 1.2 挂进 profile 的依赖

编辑 `<HOME>\profiles\web\package.json`：

```json
{
  "dependencies": {
    "qq-prompt-sections": "link:../../plugins/qq-prompt-sections"
  }
}
```

然后在 `profiles\web` 目录里装一次（dsh web 启动时通常也会自己装）。

### 1.3 注册到 agent preset

配置文件是 `<HOME>\profiles\web\cordis.patch.yml`。找到 `name: "@deepseek-ai/dsh-agent-preset"` 那一段（它的 `config.id` 是 `qq`），在它的 `plugins:` 列表里加：

```yaml
- id: qq-prompt-sections
  name: qq-prompt-sections
  config:
    dir: '<REPO>\prompts'
    rolesDir: '<REPO>\roles'
    currentRoleFile: '<REPO>\state\current-role.json'
    bridgeConfigFile: '<REPO>\config.json'
    runtimeFile: '<REPO>\state\runtime.json'
```

五个路径各管什么：

| 键 | 指向 | 用途 |
| --- | --- | --- |
| `dir` | `prompts/` | 六段规则正文：`0-role-hint` / `1-intro` / `2-read-format` / `3-safety` / `4-qq-tools` / `5-anchor` |
| `rolesDir` | `roles/` | 人格卡目录（每张卡一个 `.md`） |
| `currentRoleFile` | `state/current-role.json` | 当前启用人格的名字 |
| `bridgeConfigFile` | `config.json` | 取 `owner.qq`（管理者 QQ 是个事实，不该写死人设里） |
| `runtimeFile` | `state/runtime.json` | 填 `1-intro.md` 里的 `{selfQq}` |

⚠️ **同一个 preset 里的 `@deepseek-ai/dsh-persona` 必须 `complete: false`**。写成 `true` 时它是「组装后成为精确的完整提示词」，会把插件注册的所有 section 连同各 MCP 的 instructions 一起挤掉 —— 表现是 agent 完全不按规矩说话，也不带人设，但日志里一切正常。

规则正文**刻意不写进 YAML**：那个文件历史上被编码往返弄坏过（丢字符、全角标点变 U+FFFD），中文长段落放 `prompts/*.md` 里更稳。

---

## 2. MCP：`qq`（必需）

同一个 `plugins:` 列表里再加：

```yaml
- id: mcp-qq
  name: "@deepseek-ai/dsh-mcp-client"
  config:
    serverName: qq
    transport: stdio
    command: node
    args:
      - '<REPO>\src\mcp\qq-tools.js'
    env:
      QQ_BRIDGE_API: 'http://127.0.0.1:3110/api'
    toolCallTimeoutMs: 600000
    failOnStartupError: false
```

三个细节：

- **`QQ_BRIDGE_API` 的端口必须等于 `config.json` 的 `api.port`**。桥接改端口这里是唯一要同步的地方，不一致的表现是工具全部报「连不上桥接」。
- **`toolCallTimeoutMs` 给到 600000**：`qq_wait` 默认一次等 5 分钟，超时设小了会被 dsh 先掐掉。
- **`failOnStartupError: false`**：这个 MCP 起不来时不该让整个 agent 激活失败，否则群里表现为「@ 它完全没反应」，而日志里只有一条启动错误。反过来，代价是工具缺失时只有模型自己报错。
- `command: node` 依赖 dsh 自己的 PATH。PATH 里没有 node 就写 `node.exe` 的绝对路径。

---

## 3. MCP：`image`（可选）

```yaml
- id: mcp-image
  name: "@deepseek-ai/dsh-mcp-client"
  config:
    serverName: image
    transport: stdio
    command: node
    args:
      - '<REPO>\mcp-image\server.mjs'
    env:
      QQ_BRIDGE_API: 'http://127.0.0.1:3110/api'
    toolCallTimeoutMs: 30000
    failOnStartupError: false
```

提供 `image_publish`（base64 → 短 URL）和 `image_fetch`（只能取回本桥接发过的图）。
不发图可以不配，`qq_send` 的 `image` 段本来就同时接受 `url` 和 `base64`。

---

## 4. 让桥接用上这个 preset

`config.json`：

```json
{
  "dsh": { "agentPreset": "qq" }
}
```

并且 preset registry 的默认值也指向它（`cordis.patch.yml` 里 `@deepseek-ai/dsh-agent-preset-registry` 的 `config.default: qq`）。

⚠️ **preset 不存在时 dsh 会回落到默认 preset**，那套自带 bash、文件读写和子 agent。QQ 会话是暴露给群友的，群里任何人一句提示词注入就能指挥它动本机文件。所以配完要去会话列表里确认 `agentPreset` 真的是 `qq`，别只看启动日志。

---

## 5. 配完怎么验

1. 桥接日志：`就绪。等 QQ 消息触发投递。`
2. `curl http://127.0.0.1:3110/api` → 返回 `{"error":"not found"}`（GET 不接，但能返回就说明端口通、桥接活着）
3. 在 dsh 里问 agent「你现在能用哪些 qq_ 工具」→ 应该列得出 `qq_send` / `qq_read_chat` / `qq_wait` 这些。
4. 群里 @ 它一条 → 桥接日志出现「投递」，dsh 会话列表里多出 `QQ群 <群号> · <人格名>`。
5. 人格卡生效检查：`roles/<名字>.md` 存在，且 `state/current-role.json` 里的 `role` 就是这个名字（名字对不上时按「未启用人格」处理，不会报错）。

---

## 6. 对不上时先看这张表

| 现象 | 多半是 |
| --- | --- |
| 401 /「连的不是同一个实例」 | `<HOME>` 与 `dsh.home` 不一致；或 `.credentials.yaml` 不在这个 home 里 |
| 工具全部「连不上桥接」 | `QQ_BRIDGE_API` 的端口与 `config.json` 的 `api.port` 不一致；或桥接没起 |
| agent 不带人设、不按格式读消息 | 插件没注册；或 `persona.complete: true` 把段全挤掉了；或 `currentRoleFile` 指的名字在 `roles/` 里不存在 |
| 群里 @ 它毫无反应 | 看桥接日志有没有「投递」：有 → 问题在 dsh 侧（preset 不对 / 会话被归档）；没有 → 问题在桥接侧（`allow` 白名单、@ 识别） |
| 第一次回复特别慢 | 首次要 `session/create` + 登记 workspace，之后才复用 |
| 改了 `prompts/*.md` 没生效 | 插件的 section 文本是每次组装 system prompt 时现读的，改完下一次投递就生效、不用重启；还不生效就是 `dir` 指错了 |
