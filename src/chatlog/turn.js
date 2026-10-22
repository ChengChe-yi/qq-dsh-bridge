import { EventEmitter } from 'node:events';

export const TURN_START = 'turn/start';
export const TURN_END = 'turn/end';

export class TurnTracker extends EventEmitter {
  constructor({ logger } = {}) {
    super();
    this.logger = logger;

    this.turns = new Map();
  }

  handle(frame) {
    const type = frame?.type ?? frame?.event?.type;
    const sessionId = frame?.sessionId ?? frame?.session?.id ?? frame?.event?.sessionId;
    if (!type || !sessionId) return null;

    if (type === TURN_START) {
      this.turns.set(sessionId, { startedAt: Date.now(), toolCalls: 0, sentText: false });

      this.emit('turn-start', { sessionId });
      return { kind: 'turn-start', sessionId };
    }

    if (type === TURN_END) {

      const state = this.turns.get(sessionId) ?? null;
      this.turns.delete(sessionId);
      const now = Date.now();
      const info = state
        ? { ...state, endedAt: now, durationMs: now - state.startedAt }
        : { startedAt: null, endedAt: now, durationMs: null, toolCalls: 0, sentText: false, orphan: true };
      this.emit('turn-end', { sessionId, ...info });
      return { kind: 'turn-end', sessionId, info };
    }

    const st = this.turns.get(sessionId);
    if (st && isToolCall(frame)) st.toolCalls += 1;
    return null;
  }

  forget(sessionId) {
    this.turns.delete(sessionId);
  }

  forgetAll() {
    this.turns.clear();
  }

  snapshot() {
    return [...this.turns.entries()].map(([sessionId, s]) => ({ sessionId, ...s }));
  }
}

function isToolCall(frame) {
  const t = frame?.type ?? frame?.event?.type;
  return typeof t === 'string' && t.startsWith('tool/');
}
