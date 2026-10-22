import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { ALLOWED as IMAGE_EXT_BY_MIME } from '../api/images.js';

export const MAX_STICKER_BYTES = 5 * 1024 * 1024;

const MIME_BY_EXT = Object.freeze({
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
});

const ALLOWED_HOSTS = new Set([
  'p.qpic.cn',
  'gchat.qpic.cn',
  'multimedia.nt.qq.com.cn',
]);

export class StickerError extends Error {
  constructor(message, { hint = '' } = {}) {
    super(message);
    this.name = 'StickerError';
    this.hint = hint;
  }
  toString() {
    return this.hint ? `${this.name}: ${this.message}\n  ${this.hint}` : `${this.name}: ${this.message}`;
  }
}

export function loadStickers({ file } = {}) {
  if (!file || !fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, 'utf8');
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (error) {
    throw new StickerError(`表情库 JSON 解析失败：${error.message}`, {
      hint: `文件：${file}。修好它，或删掉让它重新生成。`,
    });
  }
  if (!Array.isArray(doc)) {
    throw new StickerError('表情库顶层必须是数组', { hint: `文件：${file}` });
  }
  return doc.filter((x) => x && typeof x === 'object' && x.id);
}

export function saveStickers(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export function extForMime(mimeType) {
  const key = String(mimeType ?? '').split(';')[0].trim().toLowerCase();
  return IMAGE_EXT_BY_MIME[key] ?? null;
}

export function stickerDir(file) {
  return path.join(path.dirname(file), 'stickers');
}

export function md5Of(buffer) {
  return crypto.createHash('md5').update(buffer).digest('hex').toUpperCase();
}

export function findByMd5(entries, md5) {
  const want = String(md5 ?? '').toLowerCase();
  if (want === '') return null;
  return entries.find((e) => {
    if (String(e.md5 ?? '').toLowerCase() === want) return true;
    const f = String(e.file ?? '');
    return f !== '' && path.basename(f).toLowerCase().startsWith(want);
  }) ?? null;
}

export function findSticker(entries, ref) {
  const want = String(ref ?? '').trim();
  if (!want) return null;

  const lower = want.toLowerCase();

  for (const e of entries) {
    if (String(e.id) === want) return e;
    if (e.resId && String(e.resId) === want) return e;
  }

  if (/^[0-9a-f]{8}$/i.test(want)) {
    const hits = entries.filter((e) => shortIdOf(e).toLowerCase() === lower);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) {
      throw new StickerError(`短 id "${want}" 匹配到多条表情，请用完整 ref`, {
        hint: `候选：${hits.map((e) => e.id).join('、')}`,
      });
    }
  }

  for (const e of entries) {
    if (e.md5 && String(e.md5).toLowerCase() === lower) return e;
  }

  for (const e of entries) {
    if (e.desc && String(e.desc) === want) return e;
  }

  const hits = entries.filter((e) => e.desc && String(e.desc).toLowerCase().includes(lower));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    throw new StickerError(`"${want}" 匹配到多个表情，请用更精确的 shortId`, {
      hint: `候选：${hits.map((e) => `${e.desc}(${shortIdOf(e)})`).join('、')}`,
    });
  }

  return null;
}

