import { stateConfig } from '../config/state-view.js';
import { resolveSnowLumaEndpoints } from '../onebot/snowluma.js';

export function applyLiveConfig(deps, config, logger) {
  const { dsh, onebot, registry, allow } = deps;

  const missing = Object.entries({ dsh, onebot, registry, allow })
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length) throw new Error(`applyLiveConfig 缺少依赖：${missing.join(', ')}`);

  const { http, ws } = onebot;

  const next = stateConfig(config.chatlog);
  const cur = registry.config;

  for (const [k, v] of Object.entries(next)) {
    if (v && typeof v === 'object' && cur[k] && typeof cur[k] === 'object') {
      Object.assign(cur[k], v);
    } else {
      cur[k] = v;
    }
  }
  for (const conv of registry.conversations.values()) {

    conv.config = cur;
  }
  logger.debug('状态机配置已热更新', {
    windowWho: cur.window?.who,
    triggerWho: cur.trigger?.who,
    conversations: registry.conversations.size,
  });

  Object.assign(allow, {
    private: [...config.allow.private],
    groups: [...config.allow.groups],
    allowAllWhenEmpty: config.allow.allowAllWhenEmpty,
  });
  logger.debug('白名单已热更新（入站与出站同时生效）', {
    allowPrivate: allow.private.length,
    allowGroups: allow.groups.length,
    allowAllWhenEmpty: allow.allowAllWhenEmpty,
  });

  const prevOwner = String(registry.ownerQq ?? '');
  const nextOwner = String(config.owner.qq ?? '');
  if (prevOwner !== nextOwner) {
    registry.ownerQq = nextOwner;
    for (const conv of registry.conversations.values()) conv.ownerQq = nextOwner;
    logger.info('主人 QQ 已热更新（含已建会话）', {
      from: prevOwner, to: nextOwner, conversations: registry.conversations.size,
    });
  }

  const nextBase = String(config.dsh.baseUrl).replace(/\/+$/, '');
  if (nextBase !== dsh.baseUrl) {
    logger.info('DSH 地址变更，下次调用生效', { from: dsh.baseUrl, to: nextBase });
    dsh.baseUrl = nextBase;
    dsh.invalidateAuth();
  }
  dsh.requestTimeoutMs = config.dsh.requestTimeoutMs;
  dsh.authRefreshSkewMs = config.dsh.authRefreshSkewMs;
  dsh.allowRemote = config.dsh.allowRemote;

  const snow = config.snowluma;

  const ep = resolveSnowLumaEndpoints(config, logger);

  http.applyConfig({
    httpUrl: ep.http.url,
    accessToken: ep.http.token,
    timeoutMs: snow.actionTimeoutMs,
  });

  ws.applyConfig({
    wsUrl: ep.ws.url,
    accessToken: ep.ws.token,
    heartbeatMs: snow.heartbeatMs,
    heartbeatTimeoutMs: snow.heartbeatTimeoutMs,
    connectTimeoutMs: snow.connectTimeoutMs,
  });

  ws.reconnectMinMs = snow.reconnectMinMs;
  ws.reconnectMaxMs = snow.reconnectMaxMs;

  logger.info('OneBot 配置已应用', {
    httpUrl: ep.http.url,
    wsUrl: ep.ws.url,
    heartbeatMs: snow.heartbeatMs,
    tokenSource: ep.source,
  });
}
