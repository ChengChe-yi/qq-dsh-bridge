import { DshEventStream } from '../dsh/stream.js';
import { TurnTracker } from '../chatlog/turn.js';

export function wireTurnTracking({ dsh, logger, registry, sessionMap }) {
  const stream = new DshEventStream({ dsh, logger });

  const turnTracker = new TurnTracker({ logger });

  const convOf = (sessionId) => [...registry.conversations.values()].find(
    (c) => sessionMap.get(c.key) === sessionId,
  );

  const lastKnown = new Map();

  const setRunning = (conv, running, source) => {
    if (!conv) return;
    if (conv.agentRunning === running) return;
    logger.info('agent 状态（权威）', { conv: conv.key, agentRunning: running, source });
    conv.setAgentRunning(running, source);
  };

  const applyKnown = () => {
    for (const conv of registry.conversations.values()) {
      const sid = sessionMap.get(conv.key);
      if (!sid || !lastKnown.has(sid)) continue;
      setRunning(conv, lastKnown.get(sid) === true, 'cache');
    }
  };

  const reconcile = async (why) => {
    try {
      const res = await dsh.call('session/list', {});
      const items = res?.value?.items ?? [];
      for (const s of items) if (s?.sessionId) lastKnown.set(String(s.sessionId), s.running === true);
      applyKnown();
      logger.info('权威状态对账完成', {
        why, sessions: items.length, mapped: registry.conversations.size,
      });
    } catch (error) {
      logger.warn('权威状态对账失败（继续用推送）', { why, error: String(error) });
    }
  };

  stream.on('agent-status', ({ sessionId, running }) => {
    if (!sessionId) return;
    lastKnown.set(String(sessionId), running === true);
    setRunning(convOf(sessionId), running === true, 'status');
  });

  stream.on('agent-feed-ready', () => { void reconcile('feed-ready'); });

  stream.on('agent-activity', ({ sessionId, at }) => {
    logger.debug('会话活动', { sessionId, at, conv: convOf(sessionId)?.key });
  });

  stream.on('remote-event', ({ event, request }) => {
    const level = event === 'approval/request' ? 'warn' : 'debug';
    logger[level]('收到 remote event（已回 kind:next，决定权留给别的客户端）', {
      event,
      request: JSON.stringify(request ?? {}).slice(0, 300),
    });
  });

  stream.on('snapshot', ({ sessionId, snapshot }) => {
    logger.debug('收到会话开场快照（历史，不计入回合）', {
      sessionId,
      records: Array.isArray(snapshot?.records) ? snapshot.records.length : 0,
    });
    turnTracker.forget(sessionId);
    applyKnown();
  });

  stream.on('event', ({ sessionId, event }) => {
    applyKnown();
    turnTracker.handle({ type: event?.type, sessionId, event });
  });

  stream.on('stream-error', ({ sessionId, error }) => {
    logger.warn('会话事件流出错', { sessionId, code: error?.code, message: error?.message });
  });

  stream.on('stream-failed', ({ error }) => {
    logger.warn('事件流问题（会自动重试）', { error: String(error) });
  });

  turnTracker.on('turn-end', ({ sessionId, durationMs, toolCalls, orphan }) => {
    logger.debug('回合结束（仅统计）', {
      conv: convOf(sessionId)?.key, sessionId, durationMs, toolCalls, orphan,
    });
  });
  turnTracker.on('turn-start', ({ sessionId }) => {
    logger.debug('回合开始（仅统计）', { conv: convOf(sessionId)?.key, sessionId });
  });

  void stream.start().catch((error) => {
    logger.warn('事件流启动失败（将自动重试）', { error: String(error) });
  });

  return { stream, turnTracker };
}
