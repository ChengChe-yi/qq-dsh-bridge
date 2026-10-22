import { EventEmitter } from 'node:events';
import {
  detectTrigger, gateAllows, normalizeWho, triggerLabel, evaluateWait, waitHit,
} from './gate.js';
import { deliver } from './deliver.js';
import { TurnPool, MARKS, CURSORS, isMarked } from './pool.js';
import { attachPoolFeed } from './pool-feed.js';
import { mentionsId, segmentsToText } from './segments.js';
import { dateOf } from './store.js';
import { markReadByRefs, PHASES } from './read.js';
import { seqOf } from './store.js';

export const STATES = Object.freeze({
  SLEEPING: 'sleeping',
  WAITING: 'waiting',
});

export class ConversationState extends EventEmitter {

  constructor({ key, ownerQq, config = {}, store, onDeliver, logger, judge, decideLog } = {}) {
    super();
    this.key = key;
    this.ownerQq = ownerQq;
    this.config = config;
    this.store = store;
    this.onDeliver = onDeliver;
    this.logger = logger;

    this.judge = judge ?? null;

    this.decideLog = decideLog ?? null;

    this.state = STATES.SLEEPING;
    this.lastDeliverAt = 0;
    this.gatedAt = 0;
    this.activeWait = null;

    this.awakeUntil = 0;

    this.agentRunning = false;

    this.waitedTotalMs = 0;

    this.turnPool = new TurnPool({

      identity: (m) => {
        const date = m?.date ?? dateOf(m?.tsMs);
        const seq = seqOf(m, date);
        return seq === undefined ? '' : `${date}#${seq}`;
      },

      onMarkRead: (refs) => markReadByRefs(this.store, refs, PHASES.PUSH),

      store: this.store,
    });

    this.lastSettleTs = 0;

    this.stats = { woke: 0, delivered: 0, skippedNotTrigger: 0, skippedGate: 0, buffered: 0, idleSleeps: 0, heldByDecide: 0 };

    this.idleTimer = null;
  }

  get sleeping() {
    return this.state === STATES.SLEEPING;
  }

  get awake() {
    return !this.sleeping && Date.now() < this.awakeUntil;
  }

  #touchAwake() {
    this.awakeUntil = Date.now() + this.idleMs;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;

      if (this.activeWait) return;

