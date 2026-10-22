export const op = 'wait';
export const logsAsSend = true;

import { messageRow } from '../../chatlog/segments.js';

function normalizeQq(v, logger) {
  let raw = v;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (s.startsWith('[')) {
      try {
        raw = JSON.parse(s);
      } catch {
        raw = s;
      }
    }
    if (typeof raw === 'string' && /[\s,，、]/.test(raw)) raw = raw.split(/[\s,，、]+/);
  }
  const arr = Array.isArray(raw) ? raw : (raw === undefined || raw === null || raw === '' ? [] : [raw]);
  const out = [];
  for (const x of arr) {
    const s = String(x ?? '').trim();
    if (!s) continue;
    if (/^\d+$/.test(s)) out.push(s);
    else logger?.warn('qq_wait：qq 里有非纯数字的项，已忽略', { value: s.slice(0, 40) });
  }
  return out;
}

export async function run({ registry, logger }, convKey, args) {
  const conv = registry.get(convKey);
  const budget = conv.nextWaitMs();

  const qqList = normalizeQq(args?.qq, logger);

  logger.info('qq_wait 开始等', { conv: convKey, qq: qqList, budgetMs: budget });

  if (budget <= 0) {
    logger.debug('本轮等待额度已用完，直接返回', {
      conv: convKey, waitedTotalMs: conv.waitedTotalMs,
    });
    return {
      arrived: false,
      timeout: true,
      budgetExhausted: true,
      note: '本轮等待的总时长已经用完了（各次 qq_wait 累计达上限）—— '
        + '请直接收尾，不要再等。对方再 @ 你会重新唤醒你。',
      newMessages: [],
      messages: [],
      omitted: 0,
    };
  }

  const result = await conv.waitForMessages({

    timeoutMs: budget, maxMs: budget, qq: qqList,
  });

  const selfQq = conv.turnPool.selfQq;
  const shape = (m) => messageRow(m, { selfQq });

  return {
    arrived: result.arrived,
    timeout: result.timeout,

    from: result.from ? shape(result.from) : null,

    newMessages: result.newMessages.map(shape),

    omitted: result.omitted > 0 ? result.omitted : undefined,
    omittedNote: result.omitted > 0
      ? `更早还有 ${result.omitted} 条没列出（只给最近 ${result.newMessages.length} 条）。要看就用 qq_read_chat。`
      : undefined,
    waitedMs: result.waitedMs,
  };
}
