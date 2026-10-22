export const op = 'send';
export const needsAllow = true;
export const logsAsSend = true;

import { normalizeOutgoingBubble } from '../../onebot/normalize.js';
import { segmentsToText, textOf } from '../../chatlog/segments.js';
import { seqOf } from '../../chatlog/store.js';
import { loadStickers, findSticker, loadStickerBytes, bumpUse } from '../../chatlog/stickers.js';

export async function run({ poolFor, http, logger, stickerPath }, convKey, args) {
  const pool = poolFor(convKey);
  const isGroup = convKey.startsWith('group:');

  const dryRun = args?.dryRun === true;

  const resolveReply = async (seq) => {
    try {

      const id = pool.find(seq)?.message?.messageId;
      if (!id) logger.warn('引用失败：按 seq 找不到对应消息', { conv: convKey, seq });
      return id;
    } catch (error) {
      logger.warn('引用失败：查 seq 出错', { conv: convKey, seq, error: String(error) });
      return null;
    }
  };

  const resolveSticker = async (ref) => {
    const entries = loadStickers({ file: stickerPath });
    let entry;
    try {
      entry = findSticker(entries, ref);
    } catch (error) {
      if (error?.hint) throw new Error(`${error.message}\n${error.hint}`);
      throw error;
    }
    if (!entry) return null;
    const { buffer } = await loadStickerBytes(entry);
    if (!dryRun) bumpUse({ file: stickerPath, id: entry.id, context: convKey });
    return { base64: buffer.toString('base64'), desc: entry.desc || entry.id };
  };

  let planned;

  if (Array.isArray(args.messages) && args.messages.length) {
    planned = [];
    for (const [i, bubble] of args.messages.entries()) {
      const r = await normalizeOutgoingBubble(bubble, { resolveReply, resolveSticker });
      if (!r.ok) {

        throw new Error(`messages 第 ${i + 1} 条有误：${r.errors.join('；')}`);
      }
      planned.push({ segments: r.segments, label: textOf({ segments: r.segments }).slice(0, 60) });
    }
  } else {

    if (typeof args.text === 'string' && args.text.trim() !== '') {
      planned = [{
        segments: [{ type: 'text', data: { text: args.text } }],
        label: args.text.slice(0, 60),
      }];
    } else if (args.text !== undefined || args.segments !== undefined || args.replyTo !== undefined) {
      throw new Error(
        '旧的入参形态已停用。请改用 `messages`：\n'
        + '  · 一句： `{ "messages": [{ "text": "内容" }] }`\n'
        + '  · 带引用和 @： `{ "messages": [{ "reply": "296094", "at": "123456", "text": " 内容" }] }`\n'
        + '  · 多条： `{ "messages": [{ "text": "一" }, { "text": "二" }] }`',
      );
    }
  }

  if (!planned.length) {
    throw new Error('没有可发送的内容 —— 请给 `messages: [{ "text": "…" }]`');
  }

  const render = (one) => segmentsToText({ segments: one.segments }, { selfQq: pool.selfQq });

  if (dryRun) {
    return {
      dryRun: true,
      wouldSend: planned.length,
      messages: planned.map((one) => ({ segmentsText: render(one) })),
      note: '以上是**将要发出**的原文（一条都没发）。核对无误后，用同样的参数去掉 `dryRun` 再真发一次。',
    };
  }

  const sent = [];
  for (const [index, one] of planned.entries()) {
    const params = { message: one.segments, auto_escape: false };
    if (isGroup) params.group_id = Number(convKey.slice(6));
    else params.user_id = Number(convKey.slice(8));

    const action = isGroup ? 'send_group_msg' : 'send_private_msg';

    let data;
    try {
      data = await http.call(action, params);
    } catch (error) {

      logger.warn('发送失败（前面的气泡已发出）', {
        conv: convKey, index: index + 1, total: planned.length, error: String(error),
      });
      sent.push({ segmentsText: render(one), error: String(error?.message ?? error) });
      for (const rest of planned.slice(index + 1)) sent.push({ segmentsText: render(rest), notSent: true });
      break;
    }

    const messageId = String(data?.message_id ?? '');

    sent.push({ messageId, segmentsText: render(one) });
  }

  await fillSeqFromEcho(pool, sent);

  for (const s of sent) { if (!s.seq && s.messageId) s.seq = s.messageId; delete s.messageId; }

  const count = (k) => sent.filter((s) => Boolean(s[k])).length;
  return { sent: count('seq'), failed: count('error'), notSent: count('notSent'), messages: sent };

}

const ECHO_WAIT_MS = 800;

async function fillSeqFromEcho(pool, sent, { timeoutMs = ECHO_WAIT_MS } = {}) {
  const pending = sent.filter((s) => !s.seq && s.messageId);
  if (!pending.length) return;

  const take = () => {
    for (const s of pending) {
      if (s.seq) continue;
      const found = pool.findByMessageId(s.messageId);
      if (found) s.seq = seqOf(found.message, found.date);
    }
  };
  const allDone = () => pending.every((s) => s.seq);

  take();
  if (allDone()) return;
  await new Promise((resolve) => {
    let timer;
    let off = () => {};
    const finish = () => { clearTimeout(timer); off(); resolve(); };
    const onAppended = () => { take(); if (allDone()) finish(); };
    off = pool.onAppend(onAppended);
    timer = setTimeout(finish, timeoutMs);
    take();
    if (allDone()) finish();
  });
}
