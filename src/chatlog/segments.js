import { dateOf, seqOf } from './store.js';

export const NON_TEXT_TYPES = Object.freeze([
  'image', 'face', 'record', 'video', 'forward', 'json',
]);

const STRUCTURAL_TYPES = new Set(NON_TEXT_TYPES);

export const MEDIA_TYPES = Object.freeze(['image', 'record', 'video']);

export function segmentsOf(m) {
  if (Array.isArray(m)) return m;
  return Array.isArray(m?.segments) ? m.segments : [];
}

export function segmentsByType(m, types) {
  const want = new Set(Array.isArray(types) ? types : [types]);
  return segmentsOf(m).filter((s) => want.has(s?.type));
}

export function mediaOf(m) {
  const want = new Set(MEDIA_TYPES);
  return segmentsOf(m)
    .filter((s) => want.has(s?.type))
    .map((s) => ({ kind: s.type, ...(s.data ?? {}) }));
}

export function textOf(m) {
  return segmentsOf(m)
    .filter((s) => s?.type === 'text')
    .map((s) => String(s?.data?.text ?? ''))
    .join('')
    .trim();
}

export function hasText(m) {
  return textOf(m) !== '';
}

export function segmentsToText(source, { selfQq = '' } = {}) {
  const segs = segmentsOf(source);
  const want = String(selfQq ?? '');
  const out = [];

  if (source?.state?.recalled) out.push('[recall]');

  for (const seg of segs) {
    const type = seg?.type;
    const d = seg?.data ?? {};
    switch (type) {
      case 'text':

        out.push(`[text:${String(d.text ?? '')}]`);
        break;

      case 'at': {
        const qq = String(d.qq ?? '');
        if (qq === 'all') {

          out.push('[at:全体成员]');
        } else if (want !== '' && qq === want) {

          out.push('[at:你]');
        } else {

          const nm = String(d.name ?? '').trim();
          out.push(nm ? `[at:${qq}(${nm})]` : `[at:${qq}]`);
        }
        break;
      }

      case 'reply': {

        const seq = d.seq;
        out.push(seq !== undefined && seq !== null ? `[reply:seq=${seq}]` : '[reply:?]');
        break;
      }

      case 'image': {

        const desc = String(d.summary ?? '').replace(/^\[|\]$/g, '').trim();
        out.push(desc ? `[image:${desc}]` : '[image]');
        break;
      }

      case 'face': {
        const name = String(d.name ?? '').trim();

        out.push(name ? `[face:${name}]` : '[face]');
        break;
      }

      default:

        out.push(`[${String(type ?? 'unknown')}]`);
    }
  }

  return out.join('');
}

export function mentionsId(m, selfQq) {
  const want = String(selfQq ?? '');
  if (want === '') return false;
  return segmentsOf(m).some(
    (s) => s?.type === 'at' && String(s?.data?.qq ?? '') === want,
  );
}

export function hasReply(m) {
  return segmentsOf(m).some((s) => s?.type === 'reply');
}

export function deriveMsgType(m) {
  const segs = segmentsOf(m);
  const structural = segs.filter((s) => STRUCTURAL_TYPES.has(s?.type));

  if (structural.length === 0) return 'text';
  if (structural.length === 1 && !hasText(m)) return structural[0].type;
  return 'mixed';
}

export function messageRow(m, { selfQq = '', raw = false } = {}) {
  const out = {

    seq: seqOf(m, m?.date || dateOf(m?.tsMs)),

    time: formatDateTime(m?.tsMs),
    sender: senderOf(m, selfQq),

    segmentsText: segmentsToText(m, { selfQq }),
  };

  if (raw && Array.isArray(m?.segments)) out.segments = m.segments;

  if (m?.state?.recalled) out.recalled = 1;

  if (m?.quote?.data) {
    const q = m.quote.data;
    out.quote = {
      seq: seqOf(q, m.quote.date || dateOf(q?.tsMs)),
      date: m.quote.date,
      sender: senderOf(q, selfQq),
      segmentsText: segmentsToText(q, { selfQq }),
    };

    if (raw && Array.isArray(q.segments)) out.quote.segments = q.segments;
  } else if (m?.quote) {

    out.quote = { unresolved: 1 };
  }

  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

export function senderOf(m, selfQq = '') {
  const qq = String(m?.sender?.qq ?? '');
  const self = String(selfQq ?? '') !== '' && qq === String(selfQq);
  return {
    qq,
    name: self ? '〔本号〕' : String(m?.sender?.name || qq),
    groupRole: m?.sender?.groupRole || 'member',
  };
}

export function shortWho(name, qq) {
  const n = String(name ?? '').trim();
  const id = String(qq ?? '').trim();
  if (!id) return n;
  if (!n || n === id) return n || id;
  const tail = id.length > 4 ? id.slice(-4) : id;
  return `${n}(${tail})`;
}

function formatDateTime(tsMs) {
  const d = new Date(Number(tsMs) || 0);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