      if (this.agentRunning) return;
      this.logger?.debug('醒着窗口到期，回睡眠', { key: this.key, idleMs: this.idleMs });
      this.stats.idleSleeps += 1;
      this.sleep();
    }, this.idleMs);

  }

  #clearIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.awakeUntil = 0;
  }

  get idleMs() {
    return Number(this.config.idleMs) > 0 ? Number(this.config.idleMs) : 300_000;
  }

  async accept(stored, message, { selfSent = false } = {}) {
    this.stats.buffered += 1;
    this.emit('message', stored);

    if (selfSent) {
      this.emit('self-sent', { message: stored });
      return { action: 'buffered', reason: 'self-sent', seq: seqOf(stored, stored.date), date: dateOf(stored.tsMs) };
    }

    const kind = String(this.key).startsWith('private:') ? 'private' : 'group';
    const isOwner = String(message.sender?.qq ?? '') === String(this.ownerQq);

    const reason = detectTrigger(
      message.event ?? {},
      kind,
      { atSelf: message.atSelf ?? mentionsId(stored, this.store.selfQq) },
    );

    const phase = this.sleeping ? 'sleeping' : 'awake';
    const hasWait = Boolean(this.activeWait);

    const waiting = hasWait && this.agentRunning;

    if (!this.agentRunning) {
      const gateWho = normalizeWho(this.config.trigger?.who);
      const allowed = gateAllows(gateWho, message.sender?.qq, this.ownerQq) && Boolean(reason);
      if (!allowed) {

        if (!reason) this.stats.skippedNotTrigger += 1;
        else this.stats.skippedGate += 1;
        const why = reason ? 'gate' : 'not-triggered';
        this.emit('buffered', { reason: why, message: stored });
        return { action: 'buffered', reason: why, seq: seqOf(stored, stored.date), date: stored.date };
      }
      if (hasWait) {

        this.logger?.warn('等待中的回合已结束：这条改走正常投递（交给 wait 会被吞掉）', {
          conv: this.key, seq: seqOf(stored, stored.date),
        });
        this.cancelWait();
      }
      this.gatedAt = message.tsMs ?? Date.now();

      const verdict = await this.#decideWake({ message: stored, isOwner });
      if (verdict?.act === 'ignore') {
        this.stats.heldByDecide += 1;
        this.emit('held', { reason: 'decide', message: stored, verdict });
        return {
          action: 'held',
          reason: 'decide',
          verdict: verdict.reason,
          seq: seqOf(stored, stored.date),
          date: stored.date,
        };
      }
      return this.#deliver({ reason, isOwner, message: stored, phase });
    }

    if (waiting) {
      this.#touchAwake();
      this.#refreshWaitTimer();
      this.#notifyWait(stored);
      this.emit('handed-to-wait', { message: stored, reason });
      return { action: 'handed-to-wait', reason, seq: seqOf(stored, stored.date), date: stored.date };
    }

    this.logger?.debug('回合内、没在等 → 入池（等模型开 wait 时再按规则筛）', {
      conv: this.key, seq: seqOf(stored, stored.date), reason,
    });
    return { action: 'buffered', reason: 'pooled', seq: seqOf(stored, stored.date), date: stored.date };
  }

  #judgeInputs(message, { exempt = false } = {}) {
    const judge = this.judge;
    const selfQq = String(this.store?.selfQq ?? '');
    const pool = typeof this.turnPool?.messages === 'function' ? this.turnPool.messages() : [];
    const now = Date.now();
    const isSelf = (m) => String(m?.sender?.qq ?? '') === selfQq;
    const recent = pool.slice(-12).map((m) => ({
      who: isSelf(m) ? (judge?.roleName || '她') : String(m?.sender?.name ?? m?.sender?.qq ?? ''),
      text: segmentsToText(m).slice(0, 80),
      secsAgo: Math.max(0, Math.round((now - (Number(m?.tsMs) || now)) / 1000)),
      self: isSelf(m),
    }));
    const lastSelf = [...pool].reverse().find(isSelf);
    const today = dateOf(now);
    const todayCount = pool.filter((m) => isSelf(m) && dateOf(Number(m?.tsMs) || now) === today).length;
    return {
      now,
      recent,
      state: {
        sinceSelfSec: lastSelf
          ? Math.max(0, Math.round((now - (Number(lastSelf.tsMs) || now)) / 1000))
          : undefined,
        todayCount,
      },
      atMe: Boolean(message?.atSelf) || mentionsId(message, selfQq),
      exempt,
      triggerText: message ? segmentsToText(message).slice(0, 120) : '',
      seq: message ? seqOf(message, message.date) : '',
    };
  }

  async #decideWake({ message, isOwner }) {
    const judge = this.judge;
    if (typeof judge?.enabled !== 'function' || !judge.enabled()) return null;

    const enforce = judge.mode === 'enforce';
    const { now, recent, state, atMe, triggerText, seq } = this.#judgeInputs(message);

    const note = (v) => this.decideLog?.write({

      ts: Date.now(),
      startedTs: now,
      conv: this.key,
      kind: 'wake',
      mode: judge.mode,
      enforced: enforce,
      act: v.act,
      reason: v.reason,
      ms: v.ms,
      sysHash: judge.sysHash,
      seq,
      trigger: { who: String(message.sender?.qq ?? ''), atMe, isOwner, text: triggerText.slice(0, 60) },
      state,
      usage: v.usage
        ? {
          hit: v.usage.prompt_cache_hit_tokens,
          miss: v.usage.prompt_cache_miss_tokens,
          total: v.usage.total_tokens,
          credit: v.usage.credit,
        }
        : undefined,
      error: v.error,
    });

    if (enforce && isOwner && judge.ownerAlways) {
      const short = { act: 'reply', reason: '主人直放', ms: 0 };
      note(short);
      return short;
    }

    const run = async () => {
      const v = await judge.decide({
        kind: 'wake',
        recent,
        trigger: {
          who: String(message.sender?.name ?? message.sender?.qq ?? ''),
          text: triggerText,
          atMe,
          isOwner,
        },
        state,
      });
      note(v);

      return ['ignore', 'reply'].includes(v.act) ? v : null;
    };

    if (enforce) return run();

    void run().catch((error) => this.logger?.debug('决策层异常', { conv: this.key, error: String(error) }));
    return null;
  }

  #decideWaitReturn(w, message) {
    const judge = this.judge;
    if (typeof judge?.enabled !== 'function' || !judge.enabled()) {
      this.#settleWait('arrived');
      return;
    }
    const enforce = judge.mode === 'enforce';
    const { now, recent, state, atMe, triggerText, seq } = this.#judgeInputs(message);
    const who = String(message?.sender?.name ?? message?.sender?.qq ?? '');
    const note = (v) => this.decideLog?.write({
      ts: Date.now(),
      startedTs: now,
      conv: this.key,
      kind: 'wait',
      mode: judge.mode,
      enforced: enforce,
      act: v.act,
      reason: v.reason,
      ms: v.ms,
      sysHash: judge.hashOf('wait'),
      seq,
      trigger: { who: String(message?.sender?.qq ?? ''), atMe, text: triggerText.slice(0, 60) },
      state,
      waitedMs: Math.max(0, Date.now() - (Number(w.waitedFromTs) || Date.now())),
      usage: v.usage
        ? {
          hit: v.usage.prompt_cache_hit_tokens,
          miss: v.usage.prompt_cache_miss_tokens,
          total: v.usage.total_tokens,
          credit: v.usage.credit,
        }
        : undefined,
      error: v.error,
    });
    const ask = () => judge.decide({
      kind: 'wait', recent, trigger: { who, text: triggerText, atMe }, state,
    });

    if (!enforce) {
      void ask().then(note).catch((error) => this.logger?.debug('决策层异常', { conv: this.key, error: String(error) }));
      this.#settleWait('arrived');
      return;
    }

    if (w.deciding) return;
    w.deciding = true;
    void ask()
      .then((v) => {
        w.deciding = false;
        note(v);

        if (this.activeWait !== w) return;

        if (v.act !== 'keep') this.#settleWait('arrived');
      })
      .catch((error) => {
        w.deciding = false;
        this.logger?.debug('决策层异常', { conv: this.key, error: String(error) });
        if (this.activeWait === w) this.#settleWait('arrived');
      });
  }

  async #deliver({ reason, isOwner, message }) {
    const wasSleeping = this.sleeping;
    this.state = STATES.WAITING;
    if (wasSleeping) this.stats.woke += 1;

    this.#touchAwake();

    const deliverLimit = this.config.wakeLimit ?? 60;

    const { messages: contextItems } = this.#takeMessages(deliverLimit);

    const delivery = deliver(this.store, {
      items: contextItems,
      triggerSeq: seqOf(message, message.date),
      triggerDate: message.date,
      maxChars: this.config.maxChars,

      maxDays: this.config.maxDays,

      selfQq: this.store.selfQq,

      ownerQq: this.ownerQq,
    });

    this.lastDeliverAt = Date.now();
    this.stats.delivered += 1;

    const meta = {
      key: this.key,
      reason,
      label: triggerLabel(reason, isOwner),
      isOwner,
      woke: wasSleeping,

      injectRole: wasSleeping,

      triggerBy: {
        qq: String(message.sender?.qq ?? ''),
        name: message.sender?.name ?? '',
        isOwner,
      },
    };

    this.emit('delivered', { delivery, ...meta });

    if (this.onDeliver) {

      try {
        await this.onDeliver(delivery, meta);
      } catch (error) {
        this.logger?.warn('投递失败 —— 不标已读，下次重投', {
          conv: this.key, count: delivery.items?.length ?? 0, error: String(error),
        });
        throw error;
      }

      if (delivery.items?.length) {

        const rendered = delivery.context?.count ?? 0;
        const shown = rendered > 0 ? delivery.items.slice(-rendered) : [];

        this.turnPool.markRead(shown);

        this.turnPool.mark(shown, MARKS.DELIVERED);

        this.turnPool.advancePast(CURSORS.WAIT, this.turnPool.all());
      }
    }

    return { action: wasSleeping ? 'woke' : 'delivered', reason, delivery, meta };
  }

  waitForMessages({ timeoutMs = 300_000, maxMs = 1_800_000, quietMs = 0, qq } = {}) {

    if (this.activeWait) return this.activeWait.promise;

    this.#touchAwake();

    const waitedFromTs = Date.now();

    const idleMs = Math.max(1, Number(timeoutMs) || 300_000);
    const capMs = Math.max(idleMs, Number(maxMs) || idleMs);
    let resolveFn;
    const promise = new Promise((resolve) => { resolveFn = resolve; });

    const timer = setTimeout(() => this.#settleWait('timeout'), idleMs);
    timer.unref?.();

    const capTimer = setTimeout(() => this.#settleWait('timeout'), capMs);
    capTimer.unref?.();

    const wanted = (Array.isArray(qq) ? qq : (qq === undefined ? [] : [qq]))
      .map((v) => String(v ?? '').trim())
      .filter(Boolean);
    const wantMention = this.config.waitRequireMention !== false;

    this.activeWait = {
      promise, resolveFn, waitedFromTs, timeoutMs: idleMs, maxMs: capMs, quietMs, timer, capTimer,

      qq: wanted,

      requireMention: wantMention,

      lastActivityTs: waitedFromTs,
    };
    this.state = STATES.WAITING;
    this.emit('wait-start', { timeoutMs: idleMs, maxMs: capMs, sinceTs: waitedFromTs });

    if (this.#poolWake()) {
      const t = setTimeout(() => this.#settleWait('arrived'), 0);
      t.unref?.();
    }
    return promise;
  }

  #refreshWaitTimer() {
    const w = this.activeWait;
    if (!w) return false;
    const now = Date.now();

    if (now - w.waitedFromTs >= w.maxMs) return false;

    w.lastActivityTs = now;
    clearTimeout(w.timer);
    w.timer = setTimeout(() => this.#settleWait('timeout'), w.timeoutMs);
    w.timer.unref?.();
    this.emit('wait-refresh', { lastActivityTs: now, nextMs: w.timeoutMs });
    return true;
  }

  #waitRuleAllows(m) {
    const w = this.activeWait;
    if (!w) return false;
    return waitHit(m, {
      selfQq: this.store.selfQq,
      who: normalizeWho(this.config.window?.who),
      ownerQq: this.ownerQq,
      qq: w.qq,
      requireMention: w.requireMention,
    });
  }

  #poolWake() {

    return this.turnPool
      .sinceMessages(CURSORS.WAIT)
      .some((m) => this.#waitRuleAllows(m));
  }

  #notifyWait(message) {
    const w = this.activeWait;
    if (!w) return;
    if (message && !this.#waitRuleAllows(message)) return;

    if (w.quietMs > 0) {
      if (w.recheckTimer) clearTimeout(w.recheckTimer);
      w.recheckTimer = setTimeout(() => this.#settleWait('arrived'), w.quietMs);
      w.recheckTimer.unref?.();
      return;
    }
    this.#decideWaitReturn(w, message);
  }

  #takeMessages(limit) {
    const self = String(this.store.selfQq ?? '');
    const fromPool = [];
    const takenIds = new Set();
    let omitted = 0;

    for (const it of this.turnPool.pick((e) => e.kind === 'message').reverse()) {
      const m = it.msg;
      if (!m) continue;

      if (self !== '' && String(m.sender?.qq ?? '') === self) continue;

      if (this.#isRead(it)) break;
      if (fromPool.length < limit) {
        fromPool.push({ ...m, date: dateOf(m.tsMs) });
        if (it.id) takenIds.add(it.id);
      } else omitted += 1;
    }

    if (fromPool.length >= limit) return { messages: fromPool.reverse(), omitted };

    const older = this.#scanStore(limit - fromPool.length, takenIds);
    return {
      messages: [...older.messages, ...fromPool.reverse()],
      omitted: omitted + older.omitted,
    };
  }

  #isRead(it) {
    return (it.msg?.readCount ?? 0) > 0 || isMarked(it, MARKS.READ);
  }

  #scanStore(limit, skipIds = new Set()) {
    const self = String(this.store.selfQq ?? '');
    const taken = [];
    let omitted = 0;
    let stopped = false;
    for (const date of this.store.dates().slice().reverse()) {
      if (stopped) break;
      const doc = this.store.load(date);
      for (let i = doc.messages.length - 1; i >= 0; i -= 1) {
        const m = doc.messages[i];

        if (self !== '' && String(m.sender?.qq ?? '') === self) continue;

        const seq = seqOf(m, date);
        if (seq !== undefined && skipIds.has(`${date}#${seq}`)) continue;

        if ((m.readCount ?? 0) > 0) { stopped = true; break; }

        if (taken.length < limit) taken.push({ ...m, date });
        else omitted += 1;
      }
    }
    taken.reverse();
    return { messages: taken, omitted };
  }

  #settleWait(how) {
    const w = this.activeWait;
    if (!w) return;
    this.activeWait = null;
    clearTimeout(w.timer);

    if (w.capTimer) clearTimeout(w.capTimer);
    if (w.recheckTimer) clearTimeout(w.recheckTimer);

    this.waitedTotalMs = (this.waitedTotalMs || 0) + Math.max(0, Date.now() - w.waitedFromTs);

    this.lastSettleTs = Date.now();

    const takeLimit = Number(this.config.replyLimit) > 0 ? Number(this.config.replyLimit) : 20;
    const { messages: taken, omitted } = this.#takeMessages(takeLimit);

    const evalWho = normalizeWho(this.config.window?.who);

    const evaluation = evaluateWait({
      who: evalWho,
      ownerQq: this.ownerQq,

      messages: taken,
      selfQq: this.store.selfQq,

      qq: w.qq,
      requireMention: w.requireMention,
    });

    const result = {

      arrived: evaluation.arrived,
      timeout: how === 'timeout' && !evaluation.arrived,
      from: evaluation.from,

      messages: evaluation.messages,

      newMessages: evaluation.arrived ? taken : [],

      omitted: evaluation.arrived ? omitted : 0,

      waitedMs: Date.now() - w.waitedFromTs,
    };

    if (result.newMessages.length) {

      if (this.agentRunning === false) {
        this.logger?.warn('qq_wait 返回时回合已结束：这批不标已读（结果没人接）', {
          conv: this.key, count: result.newMessages.length,
        });
      } else {

        this.turnPool.markRead(result.newMessages);

        this.turnPool.mark(result.newMessages, MARKS.DELIVERED);
      }
    }

    this.emit('wait-end', result);
    w.resolveFn(result);

    this.turnPool.advancePast(CURSORS.WAIT, this.turnPool.all());
  }

  cancelWait() {
    if (this.activeWait) {
      this.#noteWaitEnd('cancelled');
      this.#settleWait('cancelled');
    }
    this.#clearIdle();
    this.state = STATES.SLEEPING;
  }

  sleep() {
    if (this.activeWait) {
      this.#noteWaitEnd('sleep');
      this.#settleWait('cancelled');
    }
    this.#clearIdle();
    this.state = STATES.SLEEPING;
    this.agentRunning = false;
    this.emit('sleep');
  }

  #noteWaitEnd(how) {
    const w = this.activeWait;
    if (!w) return;
    this.decideLog?.write({
      ts: Date.now(),
      conv: this.key,
      kind: 'wait-end',
      mode: this.judge?.mode ?? 'off',
      act: how,
      reason: how === 'sleep' ? '回合结束' : '外部中断',
      ms: Math.max(0, Date.now() - (Number(w.waitedFromTs) || Date.now())),
      waitedMsQueued: Number(w.qq?.length) || 0,
      qq: Array.isArray(w.qq) ? w.qq : [],
    });
  }

  setAgentRunning(running, source = 'unknown') {
    const next = Boolean(running);
    if (this.agentRunning === next) return;
    this.agentRunning = next;
    this.logger?.debug('agent 运行状态', {
      conv: this.key, agentRunning: next, source, activeWait: Boolean(this.activeWait),
    });
    if (next) {

      this.#touchAwake();
      return;
    }

    this.waitedTotalMs = 0;
    if (!this.activeWait && this.awake) this.#touchAwake();
  }

  nextWaitMs() {
    const perCall = Number(this.config.waitDefaultMs) > 0
      ? Number(this.config.waitDefaultMs)
      : 300_000;
    const total = Number(this.config.waitMaxMs) > 0
      ? Number(this.config.waitMaxMs)
      : 1_800_000;
    const remaining = total - (this.waitedTotalMs || 0);
    return Math.max(0, Math.min(perCall, remaining));
  }

  snapshot() {
    return {
      key: this.key,
      state: this.state,
      waiting: Boolean(this.activeWait),
      awake: this.awake,
      awakeForMs: this.awake ? Math.max(0, this.awakeUntil - Date.now()) : 0,
      agentRunning: this.agentRunning,
      lastDeliverAt: this.lastDeliverAt,
      gatedAt: this.gatedAt,

      pooled: this.turnPool.size,
      stats: { ...this.stats },
    };
  }

}

