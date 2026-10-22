import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { mintSessionCookie, readBrowserSessionSecret, resolveDshHome, shouldRefresh, DshAuthError } from './auth.js';

const DEFAULT_COOKIE_LIFETIME_MS = 60 * 60 * 1000;

export class DshClientError extends Error {
  constructor(message, { status, method, body, hint } = {}) {
    super(message);
    this.name = 'DshClientError';
    this.status = status;
    this.method = method;
    this.body = body;
    this.hint = hint;
  }
  toString() {
    const bits = [this.name + ': ' + this.message];
    if (this.method) bits.push(`  method: ${this.method}`);
    if (this.status) bits.push(`  status: ${this.status}`);
    if (this.body) bits.push(`  body: ${String(this.body).slice(0, 300)}`);
    if (this.hint) bits.push(`  ${this.hint}`);
    return bits.join('\n');
  }
}

export class DshClient extends EventEmitter {

  constructor({
    baseUrl,
    home,
    logger,
    requestTimeoutMs = 30_000,
    authRefreshSkewMs = 300_000,
    launchToken = '',
    allowRemote = false,
    mode = '',
    fetch: fetchImpl = globalThis.fetch,
  } = {}) {
    super();
    this.baseUrl = normalizeBase(baseUrl);
    this.home = resolveDshHome(home);
    this.logger = logger;
    this.requestTimeoutMs = requestTimeoutMs;
    this.authRefreshSkewMs = authRefreshSkewMs;
    this.launchToken = launchToken;
    this.allowRemote = allowRemote;
    this.fetch = fetchImpl;
    this.cookie = null;
    this.secret = null;
    this.mode = mode;
  }

  get authority() {
    return new URL(this.baseUrl).host;
  }

  assertTargetAllowed() {
    const host = new URL(this.baseUrl).hostname;
    const loopback = host === 'localhost' || host === '::1' || host === '[::1]' || /^127\./.test(host);
    if (!loopback && !this.allowRemote) {
      throw new DshClientError(
        `目标 ${this.baseUrl} 不是回环地址，且未开启 dsh.allowRemote`,
        { hint: '这会把本地 agent 能力暴露到网络。确认要这么做请在配置里显式设置 dsh.allowRemote=true。' },
      );
    }
  }

  async ensureAuth() {
    this.assertTargetAllowed();
    if (!shouldRefresh(this.cookie, { skewMs: this.authRefreshSkewMs })) return this.cookie;

    if (this.mode === 'launch-token' && this.launchToken) {
      throw new DshAuthError('launch token 交换模式尚未实现', {
        hint: 'DSH 0.1.7 起 launch token 是每进程内存随机数、不落盘。请留空 dsh.launchToken 以使用离线 Cookie 铸造。',
      });
    }

    if (!this.secret) {
      const { secret, file } = readBrowserSessionSecret({ home: this.home });
      this.secret = secret;
      this.logger?.debug('已读取 DSH 签名密钥', { file, bytes: secret.byteLength });
    }

    this.cookie = mintSessionCookie({
      baseUrl: this.baseUrl,
      secret: this.secret,
      lifetimeMs: DEFAULT_COOKIE_LIFETIME_MS,
    });
    this.logger?.debug('已铸造会话 Cookie', { authority: this.cookie.authority, expiresAt: new Date(this.cookie.expiresAt).toISOString() });
    this.emit('auth', { authority: this.cookie.authority });
    return this.cookie;
  }

  invalidateAuth() {
    this.cookie = null;
  }

  async call(method, payload = {}, { signal, timeoutMs } = {}) {
    const cookie = await this.ensureAuth();
    const url = `${this.baseUrl}/api/${method}`;
    const rpcId = crypto.randomUUID();

    const body = JSON.stringify({
      type: 'client-request',
      rpcId,
      method,
      payload: wrapArgs(method, payload),
    });

    const attempt = async (creds) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs ?? this.requestTimeoutMs);
      const onAbort = () => controller.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        return await this.fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            cookie: `${creds.name}=${creds.value}`,

          },
          body,
          signal: controller.signal,
          redirect: 'manual',
        });
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
    };

    let response;
    try {
      response = await attempt(cookie);
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new DshClientError(`调用 ${method} 超时（${timeoutMs ?? this.requestTimeoutMs}ms）`, { method });
      }
      throw new DshClientError(`调用 ${method} 失败：${error.message}`, {
        method,
        hint: '确认 DSH 在运行、dsh.baseUrl 指向正确的实例。',
      });
    }

    if (response.status === 401 || response.status === 403) {
      const text = await safeText(response);

      this.invalidateAuth();
      let retried;
      try {
        const fresh = await this.ensureAuth();
        retried = await attempt(fresh);
      } catch (error) {
        throw new DshClientError(`调用 ${method} 重试失败：${error.message}`, { method, status: response.status });
      }
      if (retried.status === 401 || retried.status === 403) {
        const retriedText = await safeText(retried);
        throw new DshClientError(
          `${method} 鉴权被拒（HTTP ${retried.status}）`,
          {
            method,
            status: retried.status,
            body: retriedText || text,
            hint: '常见原因：① dsh.baseUrl 指向的实例与 DSH_HOME 不是同一个（例如残留的旧 dsh web 进程）；'
              + '② 该实例不是标准 web 载体（桌面端走 shell 内部载体、不开 /api 路由）；'
              + `③ .credentials.yaml 里的密钥已轮换。当前 authority=${this.authority}，DSH_HOME=${this.home}`,
          },
        );
      }
      response = retried;
    }

    if (!response.ok) {
      const text = await safeText(response);
      throw new DshClientError(`调用 ${method} 返回 HTTP ${response.status}`, {
        method,
        status: response.status,
        body: text,
      });
    }

    let envelope;
    try {
      envelope = await response.json();
    } catch (error) {
      throw new DshClientError(`调用 ${method} 的响应不是 JSON`, { method, body: error.message });
    }

    if (envelope?.rpcId && envelope.rpcId !== rpcId) {
      throw new DshClientError(`响应 rpcId 不匹配（期望 ${rpcId}，收到 ${envelope.rpcId}）`, { method });
    }
    if (envelope?.result && envelope.result.ok === false) {
      throw new DshClientError(`调用 ${method} 返回错误：${envelope.result.error?.message ?? '未知错误'}`, {
        method,
        body: JSON.stringify(envelope.result.error ?? {}),
      });
    }
    return envelope?.result ?? envelope;
  }

  async probeStatus() {
    const result = await this.call('settings/describe', {});
    return result;
  }
}

const ARGS_SHAPE = Object.freeze({

  'settings/describe': 'flat',
  'agentPresets/list': 'flat',
  'workspace/list': 'flat',
  'models/list': 'flat',

  '$events/result': 'flat',

  'session/list': '_request',

  'session/create': 'request',
  'session/prompt': 'request',
  'session/rename': 'request',
  'session/fork': 'request',
  'session/cancel': 'request',
  'session/selectModel': 'request',
  'session/updateQueue': 'request',
  'session/projections': 'request',
  'session/follow': 'request',
  'workspace/create': 'request',
  'workspace/rename': 'request',
});

export function wrapArgs(method, payload) {
  const inner = isPlainObject(payload) ? payload : {};
  const shape = ARGS_SHAPE[method] ?? 'request';
  if (shape === 'flat') return { args: inner };
  return { args: { [shape]: inner } };
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeBase(baseUrl) {
  return String(baseUrl).replace(/\/+$/, '');
}

async function safeText(response) {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
