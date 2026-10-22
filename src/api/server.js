import http from 'node:http';
import { retrieve } from './images.js';
import { BridgeApiError } from './errors.js';
import { OPS } from './handlers/index.js';

const MAX_BODY_CHARS = 256 * 1024;

const MAX_IMAGE_BODY_CHARS = 4 * 1024 * 1024;

function countSendChars(args) {
  if (!args || typeof args !== 'object') return 0;

  const ofOne = (item) => {
    if (!item || typeof item !== 'object') return 0;
    let n = 0;

    if (typeof item.text === 'string') n += item.text.length;

    if (Array.isArray(item.segments)) {
      for (const seg of item.segments) {
        if (seg && typeof seg.text === 'string') n += seg.text.length;
      }
    }
    return n;
  };

  if (Array.isArray(args.messages)) {
    return args.messages.reduce((a, m) => a + ofOne(m), 0);
  }

  return ofOne(args);
}

export class BridgeApi {

  constructor({ storeFor, tokensFor, allow, logger } = {}) {
    this.storeFor = storeFor;
    this.tokensFor = tokensFor;
    this.allow = allow ?? { private: [], groups: [], allowAllWhenEmpty: false };
    this.logger = logger;
  }

  authenticate(key, token) {
    if (!key) throw new BridgeApiError('缺少 key 参数', { status: 401, code: 'missing-key' });
    if (!token) throw new BridgeApiError('缺少 token 参数', { status: 401, code: 'missing-token' });

    if (!/^(group|private):\d+$/.test(String(key))) {
      throw new BridgeApiError(
        `key 格式不对："${key}"。必须是 group:<群号> 或 private:<QQ号>，`
        + '全数字，带前缀，例如 group:100000000。',
        { status: 401, code: 'bad-key-format' },
      );
    }

    const expected = this.tokensFor(key);
    if (!expected) {
      throw new BridgeApiError(
        `会话 ${key} 尚未建立（桥接还没收到过它的消息）。`
        + '这不代表 key 写错了 —— 等群里有人说话、或确认 allow 白名单里包含这个会话。',
        { status: 401, code: 'session-not-established' },
      );
    }
    if (String(token) !== String(expected)) {
      throw new BridgeApiError(
        'token 与会话不匹配',
        { status: 401, code: 'bad-token' },
      );
    }
    return key;
  }

  assertAllowed(convKey) {
    const [kind, id] = String(convKey).split(':');
    const list = kind === 'group' ? this.allow.groups : this.allow.private;
    const inList = Array.isArray(list) && list.map(String).includes(String(id));
    if (inList) return;

    if (this.allow.allowAllWhenEmpty && (!this.allow.groups?.length && !this.allow.private?.length)) {
      return;
    }
    throw new BridgeApiError(
      `目标 ${convKey} 不在白名单内`,
      { status: 403, code: 'not-allowed' },
    );
  }

  async call(op, args = {}) {
    const spec = OPS.get(op);
    if (!spec) {
      throw new BridgeApiError(`未知操作 "${op}"`, { status: 404, code: 'unknown-op' });
    }

    const key = spec.authFree ? '' : this.authenticate(args.key, args.token);

    const handler = this.handlers?.[op];
    if (!handler) {
      throw new BridgeApiError(
        `操作 "${op}" 尚未接入（桥接未提供该能力）`,
        { status: 501, code: 'not-implemented' },
      );
    }

    if (spec.needsAllow) this.assertAllowed(key);

    if (spec.authFree) {
      if (!spec.warnOnError) return handler(key, args);
      try {
        return await handler(key, args);
      } catch (error) {
        this.logger?.warn(spec.warnOnError, {
          key,
          url: String(args?.url ?? '').slice(0, 80),
          error: String(error),
        });
        throw error;
      }
    }

    if (!spec.logsAsSend) return handler(key, args);

    if (args?.dryRun === true) return handler(key, args);

    const t0 = Date.now();

    this.logger?.debug('工具面收到发送请求', { op, key, chars: countSendChars(args) });
    try {
      const out = await handler(key, args);
      this.logger?.debug('工具面发送完成', { op, key, ms: Date.now() - t0 });
      return out;
    } catch (error) {

      this.logger?.warn('工具面发送失败', { op, key, ms: Date.now() - t0, error: String(error) });
      throw error;
    }
  }

  registerHandlers(handlers) {
    this.handlers = { ...(this.handlers ?? {}), ...handlers };
    return this;
  }
}

export function startBridgeApiServer({ api, port, host = '127.0.0.1', logger, imageBaseUrl }) {
  const server = http.createServer((req, res) => {

    const remote = req.socket.remoteAddress ?? '';
    const isLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
    if (!isLoopback) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: '只接受本机回环连接' }));
      return;
    }

    if (req.method === 'GET' && (req.url ?? '').startsWith('/img/')) {
      const m = /^\/img\/([0-9a-f]{32})\.(png|jpg|webp|gif)$/i.exec(req.url ?? '');
      if (!m) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found');
        return;
      }
      const hit = retrieve(m[1]);
      if (!hit) {

        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('这张图已经过期了（暂存 10 分钟）—— 重新渲染一次即可。');
        return;
      }
      res.writeHead(200, {
        'content-type': hit.mimeType,
        'content-length': hit.data.length,
        'cache-control': 'no-store',
      });
      res.end(hit.data);
      return;
    }

    if (req.method !== 'POST' || req.url !== '/api') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }

    let body = '';
    req.on('data', (chunk) => {
      body += chunk;

      const limit = body.includes('"op":"imagePublish"') || body.includes('"op": "imagePublish"')
        ? MAX_IMAGE_BODY_CHARS
        : MAX_BODY_CHARS;
      if (body.length > limit) {

        res.writeHead(413, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          error: `请求体过大（${body.length} 字符，上限 ${limit}）。`
            + (limit === MAX_IMAGE_BODY_CHARS
              ? '图片太大了 —— 把图缩小（调低 scale / 少放内容）再发。'
              : '工具参数不该这么大。'),
        }));
        req.destroy();
      }
    });
    req.on('end', async () => {
      let payload;
      try {
        payload = JSON.parse(body || '{}');
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'body 不是合法 JSON' }));
        return;
      }

      try {
        const result = await api.call(payload.op, payload.args ?? {});
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result }));
      } catch (error) {
        const status = error instanceof BridgeApiError ? error.status : 500;
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          ok: false,
          error: error?.message ?? String(error),
          code: error instanceof BridgeApiError ? error.code : 'internal',
        }));
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      logger?.info('桥接 API 已监听', { url: `http://${host}:${port}/api` });
      resolve(server);
    });
  });
}
