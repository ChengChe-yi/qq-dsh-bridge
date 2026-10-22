import fs from 'node:fs';
import path from 'node:path';

import { ConfigError, defaultConfig, validateConfig } from './schema.js';

const ENV_PREFIX = 'QQBRIDGE_';

const ENV_TYPES = {
  baseurl: 'string',
  home: 'string',
  launchtoken: 'string',
  allowremote: 'boolean',
  requesttimeoutms: 'positiveInt',
  authrefreshskewms: 'nonNegativeInt',
  agentpreset: 'string',
  apiport: 'positiveInt',
  chatlogroot: 'string',
  wakelimit: 'positiveInt',
  replylimit: 'positiveInt',
  maxdays: 'positiveInt',
  maxchars: 'positiveInt',
  rolemaxchars: 'positiveInt',
  idlems: 'positiveInt',
  triggerwho: 'string',
  windowwho: 'string',
  waitrequiremention: 'boolean',
  waitdefaultms: 'positiveInt',
  waitmaxms: 'positiveInt',
  loglevel: 'string',
  logfile: 'string',
  ownerQq: 'string',
  allowprivate: 'csv',
  allowgroups: 'csv',
  allowallwhenempty: 'boolean',
  snowlumahttpurl: 'string',
  snowlumawsurl: 'string',
  snowlumahttptoken: 'string',
  snowlumawstoken: 'string',
  snowlumahomedir: 'string',
  selfQq: 'string',
  watch: 'boolean',

};

const ENV_PATHS = {
  baseurl: ['dsh', 'baseUrl'],
  home: ['dsh', 'home'],
  launchtoken: ['dsh', 'launchToken'],
  allowremote: ['dsh', 'allowRemote'],
  requesttimeoutms: ['dsh', 'requestTimeoutMs'],
  authrefreshskewms: ['dsh', 'authRefreshSkewMs'],
  agentpreset: ['dsh', 'agentPreset'],
  apiport: ['api', 'port'],
  chatlogroot: ['chatlog', 'root'],
  wakelimit: ['chatlog', 'wakeLimit'],
  replylimit: ['chatlog', 'replyLimit'],
  maxdays: ['chatlog', 'maxDays'],
  maxchars: ['chatlog', 'maxChars'],
  rolemaxchars: ['chatlog', 'roleMaxChars'],
  idlems: ['chatlog', 'idleMs'],
  triggerwho: ['chatlog', 'triggerWho'],
  windowwho: ['chatlog', 'windowWho'],
  waitrequiremention: ['chatlog', 'waitRequireMention'],
  waitdefaultms: ['chatlog', 'waitDefaultMs'],
  waitmaxms: ['chatlog', 'waitMaxMs'],
  loglevel: ['log', 'level'],
  logfile: ['log', 'file'],
  ownerqq: ['owner', 'qq'],
  allowprivate: ['allow', 'private'],
  allowgroups: ['allow', 'groups'],
  allowallwhenempty: ['allow', 'allowAllWhenEmpty'],
  snowlumahttpurl: ['snowluma', 'httpUrl'],
  snowlumawsurl: ['snowluma', 'wsUrl'],

  snowlumahttptoken: ['snowluma', 'accessToken'],
  snowlumawstoken: ['snowluma', 'wsToken'],
  snowlumahomedir: ['snowluma', 'homeDir'],
  selfqq: ['snowluma', 'selfQq'],
  watch: ['watch'],
};

export function readConfigFile(file) {
  if (!fs.existsSync(file)) return { found: false, value: {} };
  const raw = fs.readFileSync(file, 'utf8');
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(`配置文件不是合法 JSON：${error.message}`, {
      hint: `文件：${file}`,
    });
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigError('配置文件顶层必须是 JSON 对象', { hint: `文件：${file}` });
  }
  return { found: true, value };
}

