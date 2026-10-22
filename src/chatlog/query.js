import { messageRow } from './segments.js';

export function readChat(pool, args = {}) {

  const { raw = false, ...filters } = args;

  const rows = pool.search({
    ...filters,
    limit: filters.limit ?? 50,
    order: filters.order ?? 'desc',
  });

  const marked = 0;

  return {

    messages: rows.map((m) => toRow(m, { selfQq: pool.selfQq, raw })),
    count: rows.length,
    marked,

    unreadRemaining: pool.unreadStats().total,

    availableDates: pool.dates(),
  };
}

export function unreadOverview(pool) {
  const s = pool.unreadStats();
  return {
    totalUnread: s.total,
    perDay: s.perDay,
    availableDates: pool.dates(),

    hint: s.total > 0
      ? `还有 ${s.total} 条未读（跨 ${s.perDay.length} 天）。用 readChat 按 unreadOnly 或 readRounds 筛。`
      : '当前没有未读。',
  };
}

export function toRow(m, { selfQq = '', raw = false } = {}) {
  return messageRow(m, { selfQq, raw });
}
