#!/usr/bin/env node
import readline from 'node:readline';

const log = (...a) => process.stderr.write(`[image-mcp] ${a.join(' ')}\n`);

const BRIDGE_URL = process.env.QQ_BRIDGE_API || 'http://127.0.0.1:3110/api';

const BRIDGE_ORIGIN = (() => {
  try {
    return new URL(BRIDGE_URL).origin;
  } catch {
    return 'http://127.0.0.1:3110';
  }
})();

const TIMEOUT_MS = Number(process.env.QQ_IMAGE_TIMEOUT_MS) > 0
  ? Number(process.env.QQ_IMAGE_TIMEOUT_MS)
  : 15000;

const OWN_URL_RE = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/img\/[0-9a-f]{32}\.[a-z]+$/i;

async function callBridge(op, args) {
  let res;
  try {
    res = await fetch(BRIDGE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op, args: { key: '', token: '', ...args } }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(
      `连不上桥接（${BRIDGE_URL}）：${error.message}。`
      + '图片存在桥接进程里 —— 确认桥接在运行（`node src/main.js`）。',
    );
  }

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`桥接返回的不是 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
  }
  if (!res.ok || !json?.ok) {
    throw new Error(json?.error ?? `桥接返回 HTTP ${res.status}`);
  }
  return json.result;
}

const TOOLS = [
  {
    name: 'image_publish',
    description:
      '把 base64 图片**暂存**起来，换回一个短 URL（约 40 字符）。\n'
      + '**什么时候用**：你手上有 base64、而下一步要把它发给群 —— '
      + '放进 `qq_send` 的 image 段。\n'
      + '⚠️ **不要自己把 base64 抄进 qq_send** —— 一张 720px 图的 base64 '
      + '约 6272 字符（≈1500 token），而且**抄错一个字符整张图就废**。\n'
      + '· 图在原处暂存 **10 分钟**，过期就重新发布一次；\n'
      + '· 只接受位图（png / jpeg / webp / gif）—— 不接受 SVG（能内嵌脚本）。',
    inputSchema: {
      type: 'object',
      properties: {
        base64: {
          type: 'string',
          description: '图片数据。带不带 `data:image/png;base64,` 前缀都行（会正确处理）。',
        },
        mimeType: {
          type: 'string',
          description: '图片类型，默认 image/png。带 data: 前缀时会自动从中提取，不用手填。',
        },
      },
      required: ['base64'],
    },
  },
  {
    name: 'image_fetch',
    description:
      '把图**取回成 base64**。\n'
      + '**什么时候用**：`qq_send` 的 image 段要 base64，而你手上只有 URL。\n'
      + `⚠️ **只能取回本机桥接自己暂存过的图**（\`${BRIDGE_ORIGIN}/img/<id>.png\`）—— `
      + '不接受外网地址。\n'
      + '· 如果那张图已经过期（暂存 10 分钟），会明确告诉你"重新渲染一次"；\n'
      + '· QQ 图床的图片地址**不适用这里** —— 那种地址带临时密钥、会过期，'
      + '直接把它放进 `image` 段的 `url` 即可，`qq_send` 那边会取。',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: `要取回的图地址，形如 ${BRIDGE_ORIGIN}/img/<32位id>.png`,
        },
      },
      required: ['url'],
    },
  },
];

async function callTool(name, args) {
  if (name === 'image_publish') {
    const base64 = String(args?.base64 ?? '').trim();
    if (!base64) {
      return err('缺少 `base64` —— 要给图片数据（带不带 data: 前缀都行）。');
    }
    const out = await callBridge('imagePublish', {
      base64,
      ...(args?.mimeType ? { mimeType: String(args.mimeType) } : {}),
    });
    return {
      content: [{
        type: 'text',
        text: `已暂存：${out.bytes} 字节（${out.mimeType}），10 分钟内有效。\n`
          + `url = ${out.url}\n\n`
          + '发的时候用：\n'
          + `\`qq_send { "messages": [{ "image": { "url": "${out.url}" } }] }\``,
      }],
    };
  }

  if (name === 'image_fetch') {
    const url = String(args?.url ?? '').trim();
    if (!url) return err('缺少 `url`。');

    if (!OWN_URL_RE.test(url)) {
      return err(
        `只能取回本机桥接自己暂存的图。这个地址不在允许范围内：${url.slice(0, 120)}\n`
        + `允许的形状：\`${BRIDGE_ORIGIN}/img/<32位id>.png\`（jpg/webp/gif 同理）。\n`
        + '⚠️ 不接受外网 / 其它端口的地址 —— 那会变成一个 SSRF 入口。\n'
        + '如果是 QQ 图床上的图（带 `rkey` 那种），**不需要**先取回来 —— '
        + '直接把它的 url 放进 `qq_send` 的 image 段即可。',
      );
    }

    const out = await callBridge('imageFetch', { url });
    const usage = '把它填进 qq_send 的 image 段：\n'
      + '`qq_send { "messages": [{ "image": { "base64": "…", "mimeType": "'
      + out.mimeType
      + '" } }] }`';
    return {
      content: [{
        type: 'text',
        text: `已取回：${out.bytes} 字节（${out.mimeType}）。\n`
          + `${usage}\n`
          + `base64 = ${out.base64}`,
      }],
    };
  }

  return {
    content: [{
      type: 'text',
      text: `未知工具：${name}。可用：${TOOLS.map((t) => t.name).join(', ')}`,
    }],
    isError: true,
  };
}

function err(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

async function dispatch(req) {
  const { id, method, params } = req;
  const isNotification = id === undefined || id === null;
  const reply = (result) => (isNotification ? null : { jsonrpc: '2.0', id, result });
  const fail = (code, message) => (isNotification ? null : { jsonrpc: '2.0', id, error: { code, message } });

  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'image', version: '1.0.0' },
        instructions:
          'base64 ↔ URL 的转换。要发图给群时优先用 url（省 token、抄不错）；'
          + '只有"URL 会过期"或"QQ 图床地址"的场合才需要取回 base64。',
      });
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      const name = String(params?.name ?? '');
      try {
        return reply(await callTool(name, params?.arguments ?? {}));
      } catch (error) {
        log(`${name} 失败：${error?.message ?? error}`);
        return reply(err(`工具 ${name} 执行失败：${error?.message ?? error}`));
      }
    }
    default:
      return fail(-32601, `不支持的方法：${method}`);
  }
}

let chain = Promise.resolve();
const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  const raw = line.trim();
  if (raw === '') return;
  let req;
  try {
    req = JSON.parse(raw);
  } catch {
    log('收到非 JSON，已忽略');
    return;
  }
  chain = chain.then(async () => {
    const res = await dispatch(req);
    if (res) send(res);
  }).catch((error) => {
    log('处理请求出错：', error?.stack ?? String(error));
    if (req?.id !== undefined && req?.id !== null) {
      send({
        jsonrpc: '2.0',
        id: req.id,
        error: { code: -32603, message: String(error?.message ?? error) },
      });
    }
  });
});

rl.on('close', () => {
  chain.finally(() => process.exit(0));
});

log(`就绪：桥接 ${BRIDGE_URL}（timeout ${TIMEOUT_MS}ms）`);
