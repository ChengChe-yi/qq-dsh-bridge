export const op = 'memberInfo';
export const logsAsSend = true;

import { dateTimeOf, normalizeGroupRole } from '../../chatlog/store.js';

export async function run({ http }, convKey, args) {
  if (!convKey.startsWith('group:')) throw new Error('私聊会话没有成员信息');
  const info = await http.call('get_group_member_info', {
    group_id: Number(convKey.slice(6)),
    user_id: Number(args.qq),
  });

  const at = (sec) => (Number(sec) > 0 ? dateTimeOf(Number(sec) * 1000) : '');
  const shutUntil = Number(info?.shut_up_timestamp ?? 0);
  return {
    qq: String(args.qq),

    card: info?.card ?? '',
    nickname: info?.nickname ?? '',

    groupRole: normalizeGroupRole(info?.role),

    title: info?.title ?? '',
    level: String(info?.level ?? ''),
    joinTime: at(info?.join_time),

    lastSentTime: at(info?.last_sent_time),

    mutedUntil: shutUntil > Date.now() / 1000 ? dateTimeOf(shutUntil * 1000) : '',
    qqLevel: Number(info?.qq_level ?? 0) || undefined,
    qage: Number(info?.qage ?? 0) || undefined,
  };
}
