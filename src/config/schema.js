export const CONFIG_VERSION = 1;

export function defaultConfig() {
  return {
    configVersion: CONFIG_VERSION,

    dsh: {

      baseUrl: 'http://127.0.0.1:3080',

      home: '',

      launchToken: '',

      allowRemote: false,

      requestTimeoutMs: 30_000,

      authRefreshSkewMs: 300_000,

      agentPreset: 'qq',
    },

    snowluma: {
      wsUrl: 'ws://127.0.0.1:3001',
      httpUrl: 'http://127.0.0.1:3000',

      accessToken: '',

      wsToken: '',

      homeDir: '',

      selfQq: '',

      expectSelfMessages: true,

      heartbeatMs: 45_000,
      heartbeatTimeoutMs: 12_000,

      connectTimeoutMs: 20_000,

      reconnectMinMs: 1000,
      reconnectMaxMs: 30_000,

      actionTimeoutMs: 30_000,
    },

    owner: {

      qq: '',
    },

    allow: {
      private: [],
      groups: [],
      allowAllWhenEmpty: false,
    },

    watch: {
      enabled: true,
      debounceMs: 250,
    },

    api: {
      port: 3110,
    },

    chatlog: {

      root: 'workspaces',

      wakeLimit: 60,

      replyLimit: 20,

      maxDays: 7,

      maxChars: 4000,

      roleMaxChars: 12000,

      idleMs: 300_000,

      triggerWho: 'owner',

      windowWho: 'owner',

      waitDefaultMs: 300_000,

      waitMaxMs: 1_800_000,

      waitRequireMention: true,

    },

    log: {
      level: 'info',

      file: '',

      maxBytes: 8 * 1024 * 1024,
      maxFiles: 5,
    },

    decide: {
      mode: 'off',

      model: 'cn:deepseek-v4.1-flash',
      apiBase: 'http://127.0.0.1:7863/v1',

      apiKey: '',

      apiKeyFile: '',
      apiKeyRef: 'WB2API_KEY',

      timeoutMs: 3000,

      maxTokens: 900,

      maxRecentLines: 8,

      thinking: 'off',

      cardSections: [],

      cardMaxChars: 3000,

      capabilities: '',

      ownerAlways: true,
    },
  };
}

export function deepMerge(base, patch) {
  if (patch === undefined) return base;
  if (!isPlainObject(patch)) return patch;
  if (!isPlainObject(base)) return { ...patch };
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = key in base ? deepMerge(base[key], value) : value;
  }
  return out;
}

export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class ConfigError extends Error {
  constructor(message, { path = '', hint = '' } = {}) {
    super(message);
    this.name = 'ConfigError';
    this.path = path;
    this.hint = hint;
  }
  toString() {
    const at = this.path ? `（位于 ${this.path}）` : '';
    const hint = this.hint ? `\n  ${this.hint}` : '';
    return `${this.name}: ${this.message}${at}${hint}`;
  }
}

const SCHEMA = {
  configVersion: 'number',
  dsh: {
    baseUrl: 'string',
    home: 'string',
    launchToken: 'string',
    allowRemote: 'boolean',
    requestTimeoutMs: 'positiveInt',
    authRefreshSkewMs: 'nonNegativeInt',
    agentPreset: 'string',
  },
  snowluma: {
    wsUrl: 'string',
    httpUrl: 'string',
    accessToken: 'string',
    wsToken: 'string',
    homeDir: 'string',
    selfQq: 'qqString',
    expectSelfMessages: 'boolean',
    heartbeatMs: 'positiveInt',
    heartbeatTimeoutMs: 'positiveInt',
    connectTimeoutMs: 'positiveInt',
    reconnectMinMs: 'nonNegativeInt',
    reconnectMaxMs: 'nonNegativeInt',
    actionTimeoutMs: 'positiveInt',
  },
  owner: {
    qq: 'qqString',
  },
  allow: {
    private: 'intList',
    groups: 'intList',
    allowAllWhenEmpty: 'boolean',
  },
  watch: {
    enabled: 'boolean',
    debounceMs: 'nonNegativeInt',
  },
  api: {
    port: 'positiveInt',
  },
  chatlog: {
    root: 'string',
    wakeLimit: 'positiveInt',
    replyLimit: 'positiveInt',
    maxDays: 'positiveInt',
    maxChars: 'positiveInt',
    roleMaxChars: 'positiveInt',
    idleMs: 'positiveInt',
    triggerWho: 'string',
    windowWho: 'string',
    waitRequireMention: 'boolean',
    waitDefaultMs: 'positiveInt',
    waitMaxMs: 'positiveInt',
  },
  log: {
    level: 'string',
    file: 'string',
    maxBytes: 'positiveInt',
    maxFiles: 'positiveInt',
  },
  decide: {
    mode: 'string',
    model: 'string',
    apiBase: 'string',
    apiKey: 'string',
    apiKeyFile: 'string',
    apiKeyRef: 'string',
    timeoutMs: 'positiveInt',
    maxTokens: 'positiveInt',
    maxRecentLines: 'positiveInt',
    cardSections: 'stringList',
    cardMaxChars: 'positiveInt',
    capabilities: 'string',
    thinking: 'string',
    ownerAlways: 'boolean',
  },
};