export function similarStickers(entries, want, { limit = 5 } = {}) {
  const q = String(want ?? '').trim().toLowerCase();
  if (q === '') return [];

  const grams = (s) => {
    const out = new Set();
    for (let i = 0; i + 1 < s.length; i += 1) out.add(s.slice(i, i + 2));
    return out;
  };
  const gq = grams(q);

  return entries
    .map((e) => {
      const desc = String(e.desc ?? '').toLowerCase();
      const id = String(e.id ?? '').toLowerCase();
      const md5 = String(e.md5 ?? '').toLowerCase();
      let score = 0;
      if (desc && (desc.includes(q) || q.includes(desc))) score += 3;
      if (id.startsWith(q) || md5.startsWith(q) || shortIdOf(e).toLowerCase().startsWith(q)) score += 3;
      const g = grams(desc);
      let hit = 0;
      for (const x of gq) if (g.has(x)) hit += 1;
      if (gq.size) score += (hit / gq.size) * 2;
      return { e, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.e);
}

export function describeStickers(entries, { limit = 50 } = {}) {
  return entries.slice(0, limit).map((e, i) => ({
    ref: e.id,
    desc: e.desc || '(无描述)',

    shortId: shortIdOf(e),
    useCount: e.useCount ?? 0,
    index: i,
  }));
}

export function shortIdOf(entry) {
  const md5 = String(entry?.md5 ?? '').toUpperCase();
  if (md5.length >= 8) return md5.slice(0, 8);

  const m = /([0-9A-F]{8,})/i.exec(String(entry?.id ?? ''));
  return m ? m[1].toUpperCase().slice(0, 8) : String(entry?.id ?? '').slice(0, 8);
}

export function assertAllowedUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new StickerError(`表情地址不是合法 URL：${raw}`);
  }
  if (u.protocol !== 'https:') {
    throw new StickerError(`表情地址必须是 https（实际 ${u.protocol}）`);
  }
  if (!ALLOWED_HOSTS.has(u.hostname)) {
    throw new StickerError(`表情地址域名不在白名单内：${u.hostname}`, {
      hint: `允许：${[...ALLOWED_HOSTS].join('、')}`,
    });
  }
  return u;
}

export async function fetchStickerImage(url, { fetchImpl = globalThis.fetch, maxBytes = MAX_STICKER_BYTES } = {}) {
  assertAllowedUrl(url);

  const res = await fetchImpl(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new StickerError(`下载表情失败：HTTP ${res.status}`);
  }

  const declared = Number(res.headers?.get?.('content-length') ?? 0);
  if (declared && declared > maxBytes) {
    throw new StickerError(`表情太大（${declared} 字节 > 上限 ${maxBytes}）`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) {
    throw new StickerError(`表情太大（${buf.length} 字节 > 上限 ${maxBytes}）`);
  }
  if (buf.length === 0) {
    throw new StickerError('表情图片是空的');
  }

  return { buffer: buf, contentType: res.headers?.get?.('content-type') ?? '' };
}

export async function loadStickerBytes(entry, { fetchImpl = globalThis.fetch, maxBytes = MAX_STICKER_BYTES } = {}) {
  const local = String(entry?.file ?? '').trim();

  if (local !== '') {

    if (!fs.existsSync(local)) {
      throw new StickerError(
        `表情的图片文件不在了：${local}\n`
        + '（收藏时落盘的那个文件被删掉/挪走了 —— 重新用 qq_sticker_collect 收一次，'
        + '或把条目里的 file 改成真实路径。）',
        { hint: 'state/stickers/ 下的文件不该手工挪动。' },
      );
    }
    const buffer = fs.readFileSync(local);
    if (buffer.length === 0) {
      throw new StickerError(`表情文件是空的：${local}（多半是写坏了 —— 重新收藏一次）`);
    }

    if (buffer.length > maxBytes) {
      throw new StickerError(
        `表情文件太大（${buffer.length} 字节 > 上限 ${maxBytes}）：${local}`
        + '（发送路径也会拒它 —— 换一张小图重新收藏。）',
      );
    }
    const ext = path.extname(local).slice(1).toLowerCase();
    return { buffer, contentType: MIME_BY_EXT[ext] ?? 'image/png', source: 'file' };
  }

  const url = String(entry?.url ?? '').trim();
  if (url === '') {

    throw new StickerError(
      `表情 ${entry?.id ?? '(无 id)'} 没有图：file 和 url 都是空的`
      + '（这条只剩描述，发不出去 —— 用 qq_sticker_collect 重新收一张，或把它从库里删掉。）',
    );
  }

  const got = await fetchStickerImage(url, { fetchImpl, maxBytes });
  return { ...got, source: 'url' };
}

export function bumpUse({ file, id, context = '', now = Date.now } = {}) {
  try {
    const entries = loadStickers({ file });
    const e = entries.find((x) => String(x.id) === String(id));
    if (!e) return;
    e.useCount = (e.useCount ?? 0) + 1;
    e.lastUsedAt = now();
    e.lastContext = String(context).slice(0, 200);

    saveStickers(file, entries);
  } catch {

  }
}

export function stickerFile(root) {
  return path.join(root, 'state', 'stickers.json');
}