export class ConversationRegistry {

  constructor({ ownerQq, config, storeFor, onDeliver, onConversationCreated, logger, judge, decideLog } = {}) {
    this.ownerQq = ownerQq;
    this.config = config;
    this.storeFor = storeFor;
    this.onDeliver = onDeliver;
    this.onConversationCreated = onConversationCreated;
    this.logger = logger;

    this.judge = judge ?? null;
    this.decideLog = decideLog ?? null;
    this.conversations = new Map();
  }

  get(key) {
    let c = this.conversations.get(key);
    if (!c) {
      const store = this.storeFor(key);
      c = new ConversationState({
        key,
        ownerQq: this.ownerQq,
        config: this.config,
        store,
        onDeliver: this.onDeliver,
        logger: this.logger,
        judge: this.judge,
        decideLog: this.decideLog,
      });

      attachPoolFeed(store, c.turnPool);
      this.conversations.set(key, c);
      this.logger?.debug('已创建会话状态机', { key, state: c.state });

      try {
        this.onConversationCreated?.(key);
      } catch (error) {
        this.logger?.warn('新会话回调失败', { key, error: String(error) });
      }
    }
    return c;
  }

  conversationFor(convKey) {
    return this.get(convKey);
  }

  snapshot() {
    return [...this.conversations.values()].map((c) => c.snapshot());
  }

  applyConfig(config) {
    this.config = config;
    for (const c of this.conversations.values()) c.config = config;
  }

  shutdown() {
    for (const c of this.conversations.values()) c.cancelWait();
  }
}
