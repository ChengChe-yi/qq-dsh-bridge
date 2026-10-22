#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigStore } from './config/store.js';
import { reportConfigFailure, logEffectiveConfig } from './config/report.js';
import { stateConfig } from './config/state-view.js';
import { Logger } from './util/logger.js';
import { probeDsh, probeOneBotHttp } from './app/probe.js';
import { wireTurnTracking } from './app/wire-stream.js';
import { installShutdown } from './app/shutdown.js';
import { applyLiveConfig } from './app/live-config.js';
import { createStoreFor, createRuntimeWriter, createDeliverHandler } from './app/deliver-pipeline.js';
import { DshClient } from './dsh/client.js';
import { fetchArchivedSessions } from './dsh/archived.js';
import { OneBotHttpClient } from './onebot/http.js';
import { OneBotWsClient } from './onebot/ws.js';
import { resolveSnowLumaEndpoints } from './onebot/snowluma.js';
import { attachOneBotEvents } from './onebot/dispatch.js';
import { dirNameOf } from './chatlog/store.js';
import { ConversationRegistry } from './chatlog/state.js';
import { RoleStore } from './chatlog/role.js';
import { createJudge } from './chatlog/judge.js';
import { createDecideLog } from './chatlog/decide-log.js';
import { SessionMap, DshDeliverer } from './chatlog/adapter.js';
import { syncWorkspaces, ensureWorkspace, defaultTitle } from './dsh/workspace-sync.js';
import { BridgeApi, startBridgeApiServer } from './api/server.js';
import { buildHandlers } from './api/handlers/index.js';
import { acquireLock } from './util/lock.js';
import { stickerFile } from './chatlog/stickers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function main() {

  const argv = process.argv.slice(2);
  const checkOnly = argv.includes('--check');
  const bootLogger = new Logger({ level: 'info' });
  const store = new ConfigStore({ root: ROOT, argv, strict: true });

  let initial;
  try {
    initial = store.loadInitial();
  } catch (error) {
    reportConfigFailure(bootLogger, error);
    await bootLogger.close();
    process.exitCode = 2;
    return;
  }

  if (!initial.ok) {
    bootLogger.error('配置校验未通过，拒绝启动');
    for (const err of initial.errors) bootLogger.error(String(err));
    await bootLogger.close();
    process.exitCode = 2;
    return;
  }

  const bootConfig = initial.config;

  const logger = Logger.fromConfig(bootConfig);

  let lock = null;
  if (!checkOnly) {
    try {
      lock = acquireLock({ file: path.join(ROOT, 'state', 'bridge.lock') });
      logger.debug('已获得单实例锁', { pid: lock.pid });
    } catch (error) {
      logger.error('拒绝启动：' + String(error));
      await logger.close();
      process.exitCode = 3;
      return;
    }
  }

  logger.info('qq-dsh-bridge 启动', {
    root: ROOT,
    config: store.configPath,
    configFound: initial.source.fileFound,
  });

  if (!initial.source.fileFound) {
    logger.warn('未找到 config.json，正在使用内置默认值', {
      expected: store.configPath,
      hint: '如需自定义，把默认配置写进该文件即可；保存后会自动热重载。',
    });
  }

  logEffectiveConfig(logger, bootConfig);
  for (const key of initial.envOverridden ?? []) {
    logger.warn('该配置项被环境变量覆盖（优先于 config.json）', { key });
  }
  for (const key of initial.argvOverridden ?? []) {
    logger.warn('该配置项被命令行覆盖', { key });
  }

  if (checkOnly) {
    logger.info('--check：配置校验通过，退出');
    await logger.close();
    return;
  }

  const dsh = new DshClient({
    baseUrl: bootConfig.dsh.baseUrl,
    home: bootConfig.dsh.home,
    launchToken: bootConfig.dsh.launchToken,
    allowRemote: bootConfig.dsh.allowRemote,
    requestTimeoutMs: bootConfig.dsh.requestTimeoutMs,
    authRefreshSkewMs: bootConfig.dsh.authRefreshSkewMs,
    logger,
  });

  const reachable = await probeDsh(dsh, logger);

  if (!reachable) {
    logger.warn('DSH 目前不可达；桥接会保持运行，配置变更仍会热重载', {
      baseUrl: bootConfig.dsh.baseUrl,
      hint: '启动 dsh web 后无需重启本进程——鉴权是每次调用时按需完成的。',
    });
  }

  const endpoints = resolveSnowLumaEndpoints(bootConfig, logger);

  const http = new OneBotHttpClient({
    httpUrl: endpoints.http.url,
    accessToken: endpoints.http.token,
    timeoutMs: bootConfig.snowluma.actionTimeoutMs,
    logger,
  });

  const ws = new OneBotWsClient({
    wsUrl: endpoints.ws.url,
    accessToken: endpoints.ws.token,
    heartbeatMs: bootConfig.snowluma.heartbeatMs,
    heartbeatTimeoutMs: bootConfig.snowluma.heartbeatTimeoutMs,
    connectTimeoutMs: bootConfig.snowluma.connectTimeoutMs,
    reconnect: {
      minDelayMs: bootConfig.snowluma.reconnectMinMs,
      maxDelayMs: bootConfig.snowluma.reconnectMaxMs,
    },
    logger,
  });

  const chatlogRoot = path.isAbsolute(bootConfig.chatlog.root)
    ? bootConfig.chatlog.root
    : path.join(ROOT, bootConfig.chatlog.root);

  const { storeFor, stores } = createStoreFor({
    chatlogRoot,
    logger,
    selfQq: endpoints.selfQq,
    getConfig: () => store.get(),
  });

  const roleStore = new RoleStore({
    dir: path.join(ROOT, 'roles'),
    stateFile: path.join(ROOT, 'state', 'current-role.json'),
    maxChars: bootConfig.chatlog.roleMaxChars,
    logger,
  });

  const sessionMap = new SessionMap({
    file: path.join(ROOT, 'state', 'sessions.json'),
    logger,

    getRole: () => roleStore.name,
  }).attach({ fs, path });

  const convDir = (convKey) => path.join(chatlogRoot, dirNameOf(convKey));

  const deliverer = new DshDeliverer({
    dsh,
    sessionMap,
    logger,

    cwdFor: convDir,

    workspaceFor: async (convKey, cwd) => {
      const id = await ensureWorkspace({ dsh, path: cwd, title: titleForConv(convKey), logger });
      return id;
    },

    archivedProbe: () => fetchArchivedSessions({ dsh, logger }),
    agentPreset: bootConfig.dsh.agentPreset,
  });

  function titleForConv(convKey) {
    try {
      const readme = path.join(convDir(convKey), 'README.md');
      if (fs.existsSync(readme)) {
        const first = fs.readFileSync(readme, 'utf8').split('\n')[0].trim();
        const m = /^#\s*(.+)$/.exec(first);
        if (m) return m[1].trim();
      }
    } catch {  }
    return defaultTitle(convKey);
  }

  const ensureWorkspaces = async (convKeys) => {
    const paths = convKeys.map((key) => {
      const dir = convDir(key);
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (error) {
        logger.warn('创建会话目录失败（注册 workspace 会跟着失败）', { dir, error: String(error) });
      }
      return { path: dir, title: titleForConv(key) };
    });
    const r = await syncWorkspaces({ dsh, paths, logger });
    return r;
  };

  const writeRuntimeFile = createRuntimeWriter({
    root: ROOT,
    selfQq: endpoints.selfQq,
    getConfig: () => store.get(),
    logger,
  });

  const knownConvs = new Set([
    ...sessionMap.keys(),
    ...bootConfig.allow.groups.map((id) => `group:${id}`),
    ...bootConfig.allow.private.map((id) => `private:${id}`),
  ]);
  void ensureWorkspaces([...knownConvs])
    .then((r) => {
      if (r.created.length || r.failed.length) {
        logger.info('workspace 登记完成', {
          created: r.created.length,
          existing: r.existing.length,
          failed: r.failed.length,
        });
      }
    })

    .catch((error) => logger.warn('workspace 登记失败（不影响启动）', { error: String(error) }));

  const registry = new ConversationRegistry({
    ownerQq: bootConfig.owner.qq,
    config: stateConfig(bootConfig.chatlog),
    storeFor,
    logger,

    judge: createJudge({
      getConfig: () => store.get(),
      getRoleName: () => roleStore.name,
      logger,
      cardPath: () => (roleStore.name ? path.join(roleStore.dir, `${roleStore.name}.md`) : ''),
    }),
    decideLog: createDecideLog({ file: path.join(ROOT, 'logs', 'decide.jsonl'), logger }),

    onConversationCreated: (convKey) => {
      void ensureWorkspaces([convKey]).catch((error) => {
        logger.debug('新会话的 workspace 登记失败', { conv: convKey, error: String(error) });
      });
    },

    onDeliver: createDeliverHandler({
      deliverer,
      roleStore,
      writeRuntimeFile,
      logger,
      getConfig: () => store.get(),
      getStream: () => stream,
      getRegistry: () => registry,
    }),
  });

  const poolFor = (convKey) => registry.conversationFor(convKey).turnPool;

  const { stream } = wireTurnTracking({ dsh, logger, registry, sessionMap });

  {

    const known = sessionMap.activeEntries();
    for (const [, sessionId] of known) stream.follow(sessionId);
    if (known.length) {
      logger.info('已重订阅上次运行的会话（避免重启后漏掉 turn/start）', {
        role: roleStore.name || '(未启用)',
        count: known.length,
        convs: known.map(([k]) => k).join(', '),
      });
    }

    void deliverer.renameKnown()
      .then((n) => {
        if (n) logger.info('已同步会话标题', { role: roleStore.name || '(未启用)', count: n });
      })
      .catch((error) => logger.debug('同步会话标题失败（不影响运行）', { error: String(error) }));
  }

  const imageBaseUrl = `http://127.0.0.1:${bootConfig.api.port}`;

  const allowView = {
    private: [...bootConfig.allow.private],
    groups: [...bootConfig.allow.groups],
    allowAllWhenEmpty: bootConfig.allow.allowAllWhenEmpty,
  };

  const bridgeApi = new BridgeApi({
    storeFor,
    tokensFor: (key) => (registry.conversations.has(key) ? deliverer.tokenFor(key) : null),
    allow: allowView,
    logger,
  });

  bridgeApi.registerHandlers(buildHandlers({
    poolFor,
    http,
    logger,
    registry,
    stickerPath: stickerFile(ROOT),
    imageBaseUrl,
    apiPort: bootConfig.api.port,
  }));

  try {
    await startBridgeApiServer({
      api: bridgeApi,
      port: bootConfig.api.port,
      logger,
      imageBaseUrl,
    });
  } catch (error) {
    logger.error('工具面 API 启动失败（工具将不可用）', { error: String(error) });
  }

  attachOneBotEvents(ws, {
    registry,

    allow: allowView,

    logger,
  });

  logger.info('OneBot 目标', {
    source: endpoints.source,
    httpUrl: endpoints.http.url,
    wsUrl: endpoints.ws.url,
    selfQq: endpoints.selfQq || '(未设置)',
    httpToken: endpoints.http.token ? '已配置' : '缺失',
    wsToken: endpoints.ws.token ? '已配置' : '缺失',
  });

  logger.info('聊天记录工作区', {
    root: chatlogRoot,
    wakeLimit: bootConfig.chatlog.wakeLimit,
    replyLimit: bootConfig.chatlog.replyLimit,
    triggerWho: bootConfig.chatlog.triggerWho,
    windowWho: bootConfig.chatlog.windowWho,
  });

  ws.connect();

  void probeOneBotHttp(http, logger);

  installShutdown({ logger, store, ws, stream, stores, lock });

  store.on('change', ({ config, reason }) => {

    try {
      logger.info('配置已热重载', { reason, revision: store.revision });
      logger.applyConfig(config);
      logEffectiveConfig(logger, config, { onReload: true });
      applyLiveConfig({ dsh, onebot: { http, ws }, registry, allow: allowView }, config, logger);
    } catch (error) {
      logger.error('应用热重载配置失败（可能只应用了一部分；下次保存会重跑全部小节）', {
        reason,
        error: error?.stack ?? String(error),
      });
    }
  });

  store.on('error', (errorOrErrors, meta = {}) => {
    const list = Array.isArray(errorOrErrors) ? errorOrErrors : [errorOrErrors];
    logger.error('配置重载失败，继续使用上一份可用配置', { reason: meta.reason });
    for (const err of list) logger.error(String(err));
  });

  store.on('watch-started', ({ dir, target }) => logger.info('已开始监听配置变更', { dir, target }));
  store.on('watch-disabled', () => logger.warn('配置热重载已关闭（watch.enabled=false）'));

  store.startWatching();

  store.reload({ reason: 'post-boot' });

  logger.info('就绪。等 QQ 消息触发投递。');
}

main().catch((error) => {
  process.stderr.write(`致命错误：${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
