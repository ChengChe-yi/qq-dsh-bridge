import { textOf, deriveMsgType } from './segments.js';
import { seqOf } from './store.js';

export const PHASES = Object.freeze({

  PUSH: 'push',

  MANUAL: 'manual',
});

export function takeLatestUnread(doc, { limit = 60, stopAtRead = true } = {}) {
  const out = [];
  const msgs = doc.messages ?? [];

  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const m = msgs[i];
    const isRead = (m.readCount ?? 0) > 0;

    if (isRead) {

      if (stopAtRead) break;
      continue;
    }

    out.push(m);
    if (out.length >= limit) break;
  }

  return out.reverse();
}

export function isSelfMessage(m, selfQq = '') {
  const want = String(selfQq ?? '');
  if (want !== '') return String(m?.sender?.qq ?? '') === want;
  return false;
}

export function takeLatestUnreadAcrossDays(store, { limit = 60, maxDays = 7, stopAtRead = true } = {}) {
  const dates = store.dates().slice(-maxDays).reverse();
  const collected = [];

  for (const date of dates) {
    if (collected.length >= limit) break;

    const doc = store.load(date);
    const msgs = doc.messages ?? [];
    const beforeThisDay = collected.length;

    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      const m = msgs[i];
      const isRead = (m.readCount ?? 0) > 0;

      if (isRead) {
        if (!stopAtRead) continue;

        if (collected.length > beforeThisDay) {
          collected.sort((a, b) => (a.tsMs ?? 0) - (b.tsMs ?? 0));
          return collected;
        }

        break;
      }

      collected.push({ ...m, date });
      if (collected.length >= limit) break;
    }
  }

  collected.sort((a, b) => (a.tsMs ?? 0) - (b.tsMs ?? 0));
  return collected;
}

export function markRead(store, items, phase, opts = {}) {
  const refs = [];
  for (const it of items) {
    if (!it?.date) continue;
    const seq = seqOf(it, it.date);
    if (seq === undefined) continue;
    refs.push({ date: it.date, seq });
  }
  return markReadByRefs(store, refs, phase, opts);
}

export function markReadByRefs(store, refs, phase, { atMs = Date.now() } = {}) {
  let n = 0;
  const byDate = new Map();
  for (const r of refs) {
    if (!r?.date || r.seq === undefined || r.seq === null) continue;
    if (!byDate.has(r.date)) byDate.set(r.date, []);
    byDate.get(r.date).push(String(r.seq));
  }

  for (const [date, seqs] of byDate) {
    const doc = store.load(date);
    const wanted = new Set(seqs);
    let touched = false;
    for (const m of doc.messages) {
      if (!wanted.has(seqOf(m, date))) continue;
      m.readCount = (m.readCount ?? 0) + 1;
      n += 1;
      touched = true;
    }
    if (!touched) continue;

    store.cache.get(date).dirty = true;
    store.scheduleFlush(date);
  }
  return n;
}

export function query(store, options = {}) {
  const {
    dates,
    unreadOnly = false,
    readRounds,
    sender,
    role,
    since,
    until,
    contains,
    includeRecalled = true,
    excludeRecalled = false,
    kinds,
    limit = 50,
    order = 'desc',
  } = options;

  const targetDates = dates?.length ? dates : store.dates();
  const rows = [];

  for (const date of targetDates) {
    const doc = store.load(date);
    for (const m of doc.messages) {
      const readCount = m.readCount ?? 0;

      if (unreadOnly && readCount !== 0) continue;
      if (readRounds) {
        if (readRounds.eq !== undefined && readCount !== readRounds.eq) continue;
        if (readRounds.min !== undefined && readCount < readRounds.min) continue;
        if (readRounds.max !== undefined && readCount > readRounds.max) continue;
      }
      if (sender && String(m.sender?.qq) !== String(sender)) continue;
      if (role && m.sender?.groupRole !== role) continue;

      if (since !== undefined && m.tsMs < Number(since) * 1000) continue;
      if (until !== undefined && m.tsMs > Number(until) * 1000) continue;

      if (kinds?.length && !kinds.includes(deriveMsgType(m))) continue;

      const recalled = Boolean(m.state?.recalled);
      if (!includeRecalled && recalled) continue;
      if (excludeRecalled && recalled) continue;

      if (contains) {

        const hay = `${textOf(m)} ${m.sender?.name ?? ''}`.toLowerCase();
        if (!hay.includes(String(contains).toLowerCase())) continue;
      }

      rows.push({ ...m, date });
    }
  }

  rows.sort((a, b) => (order === 'asc'
    ? (a.tsMs ?? 0) - (b.tsMs ?? 0)
    : (b.tsMs ?? 0) - (a.tsMs ?? 0)));

  return rows.slice(0, limit);
}

export function unreadStats(store) {
  const perDay = [];
  let total = 0;
  for (const date of store.dates()) {
    const doc = store.load(date);
    let n = 0;
    let oldest = null;
    for (const m of doc.messages) {
      if ((m.readCount ?? 0) === 0) {
        n += 1;
        if (oldest === null) oldest = m.ts;
      }
    }
    if (n > 0) perDay.push({ date, unread: n, oldestTs: oldest });
    total += n;
  }
  return { total, perDay, newestUnreadTs: perDay.at(-1) ? null : null };
}
