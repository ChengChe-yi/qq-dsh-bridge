import { mentionsId } from './segments.js';

export const REASONS = Object.freeze({
  PRIVATE: 'private',
  AT: 'atMention',
});

export function detectTrigger(event, kind, quote) {

  if (kind === 'private') return REASONS.PRIVATE;

  if (quote?.atSelf) return REASONS.AT;

  return null;
}

export function gateAllows(who, senderQq, ownerQq) {
  if (who === 'everyone') return true;
  const qq = String(senderQq ?? '');
  return qq !== '' && qq === String(ownerQq ?? '');
}

export function normalizeWho(value) {
  return value === 'everyone' ? 'everyone' : 'owner';
}

export function triggerLabel(reason, isOwner) {
  switch (reason) {
    case REASONS.PRIVATE:
      return isOwner ? '主人私聊你' : '有人私聊你';
    case REASONS.AT:
      return isOwner ? '主人 @ 了你' : '有人 @ 了你';
    default:
      return '未知触发';
  }
}

export function evaluateWait({
  who,
  ownerQq,
  messages = [],
  sinceTs = 0,
  timeoutMs = 0,
  requireMention = true,

  qq = [],
  selfQq = '',
  now = Date.now(),
}) {

  const fresh = messages.filter((m) => (m.tsMs ?? 0) >= sinceTs);

  const allowed = [];
  let skippedNoMention = 0;

  const wanted = new Set(
    (Array.isArray(qq) ? qq : [qq]).map((v) => String(v ?? '').trim()).filter(Boolean),
  );

  for (const m of fresh) {

    if (!waitHit(m, { selfQq, who, ownerQq, qq: wanted, requireMention })) {
      skippedNoMention += 1;
      continue;
    }
    allowed.push(m);
  }

  const from = allowed.length ? allowed[0] : null;

  return {
    arrived: allowed.length > 0,
    from,

    messages: allowed,

    fresh,
    skippedNoMention,
    timeout: allowed.length === 0 && timeoutMs > 0 && (now - sinceTs) >= timeoutMs,
  };
}

export function mentionsSelf(m, selfQq) {
  const want = String(selfQq ?? m?.selfQq ?? '');
  if (want === '') return false;

  if (mentionsId(m, want)) return true;

  if (String(m?.quote?.data?.sender?.qq ?? '') === want) return true;
  return false;
}

export function waitHit(m, {
  selfQq = '',
  who = 'everyone',
  ownerQq = '',
  qq = [],
  requireMention = true,
} = {}) {
  const sender = String(m?.sender?.qq ?? '');

  if (sender !== '') {
    if (qq && typeof qq.has === 'function') {
      if (qq.has(sender)) return true;
    } else if (Array.isArray(qq) && qq.includes(sender)) {
      return true;
    }
  }

  if (!requireMention) return true;

  return gateAllows(who, sender, ownerQq) && mentionsSelf(m, selfQq);
}
