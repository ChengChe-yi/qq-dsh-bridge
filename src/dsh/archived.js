export async function fetchArchivedSessions({ dsh, logger, timeoutMs = 5000 } = {}) {
  let cookie;
  try {
    const c = await dsh.ensureAuth();
    cookie = `${c.name}=${c.value}`;
  } catch (error) {
    logger?.debug('归档查询：鉴权失败', { error: String(error) });
    return null;
  }

  const url = `${dsh.baseUrl.replace(/^http/, 'ws')}/api/remote.mux`;
  const WS = globalThis.WebSocket;

  return new Promise((resolve) => {
    let ws;
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      try { ws?.close?.(); } catch {  }
      resolve(value);
    };

    const timer = setTimeout(() => {
      logger?.debug('归档查询：超时');
      done(null);
    }, timeoutMs);
    timer.unref?.();

    try {
      ws = new WS(url, { headers: { cookie } });
    } catch (error) {
      clearTimeout(timer);
      logger?.debug('归档查询：连接失败', { error: String(error) });
      return done(null);
    }

    ws.addEventListener('open', () => {
      try {
        ws.send(JSON.stringify({
          type: 'open',
          streamId: 'archived-probe',
          endpoint: 'workspace/follow',

          payload: { args: {} },
        }));
      } catch (error) {
        clearTimeout(timer);
        done(null);
      }
    });

    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (msg.streamId !== 'archived-probe') return;

      if (msg.type === 'error') {
        clearTimeout(timer);
        logger?.debug('归档查询：流报错', { error: msg.error?.message });
        return done(null);
      }
      const v = msg.value?.value ?? msg.value;
      if (v?.archivedSessionIds) {
        clearTimeout(timer);
        return done(new Set(v.archivedSessionIds.map(String)));
      }
    });

    ws.addEventListener('error', () => { clearTimeout(timer); done(null); });
    ws.addEventListener('close', () => { clearTimeout(timer); done(null); });
  });
}
