import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { loadConfig } from './load.js';
import { ConfigError } from './schema.js';

export class ConfigStore extends EventEmitter {

  constructor({ root = process.cwd(), configPath, env = process.env, argv = [], strict = true } = {}) {
    super();
    this.root = root;
    this.configPath = configPath ?? path.join(root, 'config.json');
    this.env = env;
    this.argv = argv;
    this.strict = strict;

    this.current = null;
    this.loadErrors = [];
    this.watcher = null;
    this.timer = null;
    this.lastLoadAt = 0;

    this.revision = 0;
  }

  loadInitial() {
    const result = loadConfig({
      root: this.root,
      configPath: this.configPath,
      env: this.env,
      argv: this.argv,
      strict: this.strict,
    });
    this.current = result.config;
    this.loadErrors = result.errors;
    this.source = result.source;
    this.lastLoadAt = Date.now();
    this.revision += 1;
    return result;
  }

  get() {
    if (this.current === null) throw new Error('ConfigStore.loadInitial() 尚未调用');
    return this.current;
  }

  reload({ reason = 'manual' } = {}) {
    let result;
    try {
      result = loadConfig({
        root: this.root,
        configPath: this.configPath,
        env: this.env,
        argv: this.argv,
        strict: this.strict,
      });
    } catch (error) {

      const configError = error instanceof ConfigError ? error : new ConfigError(String(error?.message ?? error));
      this.loadErrors = [configError];
      this.emit('error', configError, { reason, keptPrevious: true });
      return { changed: false, errors: this.loadErrors };
    }

    if (!result.ok) {

      this.loadErrors = result.errors;
      this.emit('error', result.errors, { reason, keptPrevious: true });
      return { changed: false, errors: result.errors };
    }

    const previous = this.current;
    const changed = !shallowEqualConfig(previous, result.config);
    this.current = result.config;
    this.loadErrors = [];
    this.source = result.source;
    this.lastLoadAt = Date.now();
    if (changed) {
      this.revision += 1;
      this.emit('change', { config: result.config, previous, reason });
    }
    return { changed, errors: [] };
  }

  startWatching() {
    if (this.watcher) return;
    if (!this.get().watch.enabled) {
      this.emit('watch-disabled');
      return;
    }

    const dir = path.dirname(this.configPath);
    const target = path.basename(this.configPath);

    try {

      this.watcher = fs.watch(dir, { persistent: true }, (_eventType, filename) => {

        if (filename && filename !== target) return;
        this.#scheduleReload();
      });
    } catch (error) {

      this.emit('error', new ConfigError(`无法监听 ${dir}：${error.message}`, { hint: '热重载已禁用，配置改动需重启进程生效。' }), { reason: 'watch-start' });
      return;
    }

    this.watcher.on('error', (error) => {
      this.emit('error', new ConfigError(`配置监听出错：${error.message}`), { reason: 'watch' });
    });

    this.emit('watch-started', { dir, target });
  }

  stopWatching() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
      this.emit('watch-stopped');
    }
  }

  #scheduleReload() {
    const { debounceMs } = this.get().watch;

    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.reload({ reason: 'file-watch' });
    }, debounceMs);

  }
}

function shallowEqualConfig(a, b) {
  if (a === null || b === null) return a === b;
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}
