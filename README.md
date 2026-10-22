# qq-dsh-bridge

把 QQ 群 / 私聊接到 dsh web 的桥接：QQ 消息变成 agent 的提示词，agent 的回复发回 QQ。

零运行时依赖 · Node.js ≥ 22.13 · Windows 有启动脚本（其它平台直接 `node src/main.js`）

```
QQ（SnowLuma / OneBot v11）
  │  WS 收事件、HTTP 发动作
  ▼
qq-dsh-bridge ── 每个会话一个聊天记录目录（按天存 JSON）+ 睡眠/醒着/等待状态机
  │                     └── 投递提示词 ──▶ dsh web 的一个会话（agent 跑一轮）
  ▼
dsh 侧 MCP（qq / image）──▶ qq_send 等工具打回桥接 ──▶ QQ
```

## 三步跑起来

1. 复制模板

   ```
   copy config.example.json config.json
   copy Launch.example.bat Launch.bat
   ```

2. 改 `config.json` 三处

   - `dsh.baseUrl` + `dsh.home`（home 必须与 dsh web 实例用的是同一个）
   - `snowluma.homeDir`（会自动读端点与两个 token），或者手填 `httpUrl` / `wsUrl` / `accessToken` / `wsToken`
   - `owner.qq` + `allow.groups`（白名单为空 = 谁都不放行）

3. 双击 `Launch.bat`，或 `node src/main.js`

日志走到「就绪。等 QQ 消息触发投递。」就成了。

## dsh web 侧还要配

**一个插件 + 两个 MCP**，完整步骤（含 YAML 片段和踩坑点）见 [docs/dsh-web.md](docs/dsh-web.md)。

不配的话：agent 没有规则段、没有人格卡，也没有 `qq_*` 工具 —— 群里表现为「@ 它完全没反应」。

## 目录

| 路径 | 说明 |
| --- | --- |
| `src/main.js` | 入口：配置 → 单实例锁 → dsh 客户端 → OneBot → 状态机 → 工具 API |
| `src/chatlog/` | 聊天记录、状态机、提示词、人格卡、表情库 |
| `src/dsh/` | dsh web 的 RPC 与事件流（离线铸造 Cookie） |
| `src/onebot/` | SnowLuma 的 HTTP / WS 与消息解析 |
| `src/api/` | 工具面 HTTP API（只监听回环）、图片暂存 |
| `src/mcp/` | 给 agent 的 `qq_*` 工具（stdio MCP server） |
| `mcp-image/` | `image_publish` / `image_fetch`（stdio MCP server） |
| `plugins/qq-prompt-sections/` | dsh 插件：把规则段与人格卡注入 system prompt |
| `prompts/` `roles/` | 规则正文、人格卡 |
| `state/` | 运行期状态，格式见 [state/README.md](state/README.md) |

## 配置

全部键与默认值在 `src/config/schema.js`，能直接拷的模板是 `config.example.json`。
`QQBRIDGE_*` 环境变量和 `--键=值` 命令行都能覆盖配置，优先级高于文件。

## 安全边界

- 工具面 API **只监听回环**；每个会话有独立 token，由桥接生成并写进提示词交给模型
- `allow` 白名单为空时 fail-closed（谁都不放行），不会退化成「全部放行」
- **preset 必须是那个没有命令执行权限的**（默认 `qq`）。dsh 找不到 preset 会回落到自带 bash / 文件读写的默认 preset，而群聊是对外暴露的 —— 群里任何人一句提示词注入都能指挥它动本机文件

## 许可

GPL-3.0-or-later，见 [LICENSE](LICENSE)。
