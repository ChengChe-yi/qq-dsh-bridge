import crypto from 'node:crypto';

export const TTL_MS = 10 * 60 * 1000;

export const MAX_ENTRIES = 200;

const ALLOWED = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
});

export class ImageError extends Error {
  constructor(message, { status = 400, code = 'bad-image' } = {}) {
    super(message);
    this.name = 'ImageError';
    this.status = status;
    this.code = code;
  }
}

const store = new Map();

const newId = () => crypto.randomBytes(16).toString('hex');

export function sweep(now = Date.now()) {
  for (const [id, v] of store) {
    if (now - v.at > TTL_MS) store.delete(id);
  }
  if (store.size > MAX_ENTRIES) {
    const byAge = [...store.entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [id] of byAge.slice(0, store.size - MAX_ENTRIES)) store.delete(id);
  }
}

export function publish(data, { mimeType = 'image/png', baseUrl } = {}) {
  if (!Buffer.isBuffer(data) || data.length === 0) {
    throw new ImageError('publish 需要非空的 Buffer', { code: 'empty-buffer' });
  }
  const ext = ALLOWED[String(mimeType).toLowerCase()];
  if (!ext) {
    throw new ImageError(
      `不支持的图片类型 "${mimeType}"。只允许：${Object.keys(ALLOWED).join(' / ')}`
      + '（刻意不含 image/svg+xml —— SVG 能内嵌脚本，在浏览器里打开就是 XSS）。',
      { code: 'bad-mime' },
    );
  }

  sweep();
  const id = newId();
  store.set(id, { data, mimeType, at: Date.now() });
  return `${baseUrl}/img/${id}.${ext}`;
}

export function retrieve(id) {
  const key = String(id ?? '').toLowerCase();

  if (!/^[0-9a-f]{32}$/.test(key)) return null;

  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > TTL_MS) {
    store.delete(key);
    return null;
  }
  return { data: entry.data, mimeType: entry.mimeType };
}

export function idFromOwnUrl(rawUrl) {
  let u;
  try {
    u = new URL(String(rawUrl));
  } catch {
    return null;
  }
  if (u.protocol !== 'http:') return null;

  const host = u.hostname;
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1' && host !== '[::1]') return null;

  const m = /^\/img\/([0-9a-f]{32})\.[a-z]+$/i.exec(u.pathname);
  return m ? m[1].toLowerCase() : null;
}

export const pendingCount = () => store.size;

export const clear = () => store.clear();

export { ALLOWED };
