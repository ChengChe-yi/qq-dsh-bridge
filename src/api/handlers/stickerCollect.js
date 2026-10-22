export const op = 'stickerCollect';

export const needsAllow = true;

export const logsAsSend = true;

import fs from 'node:fs';
import path from 'node:path';
import { mediaOf } from '../../chatlog/segments.js';
import {
  loadStickers, saveStickers, findByMd5, md5Of, shortIdOf, stickerDir, extForMime,
  MAX_STICKER_BYTES,
} from '../../chatlog/stickers.js';
import { fetchImageBuffer } from '../../util/image-fetch.js';
import { idFromOwnUrl, retrieve } from '../images.js';

export async function run({ poolFor, http, logger, stickerPath }, convKey, args) {
  const pool = poolFor(convKey);

  const desc = String(args?.desc ?? '').trim();
  if (desc === '') {
    throw new Error(
      '收藏表情必须给 `desc`（描述）。'
      + '这是模型日后挑表情的**唯一**依据 —— 库里那些 desc 为空的条目就等于废的（模型只能靠背 id 来找）。'
      + '给个短描述，比如 "猫娘抱鱼"、"狗头疑惑"。',
    );
  }

  const bytes = await readBytes({ pool, http, convKey, args });

  if (bytes.buffer.length > MAX_STICKER_BYTES) {
    throw new Error(
      `这张图太大（${Math.round(bytes.buffer.length / 1024)}KB > 上限 `
      + `${Math.round(MAX_STICKER_BYTES / 1024)}KB）—— 发送路径也会拒它，换一张小图。`,
    );
  }

  const ext = extForMime(bytes.mimeType);
  if (!ext) {
    throw new Error(
      `这个图片类型收不了："${bytes.mimeType}"。`
      + '只支持 png / jpeg / webp / gif（与图片层同一份白名单 —— 它将来还要能发出去）。',
    );
  }

  const md5 = md5Of(bytes.buffer);
  const dir = stickerDir(stickerPath);
  const file = path.join(dir, `${md5}.${ext}`);

  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, bytes.buffer);
  fs.renameSync(tmp, file);

  const entries = loadStickers({ file: stickerPath });
  const exist = findByMd5(entries, md5);
  const now = new Date().toISOString();

  if (exist) {
    const before = String(exist.desc ?? '');
    exist.desc = desc;
    if (Array.isArray(args?.tags)) exist.tags = args.tags.map(String);
    if (args?.localNote !== undefined) exist.localNote = String(args.localNote);

    exist.file = file;
    exist.md5 = md5;
    exist.updatedAt = now;
    saveStickers(stickerPath, entries);

    logger.info('表情已在库里，只更新描述', {
      conv: convKey, id: exist.id, shortId: shortIdOf(exist), md5, before, after: desc,
    });

    return {
      replaced: true,
      id: exist.id,
      shortId: shortIdOf(exist),
      desc,
      md5,
      file,
      bytes: bytes.buffer.length,
      from: bytes.from,
      note: `库里**本来就有这张图**（md5 相同），没有新增，只更新了描述：`
        + `「${before || '(无描述)'}」→「${desc}」。`
        + `直接可以发：\`{ "sticker": "${shortIdOf(exist)}" }\`。`,
    };
  }

  const id = `collected_${md5}`;
  const entry = {
    id,
    resId: id,

    url: '',
    md5,
    desc,
    localNote: args?.localNote !== undefined ? String(args.localNote) : '',
    tags: Array.isArray(args?.tags) ? args.tags.map(String) : [],
    usage: '',
    source: 'collected',

    file,
    useCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  entries.push(entry);
  saveStickers(stickerPath, entries);

  logger.info('已收藏表情', {
    conv: convKey, id, desc, md5, bytes: bytes.buffer.length, from: bytes.from, file,
  });

  return {
    replaced: false,
    id,
    shortId: shortIdOf(entry),
    desc,
    md5,
    file,
    tags: entry.tags,
    bytes: bytes.buffer.length,
    from: bytes.from,
    note: `收到库里了（字节已落盘，以后**不依赖那个会过期的 URL**）。`
      + `发它：\`{ "sticker": "${shortIdOf(entry)}" }\`（或直接写描述「${desc}」）。`,
  };
}

async function readBytes({ pool, http, convKey, args }) {
  const ownUrl = String(args?.url ?? '').trim();

  if (ownUrl !== '') {

    const id = idFromOwnUrl(ownUrl);
    if (!id) {
      throw new Error(
        '`url` 只接受**本桥接自己暂存**的图（形如 http://127.0.0.1:<端口>/img/<32位id>.<png|jpg|webp|gif>）。'
        + `这个地址不行：${ownUrl.slice(0, 120)}\n`
        + '（要收藏群里/转发里的图，用 `seq` + `index`；不接受任意外网地址 —— 那会变成一个抓取入口。）',
      );
    }
    const hit = retrieve(id);
    if (!hit) {
      throw new Error(
        `这张图已经**过期**了（本地暂存 10 分钟）或不存在：${ownUrl}\n`
        + '先用 qq_get_message_images（或 qq_get_forward 带 index）重新取一次，拿新的短 URL 再收藏。',
      );
    }
    return { buffer: hit.data, mimeType: hit.mimeType, from: 'own-url' };
  }

  const ref = args?.seq;
  if (ref === undefined || ref === null || ref === '') {
    throw new Error(
      '要收藏哪张图？两种传法：\n'
      + '  · `seq`（那条消息的定位符）+ 可选 `index`（那条里的第几张图，默认 0）\n'
      + '  · `url`（本桥接发布的 /img/... 短地址，如 qq_get_message_images 返回的那个）',
    );
  }

  const found = pool.find(ref);
  if (!found) throw new Error(`按 seq=${ref} 找不到这条消息。`);

  const media = mediaOf(found.message).filter((x) => x.kind === 'image');
  if (!media.length) throw new Error(`seq=${ref} 这条消息里没有图片。`);

  const want = Number.isInteger(args?.index) ? args.index : 0;
  const target = media[want];
  if (!target) {
    throw new Error(`seq=${ref} 只有 ${media.length} 张图（index 从 0 起），没有第 ${want} 张。`);
  }
  const url = target.url || target.file || '';
  if (!url) throw new Error(`seq=${ref} 第 ${want + 1} 张图没有可用的地址。`);

  try {
    const raw = await fetchImageBuffer(url);
    return { buffer: raw.buffer, mimeType: raw.contentType, from: 'message' };
  } catch (firstError) {
    if (!target.file) throw firstError;
    const fresh = await http.getImageUrl(target.file);
    if (!fresh) throw firstError;
    logger.debug('收藏时图片地址过期，已用 file 重签', {
      conv: convKey, file: target.file, freshUrl: String(fresh).slice(0, 60),
    });
    const raw = await fetchImageBuffer(fresh);
    return { buffer: raw.buffer, mimeType: raw.contentType, from: 'message-resign' };
  }
}
