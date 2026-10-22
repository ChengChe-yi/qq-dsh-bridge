export const op = 'groupInfo';
export const logsAsSend = true;

import { dateOf } from '../../chatlog/store.js';

export async function run({ http }, convKey, args) {
  if (!convKey.startsWith('group:')) throw new Error('私聊会话没有群信息');
  const info = await http.call('get_group_info', { group_id: Number(convKey.slice(6)) });
  return {
    groupId: convKey.slice(6),
    name: info?.group_name ?? '',

    remark: info?.group_remark ?? '',
    count: Number(info?.member_count ?? 0),

    maxCount: Number(info?.max_member_count ?? 0),
    level: Number(info?.group_level ?? 0),
    createdAt: info?.group_create_time ? dateOf(info.group_create_time * 1000) : '',
    memo: info?.group_memo ?? '',
    description: info?.group_description ?? '',

    allMuted: Number(info?.group_all_shut ?? 0) !== 0,
  };
}