export function deepMerge(base, patch) {
  if (patch === undefined) return base;
  if (Array.isArray(patch) || typeof patch !== 'object' || patch === null) return patch;
  const out = { ...(typeof base === 'object' && base !== null && !Array.isArray(base) ? base : {}) };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = deepMerge(out[k], v);
  }
  return out;
}

function coerce(raw, type, name) {
  switch (type) {
    case 'string':
      return raw;
    case 'boolean': {
      const v = raw.trim().toLowerCase();
      if (['1', 'true', 'yes', 'on'].includes(v)) return true;
      if (['0', 'false', 'no', 'off'].includes(v)) return false;
      throw new ConfigError(`环境变量 ${name} 不是合法的布尔值："${raw}"`, {
        hint: '可用：1/0、true/false、yes/no、on/off',
      });
    }
    case 'positiveInt': {
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) {
        throw new ConfigError(`环境变量 ${name} 必须是正整数，实际是 "${raw}"`);
      }
      return n;
    }
    case 'nonNegativeInt': {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0) {
        throw new ConfigError(`环境变量 ${name} 必须是非负整数，实际是 "${raw}"`);
      }
      return n;
    }
    case 'csv':

      return raw.trim() === ''
        ? []
        : raw.split(',').map((s) => s.trim()).filter((s) => s !== '');
    default:
      return raw;
  }
}

export function envOverrides(env = process.env) {
  const patch = {};
  const overrides = [];

  for (const [flat, type] of Object.entries(ENV_TYPES)) {
    const name = `${ENV_PREFIX}${flat.toUpperCase()}`;
    const raw = env[name];
    if (raw === undefined || raw === '') continue;

    const pathArr = ENV_PATHS[flat];
    if (!pathArr) continue;

    const value = coerce(raw, type, name);
    let node = patch;
    for (let i = 0; i < pathArr.length - 1; i += 1) {
      node[pathArr[i]] = node[pathArr[i]] ?? {};
      node = node[pathArr[i]];
    }
    node[pathArr[pathArr.length - 1]] = value;
    overrides.push(pathArr.join('.'));
  }

  return { patch, overrides };
}

export function argvOverrides(argv = []) {
  const patch = {};
  const overrides = [];
  const unknown = [];

  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq === -1) {

      continue;
    }
    const key = body.slice(0, eq).toLowerCase().replace(/[-_]/g, '');
    const raw = body.slice(eq + 1);

    const type = ENV_TYPES[key];
    const pathArr = ENV_PATHS[key];
    if (!type || !pathArr) {
      unknown.push(arg);
      continue;
    }

    const value = coerce(raw, type, arg);
    let node = patch;
    for (let i = 0; i < pathArr.length - 1; i += 1) {
      node[pathArr[i]] = node[pathArr[i]] ?? {};
      node = node[pathArr[i]];
    }
    node[pathArr[pathArr.length - 1]] = value;
    overrides.push(pathArr.join('.'));
  }

  return { patch, overrides, unknown };
}

export function loadConfig({
  root,
  configPath,
  argv = [],
  env = process.env,
  strict = true,
} = {}) {
  const file = configPath ?? path.join(root, 'config.json');

  const fromFile = readConfigFile(file);
  const fromEnv = envOverrides(env);
  const fromArgv = argvOverrides(argv);

  let merged = deepMerge(defaultConfig(), fromFile.value);
  merged = deepMerge(merged, fromEnv.patch);
  merged = deepMerge(merged, fromArgv.patch);

  const { ok, errors, warnings } = validateConfig(merged, { strict });

  const source = {
    file,
    fileFound: fromFile.found,
    envKeys: fromEnv.overrides,
    argvKeys: fromArgv.overrides,
  };

  return {
    ok,
    config: merged,
    errors,
    warnings,
    configPath: file,
    configFound: fromFile.found,
    source,
    envOverridden: fromEnv.overrides,
    argvOverridden: fromArgv.overrides,
    unknownArgs: fromArgv.unknown,
  };
}
