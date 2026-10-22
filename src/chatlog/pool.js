import { dateOf, seqOf } from './store.js';
import { deriveMsgType, textOf } from './segments.js';

export const DEFAULT_LIMIT = 500;

export const POKE_MERGE_MS = 10_000;

export const MARKS = Object.freeze({

  DELIVERED: 'delivered',

  READ: 'read',
});

export const CURSORS = Object.freeze({

  RECALL: 'recall',

  REACTION: 'reaction',

  POKE: 'poke',

  WAIT: '*wait',
});

export const KINDS = Object.freeze({
  MESSAGE: 'message',
  RECALL: 'recall',
  REACTION: 'reaction',
  POKE: 'poke',
});

function str(v) {
  return v === undefined || v === null ? '' : String(v).trim();
}

function toMs(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n < 1e12 ? Math.round(n * 1000) : n;
}

function sameSubject(a, b) {
  const x = a?.subject?.messageId;
  const y = b?.subject?.messageId;
  return Boolean(x) && x === y;
}

function tsOf(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const raw = String(value).trim();
  if (raw !== '' && /^-?\d+$/.test(raw)) return toMs(raw, fallback);
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeSearch(filters = {}) {
  const qqIn = filters.qq ?? filters.sender;
  const qqSet = new Set(
    (Array.isArray(qqIn) ? qqIn : (qqIn === undefined || qqIn === null ? [] : [qqIn]))
      .map((v) => str(v))
      .filter(Boolean),
  );

  const fromTs = filters.from !== undefined
    ? tsOf(filters.from, Number.NEGATIVE_INFINITY)
    : (filters.since !== undefined ? Number(filters.since) * 1000 : Number.NEGATIVE_INFINITY);
  const toTs = filters.to !== undefined
    ? tsOf(filters.to, Number.POSITIVE_INFINITY)
    : (filters.until !== undefined ? Number(filters.until) * 1000 : Number.POSITIVE_INFINITY);

  let seqLo = null;
  let seqHi = null;
  if (filters.seq !== undefined && filters.seq !== null) {
    const arr = Array.isArray(filters.seq) ? filters.seq : [filters.seq];
    seqLo = str(arr[0]);
    seqHi = str(arr.length > 1 ? arr[arr.length - 1] : arr[0]);
    if (seqLo === '' || seqHi === '') seqLo = null;
  }
  const bySeq = seqLo !== null;

  const numericSeq = bySeq && /^-?\d+$/.test(seqLo) && /^-?\d+$/.test(seqHi);

  return {
    qqSet,
    role: str(filters.role),
    kinds: Array.isArray(filters.kinds) ? filters.kinds.map(str).filter(Boolean) : [],
    unreadOnly: filters.unreadOnly === true,
    readRounds: filters.readRounds && typeof filters.readRounds === 'object' ? filters.readRounds : null,
    includeRecalled: filters.includeRecalled !== false,
    excludeRecalled: filters.excludeRecalled === true,
    dates: Array.isArray(filters.dates) ? filters.dates.map(str).filter(Boolean) : [],
    fromTs,
    toTs,
    needle: str(filters.contains).toLowerCase(),
    seqLo,
    seqHi,
    bySeq,
    numericSeq,
    cap: bySeq ? Number.POSITIVE_INFINITY : Math.max(1, Number(filters.limit) || 50),
    order: filters.order === 'asc' ? 'asc' : 'desc',
  };
}

function matchesSearch(m, seq, f) {
  if (!m) return false;
  const readCount = m.readCount ?? 0;

  if (f.unreadOnly && readCount !== 0) return false;
  if (f.readRounds) {
    const { eq, min, max } = f.readRounds;
    if (eq !== undefined && readCount !== eq) return false;
    if (min !== undefined && readCount < min) return false;
    if (max !== undefined && readCount > max) return false;
  }
  if (f.qqSet.size && !f.qqSet.has(str(m.sender?.qq))) return false;
  if (f.role && m.sender?.groupRole !== f.role) return false;
  if (f.kinds.length && !f.kinds.includes(deriveMsgType(m))) return false;

  const recalled = Boolean(m.state?.recalled);
  if (f.excludeRecalled && recalled) return false;
  if (!f.includeRecalled && recalled) return false;

  const ts = Number(m.tsMs ?? 0);
  if (ts < f.fromTs || ts > f.toTs) return false;

  if (f.bySeq) {
    const v = String(seq ?? '');
    const hit = f.numericSeq
      ? Number(v) >= Number(f.seqLo) && Number(v) <= Number(f.seqHi)
      : v >= f.seqLo && v <= f.seqHi;
    if (!hit) return false;
  }

  if (f.needle) {
    const hay = `${textOf(m)} ${m.sender?.name ?? ''}`.toLowerCase();
    if (!hay.includes(f.needle)) return false;
  }
  return true;
}

function splitId(id) {
  const s = typeof id === 'string' ? id : '';

  if (s.length < 12) return null;
  const date = s.slice(0, 10);
  const seq = s.slice(11);
  return seq === '' ? null : { date, seq };
}

export function isMarked(entry, name) {
  return Boolean(entry?.marks?.[name]);
}

function scopeOfCursor(name) {
  const key = String(name ?? '').trim();
  if (key === '') throw new TypeError('TurnPool: 水位线名不能为空');
  if (key.startsWith('*')) {

    if (key.length < 2) throw new TypeError(`TurnPool: 水位线名「${name}」只有 * 没有用途`);
    return { all: true };
  }
  const i = key.indexOf(':');
  const kind = i >= 0 ? key.slice(0, i) : key;
  if (kind === '') throw new TypeError(`TurnPool: 水位线名「${name}」里没有事件类型`);
  return { all: false, kind };
}

export class TurnPool {

  constructor({ limit = DEFAULT_LIMIT, now = Date.now, identity = null, onMarkRead = null, store = null } = {}) {
    this.#limitOf = typeof limit === 'function' ? limit : () => limit;
    this.#now = now;
    this.#identity = typeof identity === 'function' ? identity : null;
    this.#onMarkRead = typeof onMarkRead === 'function' ? onMarkRead : null;

    this.#store = store && typeof store === 'object' ? store : null;
    this.#items = [];
    this.#seq = 0;
    this.#cursors = new Map();
    this.#typeSeq = new Map();
  }

  #items;
  #limitOf;
  #now;
  #identity;
  #onMarkRead;
  #store;
  #seq;

  #cursors;

  #typeSeq;

  get limit() {
    return Math.max(1, Number(this.#limitOf()) || DEFAULT_LIMIT);
  }

  get size() {
    return this.#items.length;
  }

  addMessage(msg, { tsMs } = {}) {
    return this.#append({
      kind: KINDS.MESSAGE,
      tsMs: toMs(tsMs ?? msg?.tsMs, this.#now()),

      id: this.#idOf(msg),
      msg,
    });
  }

  addEvent(ev = {}) {
    const kind = str(ev.kind);
    if (kind === '' || kind === KINDS.MESSAGE) {
      throw new TypeError(`TurnPool.addEvent: kind 不能是「${kind}」，消息请用 addMessage()`);
    }
    const tsMs = toMs(ev.tsMs, this.#now());
    const next = {
      kind,
      tsMs,

      lastTsMs: tsMs,

      count: 1,
      subject: ev.subject?.messageId ? { messageId: str(ev.subject.messageId) } : undefined,
      actor: str(ev.actor),
      author: str(ev.author),
      target: str(ev.target),
      emoji: str(ev.emoji),
      isAdd: typeof ev.isAdd === 'boolean' ? ev.isAdd : undefined,
      payload: ev.payload,
    };

    const at = this.#findMergeable(next);
    if (at >= 0) {
      const prev = this.#items[at];
      prev.count += 1;
      prev.lastTsMs = tsMs;
      return prev;
    }
    next.tid = this.#nextTid(kind);
    return this.#append(next);
  }

  #nextTid(kind) {
    const n = (this.#typeSeq.get(kind) ?? 0) + 1;
    this.#typeSeq.set(kind, n);
    return n;
  }

  #append(fields) {
    this.#seq += 1;
    const entry = { ...fields, seq: this.#seq };
    this.#items.push(entry);
    const over = this.#items.length - this.limit;
    if (over > 0) this.#items.splice(0, over);
    return entry;
  }

  #findMergeable(next) {
    for (let i = this.#items.length - 1; i >= 0; i -= 1) {
      const it = this.#items[i];
      if (it.kind !== next.kind) continue;
      if (it.actor !== next.actor) continue;

      if (next.kind === KINDS.RECALL) {

        if (sameSubject(it, next)) return i;
        continue;
      }
      if (next.kind === KINDS.REACTION) {
        if (it.emoji !== next.emoji) continue;

        if (it.isAdd !== next.isAdd) continue;
        if (sameSubject(it, next)) return i;
        continue;
      }
      if (next.kind === KINDS.POKE) {
        if (it.target !== next.target) continue;

        if (next.tsMs - toMs(it.lastTsMs, it.tsMs) > POKE_MERGE_MS) continue;
        return i;
      }

      return -1;
    }
    return -1;
  }

  mark(target, name, { tsMs } = {}) {
    const key = str(name);
    if (key === '') throw new TypeError('TurnPool.mark: name 不能为空');
    const at = toMs(tsMs, this.#now());
    const hit = this.#resolve(target);
    for (const it of hit) {
      if (!it.marks) it.marks = {};
      it.marks[key] = at;
    }
    return hit;
  }

  markRead(target, { tsMs } = {}) {
    const hit = this.mark(target, MARKS.READ, { tsMs });

    if (this.#onMarkRead && hit.length) {
      const refs = [];
      for (const it of hit) {
        const ref = splitId(it.id);
        if (ref) refs.push(ref);
      }
      if (refs.length) {
        try {
          this.#onMarkRead(refs);
        } catch {

        }
      }
    }
    return hit;
  }

  marked(name) {
    const key = str(name);
    return this.#items.filter((it) => isMarked(it, key));
  }

  unmarked(name) {
    const key = str(name);
    return this.#items.filter((it) => !isMarked(it, key));
  }

  find(ref) {
    const key = str(ref);
    if (key === '') return null;

    for (const it of this.#items) {
      if (it.kind !== KINDS.MESSAGE || !it.msg) continue;
      if (it.id === key || (it.id && it.id.endsWith(`#${key}`))) {
        return { message: it.msg, date: splitId(it.id)?.date ?? dateOf(it.msg.tsMs), from: 'pool' };
      }
    }

    const found = this.#store?.findByRef?.(key);
    return found ? { ...found, from: 'store' } : null;
  }

  findByMessageId(messageId) {
    const id = str(messageId);
    if (id === '') return null;

    for (const it of this.#items) {
      if (it.kind !== KINDS.MESSAGE || !it.msg) continue;
      if (String(it.msg.messageId ?? '') === id) {
        return { message: it.msg, date: splitId(it.id)?.date ?? dateOf(it.msg.tsMs), from: 'pool' };
      }
    }

    const found = this.#store?.findByMessageId?.(id);
    return found ? { ...found, from: 'store' } : null;
  }

  search(filters = {}) {
    const f = normalizeSearch(filters);

    const fromPool = this.#collectPool(f);
    if (!this.#needsStore(f, fromPool.length)) return this.#orderRows(fromPool, f);

    const fromStore = this.#collectStore(f);
    return this.#orderRows(fromStore ?? fromPool, f);
  }

  #collectPool(f) {
    const rows = [];
    for (let i = this.#items.length - 1; i >= 0; i -= 1) {
      const it = this.#items[i];
      if (it.kind !== KINDS.MESSAGE || !it.msg) continue;
      const parts = splitId(it.id);
      const date = parts?.date ?? dateOf(it.tsMs);
      if (f.dates.length && !f.dates.includes(date)) continue;
      if (!matchesSearch(it.msg, parts?.seq ?? '', f)) continue;
      rows.push({ ...it.msg, date });
      if (rows.length >= f.cap) break;
    }
    return rows;
  }

  #collectStore(f) {
    const store = this.#store;
    if (!store || typeof store.load !== 'function' || typeof store.dates !== 'function') return null;

    const dates = (f.dates.length ? f.dates : store.dates()).slice().sort().reverse();
    const rows = [];
    for (const date of dates) {
      const doc = store.load(date);
      for (let i = doc.messages.length - 1; i >= 0; i -= 1) {
        const m = doc.messages[i];
        if (!matchesSearch(m, seqOf(m, date), f)) continue;
        rows.push({ ...m, date });
        if (rows.length >= f.cap) break;
      }
      if (rows.length >= f.cap) break;
    }
    return rows;
  }

  #needsStore(f, got) {
    if (!this.#store) return false;
    if (got >= f.cap) return false;
    const start = this.#windowStart();
    if (!start) return true;
    if (f.bySeq) {
      if (!f.numericSeq) return true;
      return Number(f.seqLo) < Number(start.seq);
    }
    if (f.dates.length) return f.dates.some((d) => d < start.date);
    if (Number.isFinite(f.fromTs)) return f.fromTs < start.tsMs;
    return true;
  }

  #windowStart() {
    let best = null;
    for (const it of this.#items) {
      if (it.kind !== KINDS.MESSAGE || !it.msg) continue;
      if (best === null || it.tsMs < best.tsMs) {
        best = { tsMs: it.tsMs, date: splitId(it.id)?.date ?? dateOf(it.tsMs), seq: splitId(it.id)?.seq ?? '' };
      }
    }
    return best;
  }

  #orderRows(rows, f) {
    return f.order === 'asc' ? rows.slice().reverse() : rows;
  }

  get selfQq() {
    return String(this.#store?.selfQq ?? '');
  }

  dates() {
    return typeof this.#store?.dates === 'function' ? this.#store.dates() : [];
  }

  unreadStats() {
    const perDay = [];
    let total = 0;
    const start = this.#windowStart();

    for (const date of this.dates()) {
      let n = 0;
      let oldest = null;
      const covered = start !== null && date >= start.date;

      if (covered) {
        for (const it of this.#items) {
          if (it.kind !== KINDS.MESSAGE || !it.msg) continue;
          if (splitId(it.id)?.date !== date) continue;
          if ((it.msg.readCount ?? 0) !== 0) continue;
          n += 1;
          if (oldest === null) oldest = Number(it.msg.tsMs ?? 0) || null;
        }
      } else {
        const doc = this.#store?.load?.(date);
        if (!doc) continue;
        for (const m of doc.messages) {
          if ((m.readCount ?? 0) !== 0) continue;
          n += 1;
          if (oldest === null) oldest = Number(m.tsMs ?? 0) || null;
        }
      }

      if (n > 0) perDay.push({ date, unread: n, oldestTs: oldest });
      total += n;
    }
    return { total, perDay, newestUnreadTs: null };
  }

  onAppend(fn) {
    const store = this.#store;
    if (!store || typeof store.on !== 'function' || typeof fn !== 'function') return () => {};
    const handler = (payload) => {
      try {
        fn(payload);
      } catch {

      }
    };
    store.on('appended', handler);
    return () => store.off?.('appended', handler);
  }

  #resolve(target) {
    const list = Array.isArray(target) ? target : [target];
    const seqs = new Set();
    const ids = new Set();

    const refs = new Set();
    for (const t of list) {
      if (!t || typeof t !== 'object') continue;
      if (typeof t.seq === 'number' && typeof t.kind === 'string') { seqs.add(t.seq); continue; }
      const msg = t.msg ?? t;
      refs.add(msg);
      const id = this.#idOf(msg);
      if (id) ids.add(id);
    }
    if (seqs.size === 0 && ids.size === 0 && refs.size === 0) return [];

    const hit = [];
    for (const it of this.#items) {
      if (seqs.has(it.seq)) { hit.push(it); continue; }
      if (it.id && ids.has(it.id)) { hit.push(it); continue; }
      if (it.kind === KINDS.MESSAGE && refs.has(it.msg)) hit.push(it);
    }
    return hit;
  }

  #idOf(msg) {
    if (!this.#identity || !msg) return '';
    try {
      return str(this.#identity(msg));
    } catch {

      return '';
    }
  }

  cursor(name) {
    return this.#cursors.get(str(name)) ?? 0;
  }

  advance(name, toNumber) {
    const key = str(name);
    if (key === '') throw new TypeError('TurnPool.advance: name 不能为空');
    scopeOfCursor(key);
    const to = Number(toNumber);
    if (!Number.isFinite(to) || to <= this.cursor(key)) return this.cursor(key);
    this.#cursors.set(key, to);
    return to;
  }

  advancePast(name, entries) {
    const key = str(name);
    const scope = scopeOfCursor(key);
    const list = Array.isArray(entries) ? entries : [entries];
    let max = 0;
    for (const it of list) {
      if (!it || typeof it !== 'object') continue;
      const n = scope.all
        ? (typeof it.seq === 'number' ? it.seq : 0)
        : (it.kind === scope.kind && typeof it.tid === 'number' ? it.tid : 0);
      if (n > max) max = n;
    }
    return max > 0 ? this.advance(key, max) : this.cursor(key);
  }

  since(name) {
    const key = str(name);
    const scope = scopeOfCursor(key);
    const from = this.cursor(key);
    if (scope.all) return this.#items.filter((it) => it.seq > from);
    return this.#items.filter((it) => it.kind === scope.kind && (it.tid ?? 0) > from);
  }

  sinceMessages(name) {
    return this.since(name)
      .filter((it) => it.kind === KINDS.MESSAGE)
      .map((it) => it.msg);
  }

  someMessage(predicate) {
    for (const it of this.#items) {
      if (it.kind !== KINDS.MESSAGE) continue;
      if (predicate(it.msg, it)) return true;
    }
    return false;
  }

  some(predicate) {
    return this.#items.some(predicate);
  }

  pick(predicate) {
    return this.#items.filter(predicate);
  }

  messages() {
    return this.#items.filter((it) => it.kind === KINDS.MESSAGE).map((it) => it.msg);
  }

  events() {
    return this.#items.filter((it) => it.kind !== KINDS.MESSAGE);
  }

  all() {
    return this.#items.slice();
  }

}
