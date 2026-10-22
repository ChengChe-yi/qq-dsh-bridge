import * as unread from './unread.js';
import * as readChat from './readChat.js';
import * as send from './send.js';
import * as recall from './recall.js';
import * as setNickname from './setNickname.js';
import * as setGroupCard from './setGroupCard.js';
import * as wait from './wait.js';
import * as getMessageImages from './getMessageImages.js';
import * as listStickers from './listStickers.js';
import * as groupInfo from './groupInfo.js';
import * as getForwardMessages from './getForwardMessages.js';
import * as memberList from './memberList.js';
import * as memberInfo from './memberInfo.js';
import * as imagePublish from './imagePublish.js';
import * as imageFetch from './imageFetch.js';
import * as stickerCollect from './stickerCollect.js';
import * as stickerRename from './stickerRename.js';

export const HANDLERS = Object.freeze([
  unread,
  readChat,
  send,
  recall,

  setNickname,
  setGroupCard,
  wait,
  getMessageImages,
  listStickers,
  groupInfo,
  getForwardMessages,
  memberList,
  memberInfo,
  imagePublish,
  imageFetch,

  stickerCollect,
  stickerRename,
]);

export const OPS = new Map(HANDLERS.map((h) => [h.op, h]));

function declaredDeps(fn) {
  const m = /^[^(]*\(\s*\{([^}]*)\}/.exec(String(fn));
  if (!m) return [];
  return m[1]
    .split(',')
    .map((s) => s.trim().split(/[=:]/)[0].trim())
    .filter(Boolean);
}

export function buildHandlers(deps) {
  const out = {};
  const missing = [];

  for (const spec of HANDLERS) {
    const lack = declaredDeps(spec.run).filter((k) => !(k in deps));
    if (lack.length) missing.push(`${spec.op} 需要 ${lack.join(', ')}`);
    out[spec.op] = (convKey, args) => spec.run(deps, convKey, args);
  }

  if (missing.length) {
    throw new ReferenceError(
      '工具面 handler 缺少依赖（启动期自检）—— 检查 main.js 传给 buildHandlers 的 deps：\n'
      + missing.map((m) => '  · ' + m).join('\n'),
    );
  }
  return out;
}
