import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

export const FOLLOW_SNAPSHOT_MESSAGES = 200;

export const EVENTS_ENDPOINT = '$events';

const RESUBSCRIBE_DELAY_MS = 2000;

export class DshStreamError extends Error {
  constructor(message, { hint = '' } = {}) {
    super(message);
    this.name = 'DshStreamError';
    this.hint = hint;
  }
  toString() {
    return this.hint ? `${this.name}: ${this.message}\n  ${this.hint}` : `${this.name}: ${this.message}`;
  }
}

export class DshEventStream extends EventEmitter {

  constructor({
    dsh,
    logger,
    WebSocketImpl = globalThis.WebSocket,
    resubscribeDelayMs = RESUBSCRIBE_DELAY_MS,
    reconnectBaseMs = 1000,
  } = {}) {
    super();
    this.dsh = dsh;
    this.logger = logger;
    this.WebSocket = WebSocketImpl;
    this.resubscribeDelayMs = resubscribeDelayMs;
    this.reconnectBaseMs = reconnectBaseMs;

    this.ws = null;
    this.stopped = false;
    this.socketOpen = false;

    this.desiredFollows = new Set();

    this.streamToSession = new Map();

    this.sessionToStream = new Map();
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;

    this.eventsStreamId = null;

    this.remoteClientId = null;
  }

  async start() {
    if (this.ws) return;
    this.stopped = false;
    await this.#connect();
  }

  async #connect() {
    if (this.stopped) return;

    let cookie;
    try {
      const c = await this.dsh.ensureAuth();
      cookie = `${c.name}=${c.value}`;
    } catch (error) {
      this.logger?.warn('事件流：鉴权失败，稍后重试', { error: String(error) });
      this.#scheduleReconnect();
      return;
    }

