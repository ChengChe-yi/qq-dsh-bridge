export const op = 'getForwardMessages';
export const logsAsSend = true;

import { mediaOf, segmentsToText } from '../../chatlog/segments.js';
import { normalizeSegments } from '../../onebot/parse.js';
import { clockOf } from '../../util/format.js';
import { fetchImageBuffer, toModelImage } from '../../util/image-fetch.js';
import { publish } from '../images.js';

export async function run({ poolFor, http, logger, imageBaseUrl }, convKey, args) {
  const pool = poolFor(convKey);
  let forwardId = String(args?.id ?? '').trim();

  const ref = args?.seq;
  if (!forwardId && ref !== undefined && ref !== null && ref !== '') {
    const found = pool.find(ref);
    if (!found) return { text: `seq=${ref} 找不到这条消息。` };
    const seg = (found.message.segments ?? []).find((s) => s.type === 'forward');
    if (!seg) return { text: `seq=${ref} 这条消息里没有合并转发。` };
    forwardId = String(seg.data?.id ?? '');
  }

  if (!forwardId) return { text: '缺少转发 id（传 forward 段的 id，或传那条消息的 seq）。' };

  const data = await http.getForwardMessages(forwardId);

  const nodes = Array.isArray(data) ? data
    : Array.isArray(data?.messages) ? data.messages
      : Array.isArray(data?.message) ? data.message
        : [];

  if (!nodes.length) {
    return { text: '这条合并转发取不到内容（可能已过期，或实现不支持 get_forward_msg）。' };
  }

  const parsed = nodes.map((n) => {
    const segs = normalizeSegments(n?.message ?? n?.content ?? []);
    return { n, segs, images: mediaOf(segs).filter((x) => x.kind === 'image') };
  });

  const rows = parsed.map(({ n, segs, images }) => ({
    sender: {
      qq: String(n?.sender?.user_id ?? n?.user_id ?? ''),
      name: String(n?.sender?.card || n?.sender?.nickname || n?.nickname || ''),
    },

    segmentsText: segmentsToText({ segments: segs }, { selfQq: pool.selfQq }),

    time: n?.time ? clockOf(n.time) : undefined,

    ...(images.length ? { images: images.length } : {}),
  }));

  const payload = {
    count: rows.length,
    messages: rows,
    note: '这是合并转发**里面**的消息，按时间从旧到新。'
      + '每条的 `images` 是那条里图片的张数（没有这个字段就是没图）。'
      + '要看某一条里的图：再调一次，传 `index`（第几条，从 0 起）'
      + '—— 那个节点有多张时用 `imgIndex` 选第几张（默认 0）。',
  };

  const index = Number.isInteger(args?.index) ? args.index : null;
  if (index === null) return payload;

  const json = JSON.stringify(payload, null, 2);

  const node = parsed[index];
  if (!node) {
    return { text: `只有 ${rows.length} 个节点（index 从 0 起），没有第 ${index} 个。`, ...payload };
  }
  const who = rows[index].sender.name || rows[index].sender.qq || '未知';
  if (!node.images.length) {
    return {
      text: `第 ${index} 个节点（${who}）里没有图片 —— 这个节点的 images 字段没给就是这个意思。`,
      ...payload,
    };
  }

  const imgIndexWanted = Number.isInteger(args?.imgIndex) ? args.imgIndex : 0;
  const total = node.images.length;
  const head = `第 ${index} 个节点（${who}，共 ${rows.length} 个节点）的第 ${imgIndexWanted + 1}/${total} 张图`;

  const target = node.images[imgIndexWanted];
  if (!target) {
    return {
      content: [{
        type: 'text',
        text: `这个节点共 ${total} 张图（imgIndex 从 0 起），没有第 ${imgIndexWanted} 张。\n\n${json}`,
      }],
    };
  }

  const url = target.url || target.file || '';
  if (!url) {
    return { content: [{ type: 'text', text: `这个节点的第 ${imgIndexWanted + 1} 张图没有可用的地址。\n\n${json}` }] };
  }

  let usedUrl = url;

  try {

    let raw;
    try {
      raw = await fetchImageBuffer(url);
    } catch (firstError) {
      if (!target.file) throw firstError;
      const fresh = await http.getImageUrl(target.file);
      if (!fresh) throw firstError;
      logger.debug('转发里的图片地址过期，已用 file 重签', {
        conv: convKey, file: target.file, freshUrl: String(fresh).slice(0, 60),
      });
      raw = await fetchImageBuffer(fresh);
      usedUrl = fresh;
    }

    const img = toModelImage(raw);

    let shareUrl = '';
    try {
      shareUrl = publish(img.buffer, { mimeType: img.contentType, baseUrl: imageBaseUrl });
    } catch (error) {
      logger.warn('转发里的图片发布到本地图片层失败（图仍会给模型看）', {
        conv: convKey, error: String(error),
      });
    }

    const label = `${head}。`
      + (total > 1 ? `\n（这个节点共 ${total} 张，用 imgIndex 取第几张。）` : '')
      + (img.note ? `\n（${img.note}）` : '')
      + (shareUrl
        ? `\n要把这张图**发出去**：\`{ "image": { "url": "${shareUrl}" } }\`（约 10 分钟内有效）。`
        : '');

    return {
      content: [
        { type: 'text', text: `${label}\n\n${json}` },
        { type: 'image', data: img.buffer.toString('base64'), mimeType: img.contentType },
      ],
    };
  } catch (error) {

    return {
      content: [{
        type: 'text',
        text: `${head}取不到：${error?.message ?? error}\n地址：${usedUrl}\n\n${json}`,
      }],
    };
  }
}
