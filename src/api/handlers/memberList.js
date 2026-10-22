export const op = 'memberList';
export const logsAsSend = true;

import { dateOf, dateTimeOf, normalizeGroupRole } from '../../chatlog/store.js';

export async function run({ http }, convKey, args) {
  if (!convKey.startsWith('group:')) throw new Error('私聊会话没有成员列表');
  const groupId = Number(convKey.slice(6));

  let all;
  try {
    all = await http.call('get_group_member_list', { group_id: groupId });
  } catch (error) {
    throw new Error(
      `拿不到群成员列表（${error?.message ?? error}）。`
      + '这通常是腾讯那边还没缓存好 —— 过一会儿再试，或先用 qq_member_info 查具体某个人。',
    );
  }
  if (!Array.isArray(all)) throw new Error('群成员列表返回了非数组，无法处理。');

  const wantRole = String(args?.role ?? '').trim();
  const wantName = String(args?.name ?? '').trim().toLowerCase();
  const wantTitle = args?.hasTitle === true;

  const norm = (m) => ({
    qq: String(m?.user_id ?? ''),
    card: m?.card ?? '',
    nickname: m?.nickname ?? '',
    groupRole: normalizeGroupRole(m?.role),
    title: m?.title ?? '',
    level: String(m?.level ?? ''),
    joinTime: Number(m?.join_time) > 0 ? dateOf(Number(m.join_time) * 1000) : '',
    lastSentTime: Number(m?.last_sent_time) > 0 ? dateTimeOf(Number(m.last_sent_time) * 1000) : '',

    _joinRaw: Number(m?.join_time ?? 0),
    _sentRaw: Number(m?.last_sent_time ?? 0),
    _levelRaw: Number(m?.level ?? 0) || 0,
  });

  let rows = all.map(norm);

  if (wantRole) rows = rows.filter((r) => r.groupRole === wantRole);
  if (wantTitle) rows = rows.filter((r) => r.title !== '');
  if (wantName) {

    rows = rows.filter((r) => r.card.toLowerCase().includes(wantName)
      || r.nickname.toLowerCase().includes(wantName));
  }

  const sort = String(args?.sort ?? 'active');
  if (sort === 'joinTime') rows.sort((a, b) => b._joinRaw - a._joinRaw);
  else if (sort === 'level') rows.sort((a, b) => b._levelRaw - a._levelRaw);

  else rows.sort((a, b) => b._sentRaw - a._sentRaw);

  const limit = Math.max(1, Math.min(100, Number(args?.limit) || 30));
  const shown = rows.slice(0, limit);

  return {

    total: all.length,

    matched: rows.length,

    shown: shown.length,
    note: rows.length > shown.length
      ? `还有 ${rows.length - shown.length} 条没列出（limit=${limit}）—— 用 name/role 缩窄条件，或加大 limit（上限 100）。`
      : undefined,
    members: shown.map(({ _joinRaw, _sentRaw, _levelRaw, ...keep }) => keep),
  };
}
