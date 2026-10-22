export const op = 'imageFetch';
export const authFree = true;
export const warnOnError = "图片取回失败";

import { retrieve, idFromOwnUrl } from '../images.js';
import { BridgeApiError } from '../errors.js';

export async function run({ apiPort, logger }, convKey, args) {
  const url = String(args?.url ?? '').trim();
  if (!url) throw new BridgeApiError('缺少 `url` 参数。', { status: 400, code: 'missing-url' });

  const id = idFromOwnUrl(url);
  if (!id) {
    throw new BridgeApiError(
      `只能取回**本桥接自己暂存**的图。这个地址不在允许范围内：${url.slice(0, 100)}\n`
      + `允许的形状：http://127.0.0.1:${apiPort}/img/<32位id>.<png|jpg|webp|gif>\n`
      + '（不接受外网地址 —— 那会变成一个 SSRF 入口。）',
      { status: 400, code: 'url-not-allowed' },
    );
  }

  const hit = retrieve(id);
  if (!hit) {
    throw new BridgeApiError(
      `这张图已经过期了（暂存 10 分钟）或不存在：${url}\n重新渲染 / 重新发布一次即可。`,
      { status: 404, code: 'image-gone' },
    );
  }

  logger.debug('图片已取回', { conv: convKey, bytes: hit.data.length, id: id.slice(0, 12) });
  return {
    base64: hit.data.toString('base64'),
    mimeType: hit.mimeType,
    bytes: hit.data.length,
  };
}
