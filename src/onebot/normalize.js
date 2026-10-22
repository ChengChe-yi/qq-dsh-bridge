import { conversationOf, normalizeSegments, summarizeSegments } from './parse.js';
import { deriveMsgType } from '../chatlog/segments.js';

export const MAX_IMAGE_BASE64_CHARS = 4 * 1024 * 1024;

export async function normalizeOutgoingBubble(bubble, { resolveReply, resolveSticker } = {}) {
  if (!bubble || typeof bubble !== 'object' || Array.isArray(bubble)) {
    return { ok: false, segments: [], errors: ['这一条不是对象'] };
  }

  const keys = Object.keys(bubble);
  if (keys.length === 0) {
    return { ok: false, segments: [], errors: ['这一条是空对象'] };
  }

  const hasSegments = 'segments' in bubble;

  if (hasSegments && keys.some((k) => k !== 'segments')) {
    const others = keys.filter((k) => k !== 'segments').join('、');
    return {
      ok: false,
      segments: [],
      errors: [
        `这一条里既有 segments 又有 ${others} —— **二选一**：\n`
        + '  · 常用：`{ "reply": 1, "at": "123", "text": " 内容" }`（顺序固定）\n'
        + '  · 要自定义顺序：`{ "segments": [ { "at": "123" }, { "text": " 内容" } ] }`',
      ],
    };
  }

  if (hasSegments) {
    return normalizeOutgoingSegments(bubble.segments, { resolveReply, resolveSticker });
  }

  const order = ['reply', 'at', 'image', 'sticker', 'face', 'text'];
  const unknown = keys.filter((k) => !order.includes(k));
  if (unknown.length) {
    return {
      ok: false,
      segments: [],
      errors: [`不认识的键 ${unknown.join('、')}（可用：${order.join(' / ')}；要自定义顺序用 segments）`],
    };
  }

  const flat = [];
  for (const kind of order) {
    if (!(kind in bubble)) continue;
    const value = bubble[kind];

    if ((kind === 'at' || kind === 'reply') && Array.isArray(value)) {
      for (const one of value) flat.push({ [kind]: one });
    } else {
      flat.push({ [kind]: value });
    }
  }

  const r = await normalizeOutgoingSegments(flat, { resolveReply, resolveSticker });
  if (!r.ok) return r;

  return { ok: true, segments: spaceAfterAt(r.segments), errors: [] };
}

export function spaceAfterAt(segments) {
  const out = [];
  for (const [i, seg] of segments.entries()) {
    out.push(seg);
    if (seg?.type !== 'at') continue;

    const next = segments[i + 1];
    if (!next) {

      out.push({ type: 'text', data: { text: ' ' } });
      continue;
    }

    if (next.type === 'text') {
      const t = String(next.data?.text ?? '');
      if (t.startsWith(' ') || t.startsWith('\n') || t === '') continue;
      out.push({ type: 'text', data: { text: ' ' } });
      continue;
    }

    out.push({ type: 'text', data: { text: ' ' } });
  }
  return out;
}

