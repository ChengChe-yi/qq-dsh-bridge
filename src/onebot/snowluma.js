import fs from 'node:fs';
import path from 'node:path';

export class SnowLumaDiscoveryError extends Error {
  constructor(message, { hint = '' } = {}) {
    super(message);
    this.name = 'SnowLumaDiscoveryError';
    this.hint = hint;
  }
  toString() {
    return this.hint ? `${this.name}: ${this.message}\n  ${this.hint}` : `${this.name}: ${this.message}`;
  }
}

export function readSnowLumaConnection(homeDir, uin) {
  if (!homeDir) {
    throw new SnowLumaDiscoveryError('未提供 SnowLuma 安装目录');
  }
  const configDir = path.join(homeDir, 'config');
  if (!fs.existsSync(configDir)) {
    throw new SnowLumaDiscoveryError(
      `SnowLuma 配置目录不存在：${configDir}`,
      { hint: '确认 snowluma.homeDir 指向真正的 SnowLuma 安装目录（该目录下应有 config/ 与 launcher.bat）。' },
    );
  }

  const file = resolveOneBotConfigFile(configDir, uin);
  if (!file) {
    throw new SnowLumaDiscoveryError(
      `${configDir} 下找不到 onebot_<QQ号>.json`,
      { hint: 'SnowLuma 至少成功连接过一次 QQ 才会写出该文件。' },
    );
  }

  const raw = fs.readFileSync(file, 'utf8');

  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new SnowLumaDiscoveryError(`解析 ${file} 失败：${error.message}`);
  }

  const selfQq = extractUinFromFilename(path.basename(file));
  const httpServer = parsed?.networks?.httpServers?.[0];
  const wsServer = parsed?.networks?.wsServers?.[0];

  if (!httpServer && !wsServer) {
    throw new SnowLumaDiscoveryError(
      `${file} 里既没有 httpServers 也没有 wsServers`,
      { hint: '请在 SnowLuma WebUI 里至少启用一个 HTTP 与一个 WS 服务端。' },
    );
  }

  return {
    selfQq,
    configFile: file,
    http: httpServer
      ? {
        url: `http://${hostOf(httpServer.host)}:${httpServer.port}`,
        token: String(httpServer.accessToken ?? ''),
        name: String(httpServer.name ?? ''),
      }
      : null,
    ws: wsServer
      ? {
        url: `ws://${hostOf(wsServer.host)}:${wsServer.port}`,
        token: String(wsServer.accessToken ?? ''),
        name: String(wsServer.name ?? ''),
      }
      : null,
  };
}

function resolveOneBotConfigFile(configDir, uin) {
  let entries;
  try {
    entries = fs.readdirSync(configDir);
  } catch {
    return null;
  }
  const candidates = entries.filter((n) => /^onebot_\d+\.json$/.test(n));

  if (uin !== undefined && uin !== null && String(uin) !== '') {
    const exact = `onebot_${uin}.json`;
    return candidates.includes(exact) ? path.join(configDir, exact) : null;
  }
  if (candidates.length === 1) return path.join(configDir, candidates[0]);
  if (candidates.length === 0) return null;
  return null;
}

function extractUinFromFilename(name) {
  const m = /^onebot_(\d+)\.json$/.exec(name);
  return m ? Number(m[1]) : 0;
}

function hostOf(host) {
  const h = String(host ?? '').trim();
  if (h === '' || h === '0.0.0.0' || h === '::' || h === '[::]') return '127.0.0.1';
  return h;
}

export function resolveSnowLumaEndpoints(config, logger) {
  const snow = config.snowluma ?? {};
  const result = {
    http: { url: snow.httpUrl ?? 'http://127.0.0.1:3000', token: snow.accessToken ?? '' },
    ws: { url: snow.wsUrl ?? 'ws://127.0.0.1:3001', token: snow.accessToken ?? '' },
    selfQq: snow.selfQq ?? 0,
    source: 'config',
  };

  if (!snow.homeDir) return result;

  try {
    const discovered = readSnowLumaConnection(snow.homeDir, snow.selfQq || undefined);

    if (discovered.http) {
      if (!snow.httpUrl) result.http.url = discovered.http.url;
      if (!snow.accessToken) result.http.token = discovered.http.token;
    }
    if (discovered.ws && !snow.wsUrl) result.ws.url = discovered.ws.url;

    if (snow.wsToken) {
      result.ws.token = snow.wsToken;
    } else if (discovered.ws) {
      result.ws.token = discovered.ws.token;
    }

    if (!result.selfQq) result.selfQq = discovered.selfQq;
    result.source = 'discovered';
    result.configFile = discovered.configFile;

    if (discovered.http && discovered.ws && discovered.http.token !== discovered.ws.token) {
      logger?.debug('已分别取得 HTTP token 与 WS token（两者通常不同）', {
        selfQq: discovered.selfQq,
      });
    }
  } catch (error) {

    logger?.warn('从 SnowLuma 安装目录自动发现连接信息失败，改用配置中的值', {
      homeDir: snow.homeDir,
      error: String(error),
    });
  }

  return result;
}
