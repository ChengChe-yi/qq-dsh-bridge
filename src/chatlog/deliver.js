import { takeLatestUnreadAcrossDays, PHASES } from './read.js';
import { dateOf, seqOf } from './store.js';
import { segmentsToText, mentionsId } from './segments.js';

export const DEFAULTS = Object.freeze({
  wakeLimit: 60,
  replyWindowLimit: 20,
  maxDays: 7,

  maxChars: 4000,
});

export function shapeForPrompt(m, { isTrigger = false, selfQq = '', ownerQq = '' } = {}) {
  const qq = String(m.sender?.qq ?? '');
  const name = m.sender?.name || qq;

  const self = String(selfQq ?? '') !== '' && qq === String(selfQq);
  const isOwner = String(ownerQq ?? '') !== '' && qq === String(ownerQq);

  const out = {

    date: dateOf(m.tsMs),

    seq: seqOf(m, dateOf(m.tsMs)),

    who: self ? '〔本号〕' : shortWho(name, qq),
    qq,

    tag: identityTag(m.sender?.groupRole),

    isOwner,

    at: formatTime(m.tsMs),

    text: segmentsToText(m, { selfQq }),
  };
  if (self) out.self = true;

  if (isTrigger) out.isTrigger = true;
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

export function identityTag(role) {
  switch (role) {
    case 'groupOwner': return '群主';

    case 'admin': return '群管理';
    default: return '';
  }
}

export function shortWho(name, qq) {
  const n = String(name ?? '').trim();
  const id = String(qq ?? '').trim();
  if (!id) return n;
  if (!n || n === id) return n || id;
  const tail = id.length > 4 ? id.slice(-4) : id;
  return `${n}(${tail})`;
}

function formatTime(tsMs) {
  const d = new Date(Number(tsMs) || 0);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function renderContext(shaped, { maxChars = DEFAULTS.maxChars, selfQq = '' } = {}) {
  const lines = [];
  let chars = 0;
  let truncated = false;

  for (let i = shaped.length - 1; i >= 0; i -= 1) {
    const m = shaped[i];

    const tags = [];
    if (m.tag) tags.push(m.tag);
    if (m.isOwner) tags.push('管理者');
    const who = tags.length ? `${tags.join('|')}|${m.who}` : m.who;

    let body = m.text ? String(m.text).replace(/\s+/g, ' ').trim() : '';
    if (!body) body = '（无文字）';

    const head = `[${m.seq}][${who}]`;
    let line = `${head}{${body}}`;

    if (selfQq && mentionsId(m, selfQq)) line += '   ← @ 了你';
    if (m.isTrigger) line += '   ← 本次触发';

    if (chars + line.length > maxChars) {
      truncated = true;

      if (!lines.length) {
        lines.push(`${line.slice(0, Math.max(0, maxChars - 24))}…（本条过长，已截断）`);
        chars = maxChars;
      }
      break;
    }
    lines.push(line);
    chars += line.length;
  }

  lines.reverse();

  let text = lines.join('\n');
  if (lines.length) {

    const first = shaped[shaped.length - lines.length];
    const last = shaped[shaped.length - 1];
    const start = `[${first.date} ${first.at}]`;
    const end = `[${last.date} ${last.at}]`;

    text = lines.length === 1
      ? `${start}\n${text}`
      : `${start}\n${text}\n${end}`;
  }

  return { text, count: lines.length, truncated, maxChars };
}

export function deliver(store, {
  limit = DEFAULTS.wakeLimit,

  items: givenItems = null,
  triggerSeq,
  triggerDate,
  maxDays = DEFAULTS.maxDays,
  maxChars = DEFAULTS.maxChars,
  mark = true,
  now = Date.now(),
  selfQq = '',

  ownerQq = '',
} = {}) {
  const items = Array.isArray(givenItems)
    ? givenItems
    : takeLatestUnreadAcrossDays(store, { limit, maxDays });

  const isTriggerItem = (m) => triggerSeq !== undefined
    && seqOf(m, m.date) === String(triggerSeq)
    && (!triggerDate || m.date === triggerDate);
  const triggerInWindow = items.some(isTriggerItem);

  const shapeOpts = { selfQq, ownerQq };
  const shaped = items.map((m) => shapeForPrompt(m, { ...shapeOpts, isTrigger: isTriggerItem(m) }));

  let trigger = null;
  if (triggerSeq !== undefined && !triggerInWindow) {
    const found = store.findByRef(triggerSeq);
    if (found) {
      trigger = shapeForPrompt({ ...found.message, date: found.date }, { ...shapeOpts, isTrigger: true });
    }
  }

  return {
    phase: PHASES.PUSH,

    items,

    shaped,

    context: renderContext(shaped, { maxChars, selfQq }),
    trigger,

    triggerLine: trigger ? renderContext([trigger], { maxChars, selfQq }).text : '',
    triggerInWindow,
    span: spanOf(items),

    remainingUnread: Math.max(0, countUnread(store) - items.length),

    selfQq,
  };
}

export function countUnread(store) {
  let n = 0;
  for (const date of store.dates()) {
    const doc = store.load(date);
    for (const m of doc.messages) if ((m.readCount ?? 0) === 0) n += 1;
  }
  return n;
}

function spanOf(items) {
  if (!items.length) return null;
  return {
    from: items[0].date,
    to: items.at(-1).date,
    firstTs: items[0].tsMs,
    lastTs: items.at(-1).tsMs,
    crossDay: items[0].date !== items.at(-1).date,
  };
}

export function deliverOnWake(store, options = {}) {
  return deliver(store, { limit: DEFAULTS.wakeLimit, ...options });
}

export function deliverReplyWindow(store, options = {}) {
  return deliver(store, { limit: DEFAULTS.replyWindowLimit, ...options });
}

export { dateOf };
