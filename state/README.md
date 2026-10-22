# state/ —— 运行期状态

这里的文件**全部由程序在运行时生成**，不是配置（配置在仓库根的 `config.json`）。
删掉任何一个都能正常启动，只是会丢掉它记住的那点东西。

仓库里只提交 `*.example.json` 模板：真实文件被 `.gitignore` 排除，
免得把自己的 QQ 号、会话 id 和表情库一起推到公开仓库。

| 文件 | 谁写 | 删掉的后果 |
| --- | --- | --- |
| `sessions.json` | `chatlog/adapter.js` | 每个 QQ 会话会重新建一个 dsh 会话，历史分裂成两条 |
| `current-role.json` | `chatlog/role.js` | 回到「没启用人格」，只按仿真提示词说话 |
| `runtime.json` | `app/deliver-pipeline.js` | 无影响：每次投递前都会重写 |
| `stickers.json` | `chatlog/stickers.js` | 表情库清空（图片在 `state/stickers/`） |
| `bridge.lock` | `util/lock.js` | 无影响：下次启动重建；进程被杀留下的陈旧锁会自动清掉 |

## sessions.json

一个 QQ 会话键对应一个 dsh 会话，**按人格分桶** —— 换人格不丢历史，
切回来还是原来那条会话。

```json
{
  "schemaVersion": 2,
  "sessions": {
    "group:100000000": {
      "示例人格": "session-00000000-0000-0000-0000-000000000000"
    },
    "private:100000001": {
      "示例人格": "session-11111111-1111-1111-1111-111111111111"
    }
  }
}
```

旧的单层格式（`"group:…": "session-…"`）仍能读，启动时会被迁移到当时启用的人格名下。
示例里的号码和 sessionId 都是假的，复制后请删掉这些条目。

## current-role.json

```json
{ "role": "示例人格", "updatedAt": "2026-01-01T00:00:00.000Z" }
```

`role` 是 `roles/<名字>.md` 的文件名（不含 `.md`），空串 = 不启用。
名字在 `roles/` 下找不到时按「没启用」处理，不会报错。

## runtime.json

```json
{ "selfQq": "100000000", "updatedAt": "2026-01-01T00:00:00.000Z" }
```

给 dsh 插件（`plugins/qq-prompt-sections`）填 `{selfQq}` 用 —— 那个插件是独立进程，
拿不到桥接的内存态。**不用手工维护**，每次投递前都会重写。

## stickers.json

顶层是数组。一条长这样：

```json
{
  "id": "100000000_0_0_0_<md5>_0_0",
  "desc": "猫娘抱鱼",
  "url": "https://p.qpic.cn/qq_expression/...",
  "md5": "<md5>",
  "useCount": 0
}
```

`loadStickers` 只要求 `id`；`url` 与 `file`（本地图片路径）二选一。
下载时有域名白名单（只允许 qpic 那几个），见 `src/chatlog/stickers.js`。

## 关于 console-token

旧版控制台用落盘令牌（`state/console-token`），现在改成「一个密码」
（`config.json` 的 `console.password`），**已经没有代码读写这个文件**。
从旧版本升上来的目录里可能残留一个空文件，可以直接删。