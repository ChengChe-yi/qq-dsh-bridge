export const op = 'getMessageImages';
export const logsAsSend = true;

import { mediaOf, textOf } from '../../chatlog/segments.js';
import { fetchImageBuffer, toModelImage } from '../../util/image-fetch.js';
import { publish } from '../images.js';

export async function run({ poolFor, http, logger, imageBaseUrl }, convKey, args) {
  const pool = poolFor(convKey);

  const ref = args.seq;
  const found = pool.find(ref);
  for (const m of found ? [found.message] : []) {

    const media = mediaOf(m).filter((x) => x.kind === 'image');
    if (!media.length) return { text: `seq=${ref} 这条消息里没有图片。` };

    const want = Number.isInteger(args.index) ? args.index : 0;
    const target = media[want];
    if (!target) {
      return { text: `seq=${ref} 只有 ${media.length} 张图（index 从 0 起），没有第 ${want} 张。` };
    }

    const url = target.url || target.file || '';
    if (!url) return { text: `seq=${ref} 第 ${want + 1} 张图没有可用的地址。` };

    let usedUrl = url;

    try {

      let raw;
      try {
        raw = await fetchImageBuffer(url);
      } catch (firstError) {
        if (!target.file) throw firstError;
        const fresh = await http.getImageUrl(target.file);
        if (!fresh) throw firstError;
        logger.debug('图片地址过期，已用 file 重签', {
          seq: ref, file: target.file, freshUrl: fresh.slice(0, 60),
        });
        raw = await fetchImageBuffer(fresh);
        usedUrl = fresh;
      }

      const img = toModelImage(raw);

      logger.debug('图片处理', {
        seq: ref,
        url: usedUrl.slice(0, 60),
        rawKB: Math.round(raw.buffer.length / 1024),
        rawBase64KB: Math.round(Math.ceil(raw.buffer.length / 3) * 4 / 1024),
        outKB: Math.round(img.buffer.length / 1024),
        outType: img.contentType,
        note: img.note,
      });

      const sender = m.sender?.name ?? '未知';
      const body = textOf(m);
      const label = body
        ? `seq=${ref} 的第 ${want + 1}/${media.length} 张图（${sender} 发的）。`
          + `\n这条消息的文字部分是：「${body}」—— 图要结合这句话看。`
        : `seq=${ref} 的第 ${want + 1}/${media.length} 张图（${sender} 发的，只有图没有文字）：`;

      let shareUrl = '';
      try {
        shareUrl = publish(img.buffer, { mimeType: img.contentType, baseUrl: imageBaseUrl });
      } catch (error) {

        logger.warn('图片发布到本地图片层失败（图仍会给模型看）', { seq: ref, error: String(error) });
      }

      const howto = shareUrl
        ? `\n要把这张图**发出去**（转给别人/别的群）：\`{ "image": { "url": "${shareUrl}" } }\`。`
          + '\n（这个地址约 10 分钟内有效；**别抄 base64** —— 抄错一个字符图就废了。）'
        : '';
      return {
        text: `${img.note ? `${label}\n（${img.note}）` : label}${howto}`,
        images: [{ data: img.buffer.toString('base64'), mimeType: img.contentType }],
      };
    } catch (error) {

      return {
        text: `seq=${ref} 的图片下载失败：${error.message ?? error}\n地址：${usedUrl}`,
      };
    }
  }
  throw new Error(`找不到 seq=${ref} 的消息`);
}
