const MAX_BASE64_CHARS = 3 * 1024 * 1024;

const IMAGE_HOSTS = new Set([
  'multimedia.nt.qq.com.cn',
  'gchat.qpic.cn',
  'p.qpic.cn',
  'c2cpicdw.qpic.cn',
  'c3cpicdw.qpic.cn',
]);

export async function fetchImageBuffer(url, { maxBytes = 8 * 1024 * 1024 } = {}) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    throw new Error(`图片地址不是合法 URL：${String(url).slice(0, 120)}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`图片地址协议不支持：${u.protocol}`);
  }
  if (!IMAGE_HOSTS.has(u.hostname)) {
    throw new Error(`图片域名不在白名单内：${u.hostname}（允许：${[...IMAGE_HOSTS].join(', ')}）`);
  }

  const res = await fetch(u.href, { redirect: 'follow' });
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);

  const declared = Number(res.headers?.get?.('content-length') ?? 0);
  if (declared && declared > maxBytes) {
    throw new Error(`图片太大（${declared} 字节 > 上限 ${maxBytes}）`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error('图片是空的');
  if (buf.length > maxBytes) throw new Error(`图片太大（${buf.length} 字节）`);

  return { buffer: buf, contentType: res.headers?.get?.('content-type') ?? 'image/png' };
}

const b64Len = (bytes) => {
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new Error(`b64Len 需要字节数，收到 ${bytes}（类型 ${typeof bytes}）`);
  }
  return Math.ceil(bytes / 3) * 4;
};

export function toModelImage({ buffer, contentType }, { maxChars = MAX_BASE64_CHARS } = {}) {
  if (b64Len(buffer.length) <= maxChars) return { buffer, contentType };

  return {
    buffer,
    contentType,
    note: `图片过大（base64 约 ${(b64Len(buffer.length) / 1024 / 1024).toFixed(1)}MB，`
      + `超过上限 ${(maxChars / 1024 / 1024).toFixed(0)}MB），原样返回 —— 这次很可能看不到。`,
  };
}
