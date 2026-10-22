import { ConfigError } from './schema.js';

export function reportConfigFailure(logger, error) {
  if (error instanceof ConfigError) {
    logger.error('配置无法加载，拒绝启动');
    logger.error(String(error));
    return;
  }
  logger.error('配置加载出现未预期错误', { error: error?.stack ?? String(error) });
}

export function logEffectiveConfig(logger, config, { onReload = false } = {}) {
  const summary = {
    dshBaseUrl: config.dsh.baseUrl,
    dshHome: config.dsh.home || '(默认 ~/.dsh)',
    dshAuth: config.dsh.launchToken ? 'launch-token' : '离线铸造 Cookie',
    snowlumaWs: config.snowluma.wsUrl,
    ownerQq: config.owner.qq || '(未设置)',
    allowPrivate: config.allow.private.length,
    allowGroups: config.allow.groups.length,
    allowAllWhenEmpty: config.allow.allowAllWhenEmpty,
    watch: config.watch.enabled,
    logLevel: config.log.level,
  };
  logger.info(onReload ? '生效配置（重载后）' : '生效配置', summary);

  if (config.allow.allowAllWhenEmpty && config.allow.private.length === 0 && config.allow.groups.length === 0) {
    logger.warn('高危：allowAllWhenEmpty=true 且 allow 列表为空 —— 会对所有人开放');
  }
}
