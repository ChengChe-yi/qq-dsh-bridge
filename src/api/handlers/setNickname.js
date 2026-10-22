export const op = 'setNickname';
export const needsAllow = true;
export const logsAsSend = true;

const MAX_NICKNAME_CHARS = 40;

function charCount(text) {
  return [...text].length;
}

export async function run({ http, logger }, convKey, args) {
  const nickname = args?.nickname;

  if (typeof nickname !== 'string') {
    throw new Error('要给新昵称：传 `nickname`（字符串）。');
  }
  if (nickname.trim() === '') {
    throw new Error('`nickname` 不能是空的 —— 昵称没有"取消"这种操作，要换就直接给新名字。');
  }
  if (charCount(nickname) > MAX_NICKNAME_CHARS) {
    throw new Error(
      `\`nickname\` 太长了（${charCount(nickname)} 个字符 > 上限 ${MAX_NICKNAME_CHARS}）——`
      + '这不像一个昵称，像一整段话。',
    );
  }

  let before = null;
  try {
    const info = await http.getLoginInfo();
    before = typeof info?.nickname === 'string' ? info.nickname : '';
  } catch (error) {
    logger.warn('改名前读账号资料失败（照常改名，只是报不出改前值）', {
      conv: convKey,
      error: String(error),
    });
  }

  await http.setNickname(nickname);

  logger.info('已要求改本号账号昵称（全局改名）', {
    conv: convKey,
    before: before === null ? '(未取到)' : before,
    after: nickname,
  });

  const same = before !== null && before === nickname;
  const beforeText = before === null
    ? '改前的昵称没读到'
    : `改前是${before === '' ? '（空）' : `「${before}」`}`;

  return {

    before,

    after: nickname,

    ...(same ? { unchanged: true } : {}),
    note: [
      `已要求把**账号昵称**改成「${nickname}」（${beforeText}）。`,
      '这是**全局**改名 —— 所有群、所有好友看到的名字都会变。',
      'QQ 那边生效可能有一点延迟；**别为了确认反复重试**，重试不会让它更快。',
      ...(same ? ['注意：这个名字本来就是这个 —— 这次等于没改。'] : []),
    ].join(''),
  };
}
