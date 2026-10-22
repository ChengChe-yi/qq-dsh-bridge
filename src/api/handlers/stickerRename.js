export const op = 'stickerRename';

export const needsAllow = true;
export const logsAsSend = true;

import {
  loadStickers, saveStickers, findSticker, shortIdOf, similarStickers,
} from '../../chatlog/stickers.js';

export async function run({ stickerPath, logger }, convKey, args) {
  const ref = String(args?.ref ?? '').trim();
  if (ref === '') {
    throw new Error(
      '要改哪条表情？传 `ref` —— qq_list_stickers 给的 ref / shortId，或它现有的描述。',
    );
  }

  const changing = ['desc', 'tags', 'localNote'].filter((k) => args?.[k] !== undefined);
  if (!changing.length) {
    throw new Error(
      '没有要改的字段 —— 至少给 `desc` / `tags` / `localNote` 之一。'
      + '（只调着玩不改东西会被拒，免得你以为改成功了。）',
    );
  }

  const entries = loadStickers({ file: stickerPath });
  if (!entries.length) {
    throw new Error('表情库是空的，没有可改的条目。先用 qq_sticker_collect 收一张。');
  }

  const sameDesc = entries.filter((e) => e.desc && String(e.desc) === ref);
  if (sameDesc.length > 1) {
    throw new Error(
      `"${ref}" 在库里对应 ${sameDesc.length} 条（描述重复），改名会改错条目 —— 请用 shortId 指明是哪一条。\n`
      + `候选：${sameDesc.map((e) => `${shortIdOf(e)}`).join('、')}\n`
      + `（先 qq_list_stickers 看一眼各自的 ref 也行。）`,
    );
  }

  let entry;
  try {
    entry = findSticker(entries, ref);
  } catch (error) {
    if (error?.hint) throw new Error(`${error.message}\n${error.hint}`);
    throw error;
  }

  if (!entry) {

    const near = similarStickers(entries, ref, { limit: 5 });
    const list = near.length ? near : entries.slice(0, 5);
    throw new Error(
      `表情库里没有 "${ref}"。\n`
      + `库里共 ${entries.length} 条，最接近的：${list.map((e) => `${e.desc || '(无描述)'}(${shortIdOf(e)})`).join('、')}\n`
      + '传 ref / shortId（**md5 前 8 位**）或完整描述都认；'
      + '不确定确切写法就先调 qq_list_stickers。',
    );
  }

  const before = {
    desc: String(entry.desc ?? ''),
    tags: Array.isArray(entry.tags) ? [...entry.tags] : [],
    localNote: String(entry.localNote ?? ''),
  };

  if (args.desc !== undefined) {
    const next = String(args.desc).trim();

    if (next === '') {
      throw new Error(
        'desc 不能改成空字符串 —— 没有描述的表情，模型只能靠背 id 来找，等于把它废掉'
        + '（库里已经有一批 desc 为空的条目了）。要弃用它请直接删掉那一条。',
      );
    }
    entry.desc = next;
  }
  if (args.tags !== undefined) {
    if (!Array.isArray(args.tags)) {
      throw new Error('`tags` 要是字符串数组，例如 ["猫", "搞笑"]。');
    }
    entry.tags = args.tags.map(String);
  }
  if (args.localNote !== undefined) entry.localNote = String(args.localNote);

  entry.updatedAt = new Date().toISOString();

  saveStickers(stickerPath, entries);

  logger.info('表情已改名', {
    conv: convKey, id: entry.id, shortId: shortIdOf(entry),
    before: before.desc, after: entry.desc, changed: changing,
  });

  return {
    id: entry.id,
    shortId: shortIdOf(entry),

    before: before.desc,
    after: entry.desc,
    tags: entry.tags,
    localNote: entry.localNote,
    changed: changing,
    note: entry.desc === before.desc
      ? `改好了（desc 没动：${changing.join('、')} 变了）。发它还是 \`{ "sticker": "${shortIdOf(entry)}" }\`。`
      : `改好了：「${before.desc || '(无描述)'}」→「${entry.desc}」。`
        + `现在按新描述也能找到它：\`{ "sticker": "${entry.desc}" }\`。`,
  };
}