function checkType(value, kind) {
  switch (kind) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'positiveInt':
      return Number.isSafeInteger(value) && value > 0;
    case 'nonNegativeInt':
      return Number.isSafeInteger(value) && value >= 0;
    case 'string':
      return typeof value === 'string';

    case 'qqString':
      return typeof value === 'string' && (value === '' || /^\d+$/.test(value));
    case 'boolean':
      return typeof value === 'boolean';
    case 'intList':
      return Array.isArray(value) && value.every((v) => Number.isSafeInteger(v) && v >= 0);

    case 'stringList':
      return Array.isArray(value) && value.every((v) => typeof v === 'string');
    default:
      return true;
  }
}

function describeKind(kind) {
  return {
    number: '数字',
    positiveInt: '正整数',
    nonNegativeInt: '非负整数',
    string: '字符串',
    qqString: 'QQ 号（**用字符串写**，如 "100000000"；不带引号会丢精度）',
    boolean: '布尔值',
    intList: '非负整数数组',
    stringList: '字符串数组',
  }[kind] ?? kind;
}

function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i += 1) {
    const cur = [i];
    for (let j = 1; j <= n; j += 1) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n];
}

function nearestKey(key, candidates) {
  let best = '';
  let bestScore = Infinity;
  for (const c of candidates) {
    const d = editDistance(key.toLowerCase(), c.toLowerCase());
    if (d < bestScore) {
      bestScore = d;
      best = c;
    }
  }

  return bestScore <= Math.max(2, Math.floor(key.length / 3)) ? best : '';
}

export function validateConfig(config, { strict = true } = {}) {
  const errors = [];

  const walk = (value, schema, path) => {
    if (isPlainObject(schema)) {
      if (!isPlainObject(value)) {
        errors.push(new ConfigError(`应为对象，实际是 ${typeName(value)}`, { path }));
        return;
      }
      for (const [key, child] of Object.entries(schema)) {
        if (!(key in value)) continue;
        walk(value[key], child, path ? `${path}.${key}` : key);
      }
      if (strict) {
        const known = Object.keys(schema);
        for (const key of Object.keys(value)) {
          if (known.includes(key)) continue;
          const suggestion = nearestKey(key, known);
          errors.push(new ConfigError(
            `未知的配置项 "${key}"`,
            {
              path: path ? `${path}.${key}` : key,
              hint: suggestion ? `你是不是想写 "${suggestion}"？` : `可用的项：${known.join(', ')}`,
            },
          ));
        }
      }
      return;
    }
    if (!checkType(value, schema)) {
      errors.push(new ConfigError(
        `应为${describeKind(schema)}，实际是 ${typeName(value)}${preview(value)}`,
        { path },
      ));
    }
  };

  walk(config, SCHEMA, '');

  if (config.dsh?.baseUrl && !/^https?:\/\//.test(config.dsh.baseUrl)) {
    errors.push(new ConfigError('必须以 http:// 或 https:// 开头', { path: 'dsh.baseUrl' }));
  }
  if (config.snowluma?.wsUrl && !/^wss?:\/\//.test(config.snowluma.wsUrl)) {
    errors.push(new ConfigError('必须以 ws:// 或 wss:// 开头', { path: 'snowluma.wsUrl' }));
  }

  if (
    config.allow
    && config.allow.allowAllWhenEmpty === true
    && config.allow.private.length === 0
    && config.allow.groups.length === 0
  ) {
    errors.push(new ConfigError(
      'allowAllWhenEmpty 为 true 但 allow 列表为空 —— 这会对所有人开放',
      {
        path: 'allow',
        hint: '这是有意的 fail-closed 保护。确认要开放请显式填写列表，或接受启动时的高危告警。',
      },
    ));
  }

  return { ok: errors.length === 0, errors };
}

function typeName(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return '数组';
  return { undefined: 'undefined', string: '字符串', number: '数字', boolean: '布尔值' }[typeof value] ?? typeof value;
}

function preview(value) {
  if (typeof value === 'string') return `（"${value.length > 40 ? `${value.slice(0, 40)}…` : value}"）`;
  if (typeof value === 'number' || typeof value === 'boolean') return `（${value}）`;
  return '';
}
