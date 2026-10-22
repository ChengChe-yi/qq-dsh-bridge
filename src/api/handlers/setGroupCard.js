export const op = 'setGroupCard';
export const needsAllow = true;
export const logsAsSend = true;

const MAX_CARD_CHARS = 40;

const TARGET_FIELD_ALIASES = ['user_id', 'userId', 'qq', 'uin', 'target', 'targetQq', 'target_qq'];

function charCount(text) {
  return [...text].length;
}

export async function run({ poolFor, http, logger }, convKey, args) {
  if (!convKey.startsWith('group:')) {
    throw new Error(
      '群名片只在**群**里存在 —— 当前是私聊会话，改不了名片。'
      + '（私聊里能改的是账号昵称，那是 `qq_set_nickname`；同样只在管理者明确要求时做。）',
    );
  }
  const groupId = convKey.slice(6);

  if (typeof args?.card !== 'string') {
    throw new Error("要改成什么？传 `card`（字符串）。**清空名片就传空字符串 `''`** —— 空串不是「没传」。");
  }
  if (charCount(args.card) > MAX_CARD_CHARS) {
    throw new Error(
      `\`card\` 太长了（${charCount(args.card)} 个字符 > 上限 ${MAX_CARD_CHARS}）——`
      + '这不像一个名片，像一整段话。',
    );
  }

  const selfQq = String(poolFor(convKey).selfQq ?? '');
  if (selfQq === '') {
    throw new Error('不知道本号（selfQq 为空），无法确定该改**谁**的名片 —— 拒绝（不能改别人）。');
  }

  const ignored = TARGET_FIELD_ALIASES.filter((k) => args[k] !== undefined && args[k] !== null);
  if (ignored.length) {
    logger.warn('改群名片：args 里带了指定「改谁」的字段，已忽略（只改本号）', {
      conv: convKey,
      fields: ignored.map((k) => `${k}=${String(args[k]).slice(0, 40)}`).join(', '),
      selfQq,
    });
  }

  await http.setGroupCard(groupId, selfQq, args.card);

  const cleared = args.card === '';

  logger.info('已要求改本号群名片', {
    conv: convKey,
    groupId,
    qq: selfQq,
    card: cleared ? '(清空)' : args.card,
    ...(ignored.length ? { ignoredFields: ignored.join(', ') } : {}),
  });

  return {
    groupId,

    qq: selfQq,

    card: args.card,
    cardCleared: cleared,

    ...(ignored.length ? { ignoredTargetFields: ignored } : {}),
    note: (cleared
      ? '已要求**清空**你在本群的名片 —— 群里接下来显示的会是你的账号昵称。'
      : `已要求把你在本群的名片改成「${args.card}」。`)
      + '名片**群里所有人都看得到**；QQ 那边生效可能有一点延迟，别为确认反复重试。'
      + (ignored.length ? `（args 里的 ${ignored.join('、')} 被忽略了 —— 这个工具只改本号。）` : ''),
  };
}