export async function normalizeOutgoingSegments(raw, { resolveReply, resolveSticker } = {}) {
  const list = Array.isArray(raw) ? raw : [raw];
  const segments = [];
  const errors = [];

  if (list.length === 0) {
    return { ok: false, segments: [], errors: ['segments 是空数组 —— 至少要有一段'] };
  }

  for (const [i, item] of list.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`第 ${i + 1} 段不是对象`);
      continue;
    }

    if (typeof item.type === 'string') {
      segments.push({ type: item.type, data: item.data ?? {} });
      continue;
    }

    const keys = Object.keys(item);
    if (keys.length === 0) {
      errors.push(`第 ${i + 1} 段是空对象`);
      continue;
    }
    if (keys.length > 1) {

      errors.push(`第 ${i + 1} 段有多个键（${keys.join(',')}）—— 一段只能有一个类型，多段请写成数组`);
      continue;
    }

    const [kind] = keys;
    const value = item[kind];

    switch (kind) {
      case 'text': {
        const t = String(value ?? '');
        if (t === '') errors.push(`第 ${i + 1} 段 text 是空的`);
        else segments.push({ type: 'text', data: { text: t } });
        break;
      }

      case 'at': {

        const data = (value && typeof value === 'object')
          ? { qq: String(value.qq ?? value.id ?? ''), name: value.name }
          : { qq: String(value ?? '') };
        if (data.qq === '') {
          errors.push(`第 ${i + 1} 段 at 缺少 QQ 号`);
          break;
        }
        if (data.name === undefined) delete data.name;
        segments.push({ type: 'at', data });
        break;
      }

      case 'reply': {

        const spec = (value && typeof value === 'object') ? value : { seq: value };
        const ref = spec.seq;
        let messageId = spec.id !== undefined ? String(spec.id) : '';
        if (!messageId && ref !== undefined) {
          messageId = resolveReply ? String((await resolveReply(ref)) ?? '') : '';
          if (!messageId) {
            errors.push(`第 ${i + 1} 段 reply 引用的 seq=${ref} 找不到对应消息`);
            break;
          }
        }
        if (!messageId) {
          errors.push(`第 ${i + 1} 段 reply 既没给 seq 也没给 id`);
          break;
        }

        segments.push({
          type: 'reply',
          data: (ref !== undefined && ref !== null && ref !== '')
            ? { id: messageId, seq: String(ref) }
            : { id: messageId },
        });
        break;
      }

      case 'image': {
        const d = (value && typeof value === 'object') ? value : {};

        const rawB64 = typeof d.base64 === 'string' ? d.base64 : '';
        if (rawB64 !== '') {

          const body = rawB64.replace(/^data:[^;,]*;base64,/i, '').replace(/\s+/g, '');
          if (body.length < 32) {
            errors.push(`第 ${i + 1} 段 image 的 base64 太短，不像一张图`);
            break;
          }
          if (body.length > MAX_IMAGE_BASE64_CHARS) {
            errors.push(
              `第 ${i + 1} 段 image 的 base64 太大（${body.length} > ${MAX_IMAGE_BASE64_CHARS} 字符）。`
              + '渲染公式时把 dpi 调小一点，或者别发整张截图。',
            );
            break;
          }
          if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body)) {
            errors.push(`第 ${i + 1} 段 image 的 base64 里有非法字符（原样抄回来，别改动或省略）`);
            break;
          }

          segments.push({ type: 'image', data: { file: `base64://${body}` } });
          break;
        }

        if (!d.url && !d.file) {
          errors.push(
            `第 ${i + 1} 段 image 需要 url / file / base64 之一。`
            + 'url 只能用上下文里出现过的图片地址；'
            + '要发自己生成的图（如公式），用 latex_to_image 拿到 base64 再放到这里。',
          );
          break;
        }
        segments.push({ type: 'image', data: { ...d } });
        break;
      }

      case 'face': {
        const d = (value && typeof value === 'object') ? value : { id: value };
        if (d.id === undefined || d.id === null || d.id === '') {
          errors.push(`第 ${i + 1} 段 face 缺少 id`);
          break;
        }
        segments.push({ type: 'face', data: { ...d } });
        break;
      }

      case 'sticker': {
        const ref = String((value && typeof value === 'object'
          ? (value.ref ?? value.id ?? value.sticker)
          : value) ?? '').trim();
        if (ref === '') {
          errors.push(`第 ${i + 1} 段 sticker 缺少表情引用（传 qq_list_stickers 给的 ref / shortId / 描述）`);
          break;
        }
        if (!resolveSticker) {
          errors.push(`第 ${i + 1} 段 sticker 无法解析（内部未注入 resolveSticker）`);
          break;
        }
        let resolved;
        try {
          resolved = await resolveSticker(ref);
        } catch (error) {
          errors.push(`第 ${i + 1} 段 sticker 取图失败：${error?.message ?? error}`);
          break;
        }
        if (!resolved?.base64) {
          errors.push(`第 ${i + 1} 段找不到表情 "${ref}"（先用 qq_list_stickers 看有哪些）`);
          break;
        }

        segments.push({
          type: 'image',
          data: {
            file: `base64://${resolved.base64}`,
            ...(resolved.desc ? { summary: String(resolved.desc) } : {}),
          },
        });
        break;
      }

      default:

        errors.push(`第 ${i + 1} 段的类型 "${kind}" 不认识（可用：text / at / reply / image / sticker / face）`);
    }
  }

  return { ok: errors.length === 0 && segments.length > 0, segments, errors };
}

export function isConvAllowed(convKey, allow = {}) {
  const [kind, id] = String(convKey).split(':');
  const list = kind === 'group' ? allow.groups : allow.private;
  if (Array.isArray(list) && list.map(String).includes(String(id))) return true;

  const empty = !allow.groups?.length && !allow.private?.length;
  return Boolean(allow.allowAllWhenEmpty) && empty;
}

export function normalizeEvent(event) {
  const conv = conversationOf(event);
  const isGroup = conv.kind === 'group';
  const segments = normalizeSegments(event.message);
  const summary = summarizeSegments(segments, { selfQq: event.self_id });

  const selfQq = String(event.self_id ?? '');
  const senderQq = String(event.user_id ?? '');
  const name = event.sender?.card || event.sender?.nickname || senderQq;

  const groupRole = event.sender?.role === 'owner' ? 'groupOwner'
    : event.sender?.role === 'admin' ? 'admin'
      : 'member';

  return {
    convKey: conv.key,
    summary,
    selfQq,
    message: {
      messageId: String(event.message_id ?? event.msg_id ?? ''),

      msgSeq: isGroup ? (event.message_seq ?? event.msg_seq) : undefined,

      tsMs: (Number(event.time) || Math.floor(Date.now() / 1000)) * 1000,

      sender: {

        qq: senderQq,
        name,
        groupRole,
      },

      segments,

      quote: summary.quote ? { id: summary.quote.id } : undefined,
    },
  };
}
export { deriveMsgType };
