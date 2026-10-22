import { normalizeEvent, isConvAllowed } from './normalize.js';
import { textOf } from '../chatlog/segments.js';
import { KINDS } from '../chatlog/pool.js';
import { persistMessage } from '../chatlog/intake.js';

export function classifyEvent(event) {
  const post = event?.post_type;

  if (post === 'meta_event') return 'meta';

  if (post === 'message' || post === 'message_sent') return 'message';

  if (post === 'notice') {

    const nt = event.notice_type;
    if (nt === 'group_recall' || nt === 'friend_recall') return 'recall';

    if (nt === 'group_msg_emoji_like') return 'reaction';

    if (nt === 'notify' && event.sub_type === 'poke') return 'poke';
    return 'notice';
  }

  return 'unknown';
}

export function attachOneBotEvents(ws, deps) {
  const { logger } = deps;

  ws.on('open', () => logger.info('OneBot 事件通道就绪'));

  ws.on('upstream-health', ({ good, online }) => {
    logger[good ? 'info' : 'warn']('SnowLuma 上游状态', { good, online });
  });

  ws.on('heartbeat-timeout', () => {
    logger.warn('心跳超时：连接判定已死，正在重连（SnowLuma 不重放掉线期间的消息）');
  });

  ws.on('reconnect-scheduled', ({ reason, attempt, delayMs }) => {
    logger.info('OneBot 重连排期', { reason, attempt, delayMs });
  });

  ws.on('malformed', ({ error }) => {
    logger.warn('收到无法解析的 OneBot 帧', { error: String(error) });
  });

  ws.on('event', (event) => {
    switch (classifyEvent(event)) {
      case 'meta':
        logger.debug('meta_event', { type: event.meta_event_type, sub: event.sub_type });
        return;

      case 'recall':
        void handleRecall(event, deps);
        return;

      case 'reaction':
        void handleReaction(event, deps);
        return;

      case 'poke':
        void handlePoke(event, deps);
        return;

      case 'message':
        void handleMessage(event, deps);
        return;

      default:

        logger.debug('非消息事件', {
          post_type: event?.post_type,
          notice_type: event?.notice_type ?? '',
          sub_type: event?.sub_type ?? event?.request_type ?? '',
        });
    }
  });
}

async function handleMessage(event, deps) {
  const {
    registry, allow, logger,
  } = deps;

  let normalized;
  try {

    normalized = normalizeEvent(event);
  } catch (error) {
    logger.warn('消息事件解析失败', {
      error: String(error),
      raw: JSON.stringify(event).slice(0, 300),
    });
    return;
  }
  if (!normalized) return;

  if (!isConvAllowed(normalized.convKey, allow)) {
    logger.debug('会话不在白名单内，完全忽略', {
      conv: normalized.convKey,
      sender: normalized.message.sender?.name,
      text: textOf(normalized.message).slice(0, 40),
    });
    return;
  }

  try {

    const message = {
      ...normalized.message,
      event,
      atSelf: normalized.summary.atSelf,
      quote: normalized.summary.quote,
    };
    const conv = registry.conversationFor(normalized.convKey);
    const { stored, selfSent } = persistMessage(conv.store, message);
    const r = await conv.accept(stored, message, { selfSent });

    if (r.action === 'buffered') {

      const atOthers = (normalized.message.segments ?? [])
        .filter((s) => s?.type === 'at')
        .map((s) => String(s.data?.qq ?? ''))
        .filter((q) => q !== '' && q !== normalized.selfQq);
      let hint = '';
      if (r.reason === 'not-triggered') {
        if (atOthers.length) {
          hint = `这条 @ 的是别人（${atOthers.join(',')}），不是本号；要叫它请从 @ 候选列表里选它`;
        } else if (!normalized.summary.atSelf && /^\s*@/.test(normalized.summary.text ?? '')) {
          hint = '正文以 @ 开头，但那只是手打的纯文本（QQ 不当作提及）；请从 @ 候选列表里选中它';
        } else {
          hint = '没有 @ 它也没有引用它';
        }
      }
      logger.debug('已入缓冲（未投递）', {
        conv: normalized.convKey,
        why: r.reason,
        seq: r.seq,
        hint: hint || undefined,
      });
    }
  } catch (error) {

    logger.error('处理消息事件出错', { conv: normalized.convKey, error: String(error) });
  }
}

