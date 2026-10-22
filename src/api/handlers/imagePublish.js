export const op = 'imagePublish';
export const authFree = true;

import { publish as publishImage, ImageError } from '../images.js';
import { BridgeApiError } from '../errors.js';

export async function run({ logger, imageBaseUrl }, convKey, args) {
  const raw = String(args?.base64 ?? '').trim();

  if (!raw) throw new BridgeApiError('缺少 `base64` 参数（图片数据）。', { status: 400, code: 'missing-base64' });

  let b64 = raw;
  let mimeType = String(args?.mimeType ?? '').trim();
  const dm = /^data:([^;,]+);base64,(.*)$/s.exec(raw);
  if (dm) {
    if (!mimeType) mimeType = dm[1];
    b64 = dm[2];
  }
  if (!mimeType) mimeType = 'image/png';

  const buf = Buffer.from(b64, 'base64');
  if (buf.length === 0) {
    throw new BridgeApiError(
      'base64 解出来是空的 —— 数据可能不是合法的 base64。',
      { status: 400, code: 'bad-base64' },
    );
  }

  const url = (() => {
    try {
      return publishImage(buf, { mimeType, baseUrl: imageBaseUrl });
    } catch (error) {

      if (error instanceof ImageError) {
        throw new BridgeApiError(error.message, { status: error.status, code: error.code });
      }
      throw error;
    }
  })();
  logger.debug('图片已暂存', {
    conv: convKey, bytes: buf.length, mimeType, url: url.slice(0, 60),
  });
  return {
    url,
    bytes: buf.length,
    mimeType,
    note: `图暂存 10 分钟。发的时候用 \`{ "image": { "url": "${url}" } }\` —— 别再抄 base64。`,
  };
}