    const url = `${this.dsh.baseUrl.replace(/^http/, 'ws')}/api/remote.mux`;
    let ws;
    try {

      ws = new this.WebSocket(url, { headers: { cookie } });
    } catch (error) {
      this.logger?.warn('事件流：无法建立连接', { url, error: String(error) });
      this.#scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener('open', () => {
      if (this.stopped) return;
      this.socketOpen = true;
      this.reconnectAttempts = 0;
      this.logger?.info('事件流已连接', { url });
      this.emit('open');

      for (const sessionId of this.desiredFollows) this.#sendOpen(sessionId);

      this.#sendEventsOpen();
    });

    ws.addEventListener('message', (ev) => this.#onFrame(ev));

    ws.addEventListener('close', () => {
      if (this.stopped) return;
      this.socketOpen = false;
      this.ws = null;

      this.streamToSession.clear();
      this.sessionToStream.clear();

      this.eventsStreamId = null;
      this.remoteClientId = null;
      this.logger?.warn('事件流断开', { attempt: this.reconnectAttempts + 1 });
      this.#scheduleReconnect();
    });

    ws.addEventListener('error', (ev) => {

      this.logger?.warn('事件流错误', { message: ev?.message ?? '' });
    });
  }

  #scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectAttempts += 1;

    const delay = Math.min(this.reconnectBaseMs * 2 ** (this.reconnectAttempts - 1), 30_000);
    this.logger?.info('事件流计划重连', { attempt: this.reconnectAttempts, delayMs: delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.#connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  follow(sessionId) {
    const sid = String(sessionId);
    this.desiredFollows.add(sid);
    if (this.socketOpen) this.#sendOpen(sid);
    return this;
  }

  unfollow(sessionId) {
    const sid = String(sessionId);
    this.desiredFollows.delete(sid);
    const streamId = this.sessionToStream.get(sid);
    if (streamId) {
      this.sessionToStream.delete(sid);
      this.streamToSession.delete(streamId);

    }
    return this;
  }

  #sendOpen(sessionId) {
    if (this.stopped || !this.socketOpen || !this.ws) return;
    if (this.sessionToStream.has(sessionId)) return;

    const streamId = crypto.randomUUID();
    this.streamToSession.set(streamId, sessionId);
    this.sessionToStream.set(sessionId, streamId);

    try {
      this.ws.send(JSON.stringify({
        type: 'open',
        streamId,
        endpoint: 'session/follow',
        payload: {
          args: {
            request: {

              address: { kind: 'session', sessionId },
              maxMessages: FOLLOW_SNAPSHOT_MESSAGES,
            },
          },
        },
      }));
      this.logger?.debug('已订阅会话事件流', { sessionId });
    } catch (error) {

      this.sessionToStream.delete(sessionId);
      this.streamToSession.delete(streamId);
      this.logger?.warn('订阅失败', { sessionId, error: String(error) });
    }
  }

  #onFrame(event) {
    let msg;
    try {
      if (typeof event.data !== 'string') throw new Error('binary frame');
      msg = JSON.parse(event.data);
      if (!msg || typeof msg.type !== 'string') throw new Error('unexpected frame');
    } catch (error) {
      this.logger?.debug('丢弃无法解析的事件流帧', { error: String(error) });
      return;
    }

    if (msg.streamId === this.eventsStreamId) {
      this.#onEventsFrame(msg);
      return;
    }

    const sessionId = this.streamToSession.get(msg.streamId);

    if (msg.type === 'item') {
      const v = msg.value;

      if (sessionId && v?.type === 'snapshot') {
        this.emit('snapshot', { sessionId, snapshot: v });
        return;
      }
      if (sessionId && v?.type === 'event') {
        this.emit('event', { sessionId, event: v.event });
        return;
      }

      return;
    }

    if (msg.type === 'end') {
      if (!sessionId) return;
      this.#forgetStream(msg.streamId, sessionId);
      this.emit('stream-end', { sessionId });

      if (this.desiredFollows.has(sessionId)) {
        this.logger?.warn('会话事件流被服务端结束，将重新订阅', { sessionId });
        const t = setTimeout(() => {
          if (!this.stopped && this.desiredFollows.has(sessionId)) this.#sendOpen(sessionId);
        }, this.resubscribeDelayMs);
        t.unref?.();
      }
      return;
    }

    if (msg.type === 'error') {
      if (sessionId) {
        this.#forgetStream(msg.streamId, sessionId);
        this.emit('stream-error', { sessionId, error: msg.error });

        if (msg.error?.code === 'session/not-found') {
          this.desiredFollows.delete(sessionId);
          this.logger?.warn('会话不存在，取消订阅', { sessionId });
        } else {
          this.logger?.warn('会话事件流出错，将重试', { sessionId, code: msg.error?.code });

          this.emit('stream-failed', {
            error: new DshStreamError(`会话流错误：${msg.error?.message ?? msg.error?.code ?? '未知'}`),
          });
        }
      } else {
        this.logger?.warn('事件流出错（未关联会话）', { code: msg.error?.code });
      }
    }
  }

  #forgetStream(streamId, sessionId) {
    this.streamToSession.delete(streamId);
    this.sessionToStream.delete(sessionId);
  }

  #sendEventsOpen() {
    if (this.stopped || !this.socketOpen || !this.ws) return;
    if (this.eventsStreamId) return;
    const streamId = crypto.randomUUID();
    this.eventsStreamId = streamId;
    try {
      this.ws.send(JSON.stringify({
        type: 'open',
        streamId,
        endpoint: EVENTS_ENDPOINT,

        payload: { args: {} },
      }));
      this.logger?.debug('已订阅全局 agent 状态流', { endpoint: EVENTS_ENDPOINT });
    } catch (error) {
      this.eventsStreamId = null;
      this.logger?.warn('订阅全局状态流失败', { error: String(error) });
    }
  }

  #onEventsFrame(msg) {

    const reopen = (why) => {
      this.eventsStreamId = null;
      this.remoteClientId = null;
      const t = setTimeout(() => {
        if (!this.stopped) this.#sendEventsOpen();
      }, this.resubscribeDelayMs);
      t.unref?.();
      this.logger?.warn('全局状态流中断，将重新订阅', { why });
    };

    if (msg.type === 'end') return reopen('end');
    if (msg.type === 'error') {
      this.logger?.warn('全局状态流出错', { code: msg.error?.code, message: msg.error?.message });
      return reopen(msg.error?.code ?? 'error');
    }
    if (msg.type !== 'item') return;

    const v = msg.value;
    if (v?.type === 'ready') {

      this.remoteClientId = v.clientId ?? null;
      this.logger?.info('全局 agent 状态流就绪', { host: v.host?.home ?? '' });
      this.emit('agent-feed-ready', { clientId: this.remoteClientId, host: v.host ?? null });
      return;
    }
    if (v?.type === 'emit') {
      this.emit('agent-event', { event: v.event, args: v.args ?? [] });

      if (v.event === 'api-session/status' && Array.isArray(v.args)) {
        this.emit('agent-status', { sessionId: String(v.args[0] ?? ''), running: v.args[1] === true });
      } else if (v.event === 'api-session/activity' && Array.isArray(v.args)) {
        this.emit('agent-activity', { sessionId: String(v.args[0] ?? ''), at: v.args[1] ?? null });
      }
      return;
    }
    if (v?.type === 'waterfall') {
      this.emit('remote-event', { event: v.event, agentId: v.agentId, request: v.request });
      void this.#answerRemoteEvent(v);
      return;
    }
  }

  async #answerRemoteEvent(frame) {
    if (!this.remoteClientId || !frame?.eventId) return;
    try {
      await this.dsh.call('$events/result', {
        clientId: this.remoteClientId,
        eventId: frame.eventId,
        outcome: { kind: 'next' },
      });
      this.emit('remote-event-answered', { event: frame.event });
      this.logger?.debug('已回 remote event（kind: next）', { event: frame.event });
    } catch (error) {

      this.logger?.warn('回 remote event 失败', { event: frame.event, error: String(error) });
    }
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    try {
      this.ws?.close?.();
    } catch {  }
    this.ws = null;
    this.socketOpen = false;
    this.emit('closed');
  }
}