export async function handleRecall(event, deps) {
  const { registry, logger } = deps;

  const isGroup = event.notice_type === 'group_recall';
  const key = isGroup ? `group:${event.group_id}` : `private:${event.user_id}`;

  const conv = registry.conversations.get(key);
  if (!conv) {
    logger.debug('撤回：该会话还没建立，无法标记', { conv: key, msgId: event.message_id });
    return;
  }

  const atMs = (Number(event.time) || 0) * 1000;

  let operatorQq = '';
  if (isGroup) {
    operatorQq = String(event.operator_id ?? '');
    if (operatorQq === '') {
      logger.warn('群撤回通知没有 operator_id，撤回者未知', { conv: key, msgId: event.message_id });
    }
  } else {
    operatorQq = String(conv.store.findByMessageId(event.message_id)?.message?.sender?.qq ?? '');
    if (operatorQq === '') {
      logger.debug('私聊撤回：本地查不到原消息，撤回者未知', { conv: key, msgId: event.message_id });
    }
  }

  const r = conv.store.recall(event.message_id, {
    sender: operatorQq ? { qq: operatorQq } : undefined,
    atMs: atMs || undefined,
  });

  if (r.found) {
    conv.store.flush(r.date);
    logger.info('撤回已标记', {
      conv: key, msgId: event.message_id, date: r.date, by: operatorQq || '(未知)', at: atMs || '(事件没带时间)',
    });
  } else {

    logger.info('撤回但本地无原文（不写记录）', {
      conv: key, msgId: event.message_id, by: operatorQq || '(未知)',
    });
  }

  conv.turnPool?.addEvent({
    kind: KINDS.RECALL,
    subject: { messageId: String(event.message_id ?? '') },
    actor: operatorQq,
    author: String(event.user_id ?? ''),
    tsMs: atMs || undefined,
  });
}

export async function handleReaction(event, deps) {
  const { registry, logger } = deps;
  const key = `group:${event.group_id}`;

  const conv = registry.conversations.get(key);
  if (!conv) {
    logger.debug('表情回应：该会话还没建立，忽略', { conv: key, msgId: event.message_id });
    return;
  }

  const likes = Array.isArray(event.likes) ? event.likes : [];
  const first = likes[0] ?? {};
  const emoji = String(first.emoji_id ?? '');

  if (emoji === '') {
    logger.warn('表情回应没有 emoji_id，形状与预期不符，已忽略', {
      conv: key, msgId: event.message_id, raw: JSON.stringify(event).slice(0, 300),
    });
    return;
  }

  conv.turnPool?.addEvent({
    kind: KINDS.REACTION,
    subject: { messageId: String(event.message_id ?? '') },
    actor: String(event.operator_id ?? event.user_id ?? ''),
    emoji,

    isAdd: event.sub_type === 'add' ? true : event.sub_type === 'remove' ? false : undefined,
    tsMs: (Number(event.time) || 0) * 1000 || undefined,

    payload: { count: first.count, messageSeq: event.message_seq },
  });

  logger.info('表情回应入池', {
    conv: key, msgId: event.message_id, emoji,
    by: event.operator_id ?? event.user_id ?? '(未知)',
    act: event.sub_type ?? '?',
  });
}

export async function handlePoke(event, deps) {
  const { registry, logger } = deps;
  const isGroup = event.group_id !== undefined;
  const key = isGroup ? `group:${event.group_id}` : `private:${event.user_id}`;

  const conv = registry.conversations.get(key);
  if (!conv) {
    logger.debug('戳一戳：该会话还没建立，忽略', { conv: key, target: event.target_id });
    return;
  }

  const actor = String(event.sender_id ?? event.user_id ?? '');
  const target = String(event.target_id ?? '');
  const selfQq = String(conv.store.selfQq ?? '');

  conv.turnPool?.addEvent({
    kind: KINDS.POKE,
    actor,
    target,
    tsMs: (Number(event.time) || 0) * 1000 || undefined,

    payload: { action: event.action, suffix: event.suffix },
  });

  logger.info('戳一戳入池', {
    conv: key, by: actor || '(未知)', to: target || '(未知)',
    toSelf: target === selfQq && selfQq !== '' ? 'yes' : 'no',
  });
}
