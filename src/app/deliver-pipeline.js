import fs from 'node:fs';
import path from 'node:path';
import { ChatStore } from '../chatlog/store.js';
import { buildPrompt } from '../chatlog/prompt.js';
import { DEFAULT_OWNER_TITLE } from '../chatlog/role.js';

export function createStoreFor({ chatlogRoot, logger, selfQq, getConfig }) {

  const stores = new Map();
  const storeFor = (convKey) => {
    let s = stores.get(convKey);
    if (!s) {

      s = new ChatStore({
        root: chatlogRoot,
        convKey,
        logger,

        selfQq: selfQq || getConfig().snowluma.selfQq || '',
      }).init();
      stores.set(convKey, s);
    }
    return s;
  };

  return { storeFor, stores };
}

export function createRuntimeWriter({ root, selfQq, getConfig, logger }) {

  const runtimeFile = path.join(root, 'state', 'runtime.json');
  function writeRuntimeFile() {
    try {
      const payload = {
        selfQq: String(selfQq || getConfig().snowluma.selfQq || ''),
        updatedAt: new Date().toISOString(),
      };
      fs.mkdirSync(path.dirname(runtimeFile), { recursive: true });
      fs.writeFileSync(runtimeFile, JSON.stringify(payload, null, 2), 'utf8');
      return payload;
    } catch (error) {

      logger.warn('写 runtime.json 失败（提示词里的本号会填不上）', { error: String(error) });
      return null;
    }
  }

  return writeRuntimeFile;
}

export function createDeliverHandler({ deliverer, roleStore, writeRuntimeFile, logger, getConfig, getStream, getRegistry }) {

  return async function onDeliver(delivery, meta) {
    const token = deliverer.tokenFor(meta.key);

    const role = meta.injectRole === false
      ? { text: '', mode: 'skipped', name: roleStore.name, ownerTitle: '' }
      : roleStore.forPrompt();

    const ownerTitle = role.ownerTitle || DEFAULT_OWNER_TITLE;

    writeRuntimeFile();
    const prompt = buildPrompt({
      key: meta.key,
      token,
      role,
      delivery,
      label: meta.label,
      triggerBy: meta.triggerBy,
      woke: meta.woke,
      waiting: false,

      ownerTitle,

      ownerQq: getConfig().owner.qq,
      selfQq: delivery.selfQq ?? '',
    });

    const snap = getRegistry().get(meta.key);
    logger.info('投递', {
      conv: meta.key,
      trigger: meta.label,
      woke: meta.woke,
      lines: delivery.context.count,
      chars: prompt.length,
      unreadLeft: delivery.remainingUnread,
      agentRunning: snap?.agentRunning,
      activeWait: Boolean(snap?.activeWait),
      sleeping: snap?.sleeping,
      pooled: snap?.pooled,
      role: role.mode === 'role'
        ? `${role.name}(${role.chars}字)`
        : (role.mode === 'skipped' ? '(跳过·醒着接话)' : '(无)'),
      ownerTitle: role.ownerTitle ? `${ownerTitle}(人设声明)` : `${ownerTitle}(默认)`,
    });
    logger.debug('提示词全文', { prompt });

    try {
      const r = await deliverer.deliver(meta.key, prompt);
      logger.debug('投递完成', { conv: meta.key, sessionId: r.sessionId });

      getStream().follow(r.sessionId);
    } catch (error) {

      logger.error('投递失败', { conv: meta.key, error: String(error) });
      getRegistry().get(meta.key).sleep();
    }
  };
}
