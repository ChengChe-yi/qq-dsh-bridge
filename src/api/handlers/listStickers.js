export const op = 'listStickers';
export const logsAsSend = true;

import { loadStickers, describeStickers } from '../../chatlog/stickers.js';

export async function run({ stickerPath }, convKey, args) {
  const entries = loadStickers({ file: stickerPath });
  if (!entries.length) {
    return {
      stickers: [],
      note: '表情库是空的。往 state/stickers.json 里加条目即可，或让本号在 QQ 里收藏表情后同步。',
    };
  }
  return {
    stickers: describeStickers(entries, { limit: args?.limit ?? 50 }),
    note: '用 ref（或 shortId、描述）放进 qq_send 的 sticker 段：'
      + '`{ "segments": [{ "text": "这个好笑" }, { "sticker": "猫娘抱鱼" }] }`。'
      + '表情**可以和文字同一条发**，也可以配 @ 和引用。',
  };
}
