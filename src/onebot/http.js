import { unwrapResponse } from './parse.js';

export class OneBotActionError extends Error {
  constructor(message, { action, retcode, status, hint } = {}) {
    super(message);
    this.name = 'OneBotActionError';
    this.action = action;
    this.retcode = retcode;
    this.status = status;
    this.hint = hint;
  }
  toString() {
    const bits = [this.name + ': ' + this.message];
    if (this.action) bits.push(`  action: ${this.action}`);
    if (this.retcode !== undefined && this.retcode !== null) bits.push(`  retcode: ${this.retcode}`);
    if (this.status) bits.push(`  status: ${this.status}`);
    if (this.hint) bits.push(`  ${this.hint}`);
    return bits.join('\n');
  }
}

const RETCODE_HINTS = {
  1: '异步动作已提交，结果需另查',
  100: '参数格式错误',
  102: '参数缺失或类型不对',
  103: '动作未实现 —— 该动作不被当前 OneBot 实现支持',
  104: '权限不足（可能是机器人不是管理员）',
  200: '机器人账号被禁言或不可用',
  201: '消息内容为空',
  202: '消息过长',
  203: '发送失败（可能被风控）',
};

export class OneBotHttpClient {

  constructor({ httpUrl, accessToken = '', timeoutMs = 30_000, logger, fetch: fetchImpl = globalThis.fetch } = {}) {
    this.httpUrl = normalizeBase(httpUrl);
    this.accessToken = accessToken;
    this.timeoutMs = timeoutMs;
    this.logger = logger;
    this.fetch = fetchImpl;

    this.consecutiveFailures = 0;
  }

  applyConfig({ httpUrl, accessToken, timeoutMs } = {}) {
    if (httpUrl !== undefined) this.httpUrl = normalizeBase(httpUrl);
    if (accessToken !== undefined) this.accessToken = accessToken;
    if (timeoutMs !== undefined) this.timeoutMs = timeoutMs;
  }

  async call(action, params = {}, { signal, timeoutMs } = {}) {
    if (!this.httpUrl) {
      throw new OneBotActionError('未配置 OneBot HTTP 地址', { action });
    }

    const url = `${this.httpUrl}/`;
    const body = JSON.stringify({ action, params, echo: action });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? this.timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    let response;
    try {
      const headers = { 'content-type': 'application/json' };
      if (this.accessToken) headers.authorization = `Bearer ${this.accessToken}`;
      response = await this.fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
    } catch (error) {
      this.consecutiveFailures += 1;
      if (error?.name === 'AbortError') {
        throw new OneBotActionError(`动作 ${action} 超时（${timeoutMs ?? this.timeoutMs}ms）`, {
          action,
          hint: 'SnowLuma 可能在忙于 member warmup（上千成员建档会占满事件循环，实测拖过 72 秒）。',
        });
      }
      throw new OneBotActionError(`动作 ${action} 请求失败：${error.message}`, {
        action,
        hint: '确认 SnowLuma 在运行、snowluma.httpUrl 指向正确的端口。',
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }

    if (response.status === 401 || response.status === 403) {
      this.consecutiveFailures += 1;
      throw new OneBotActionError(`动作 ${action} 鉴权被拒（HTTP ${response.status}）`, {
        action,
        status: response.status,
        hint: 'SnowLuma 的 HTTP token 与 WS token 是两个不同的值，'
          + 'httpServers.accessToken 用于这里、wsServers.accessToken 用于事件连接，不能混用。',
      });
    }
    if (!response.ok) {
      this.consecutiveFailures += 1;
      const text = await safeText(response);
      throw new OneBotActionError(`动作 ${action} 返回 HTTP ${response.status}`, {
        action,
        status: response.status,
        hint: text.slice(0, 200),
      });
    }

    let json;
    try {
      json = await response.json();
    } catch (error) {
      this.consecutiveFailures += 1;
      throw new OneBotActionError(`动作 ${action} 的响应不是 JSON：${error.message}`, { action });
    }

    const result = unwrapResponse(json);
    if (!result.ok) {
      this.consecutiveFailures += 1;
      throw new OneBotActionError(
        `动作 ${action} 失败：${result.message || '未知错误'}`,
        {
          action,
          retcode: result.retcode,
          status: json.status,
          hint: RETCODE_HINTS[result.retcode] ?? '',
        },
      );
    }

    this.consecutiveFailures = 0;
    return result.data;
  }

  async probeStatus(options = {}) {
    const data = await this.call('get_status', {}, options);
    return {
      online: Boolean(data?.online),
      good: Boolean(data?.good),
      raw: data,
    };
  }

  async getLoginInfo(options = {}) {
    return this.call('get_login_info', {}, options);
  }

  async deleteMessage(messageId, options = {}) {
    const id = String(messageId ?? '').trim();
    if (id === '') throw new Error('delete_msg 需要 message_id');
    return this.call('delete_msg', { message_id: id }, options);
  }

  async setNickname(nickname, options = {}) {
    const name = String(nickname ?? '');
    if (name.trim() === '') throw new Error('set_qq_profile 需要 nickname（不能为空）');
    return this.call('set_qq_profile', { nickname: name }, options);
  }

  async setGroupCard(groupId, userId, card, options = {}) {
    const gid = Number(groupId);
    const uid = Number(userId);
    if (!Number.isFinite(gid) || gid <= 0) throw new Error('set_group_card 需要 group_id');
    if (!Number.isFinite(uid) || uid <= 0) {

      throw new Error('set_group_card 需要 user_id（本号；拿不到就不该改）');
    }
    if (card === undefined || card === null) {
      throw new Error("set_group_card 需要 card —— 要**清空**名片就传空字符串 ''，这不是「没传」");
    }
    return this.call('set_group_card', { group_id: gid, user_id: uid, card: String(card) }, options);
  }

  async getImageUrl(file, options = {}) {
    const f = String(file ?? '').trim();
    if (f === '') return null;
    try {
      const data = await this.call('get_image', { file: f }, options);

      const url = typeof data === 'string' ? data : (data?.url ?? data?.file ?? '');
      return url ? String(url) : null;
    } catch {

      return null;
    }
  }

  async getMessage(messageId, options = {}) {
    const id = String(messageId ?? '').trim();
    if (id === '') return null;
    try {
      return await this.call('get_msg', { message_id: id }, options);
    } catch {
      return null;
    }
  }

  async getForwardMessages(id, options = {}) {
    const fid = String(id ?? '').trim();
    if (fid === '') return null;
    try {
      const data = await this.call('get_forward_msg', { id: fid }, options);
      return data ?? null;
    } catch {
      return null;
    }
  }
}

function normalizeBase(url) {
  return String(url ?? '').replace(/\/+$/, '');
}

async function safeText(response) {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
