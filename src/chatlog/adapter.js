import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';

export class DshDeliveryError extends Error {
  constructor(message, { hint = '' } = {}) {
    super(message);
    this.name = 'DshDeliveryError';
    this.hint = hint;
  }

  toString() {
    return this.hint ? `${this.name}: ${this.message}\n  ${this.hint}` : `${this.name}: ${this.message}`;
  }
}

export class SessionMap {

  constructor({ file, logger, getRole } = {}) {
    this.file = file;
    this.logger = logger;
    this.getRole = typeof getRole === 'function' ? getRole : () => '';

    this.map = new Map();
    this.fs = null;
    this.path = null;
  }

  attach({ fs, path }) {
    this.fs = fs;
    this.path = path;
    this.#load();
    return this;
  }

  #role() {
    try {
      return String(this.getRole() || '').trim();
    } catch {
      return '';
    }
  }

  #load() {
    if (!this.file || !this.fs) return;
    try {
      if (!this.fs.existsSync(this.file)) return;
      const raw = JSON.parse(this.fs.readFileSync(this.file, 'utf8'));
      const atLoad = this.#role();
      let migrated = 0;
      let dropped = 0;
      for (const [key, value] of Object.entries(raw.sessions ?? {})) {
        if (typeof value === 'string') {

          if (!value) { dropped += 1; continue; }
          this.map.set(key, { [atLoad || '*']: value });
          migrated += 1;
          continue;
        }
        if (!value || typeof value !== 'object') { dropped += 1; continue; }
        const buckets = {};
        for (const [role, id] of Object.entries(value)) {
          if (typeof id === 'string' && id) buckets[role] = id;
        }
        if (Object.keys(buckets).length) this.map.set(key, buckets);
        else dropped += 1;
      }
      this.logger?.debug('已载入会话映射', { count: this.map.size, file: this.file, migrated, dropped });
      if (migrated) {

        this.logger?.info('会话映射已升级为按人格记录', { role: atLoad || '*', migrated });
        this.save();
      }
    } catch (error) {

      this.logger?.warn('会话映射载入失败，将新建会话', { file: this.file, error: String(error) });
    }
  }

  save() {
    if (!this.file || !this.fs || !this.path) return;
    try {
      const dir = this.path.dirname(this.file);
      if (!this.fs.existsSync(dir)) this.fs.mkdirSync(dir, { recursive: true });
      const tmp = `${this.file}.tmp-${process.pid}`;
      const payload = { schemaVersion: 2, sessions: Object.fromEntries(this.map) };
      this.fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
      this.fs.renameSync(tmp, this.file);
    } catch (error) {
      this.logger?.warn('会话映射保存失败', { file: this.file, error: String(error) });
    }
  }

  get(key) {
    const buckets = this.map.get(key);
    if (!buckets) return null;
    const role = this.#role();
    if (role && buckets[role]) return buckets[role];
    if (!role) {
      if (buckets['*']) return buckets['*'];
      const ids = Object.values(buckets).filter((v) => typeof v === 'string' && v);
      if (ids.length === 1) return ids[0];
    }
    return null;
  }

  set(key, value) {
    const role = this.#role() || '*';
    const buckets = { ...(this.map.get(key) ?? {}) };
    buckets[role] = value;
    if (role !== '*') delete buckets['*'];
    this.map.set(key, buckets);
    this.save();
  }

  delete(key) {
    const buckets = this.map.get(key);
    if (buckets) {
      const role = this.#role() || '*';
      const next = { ...buckets };
      delete next[role];
      if (Object.keys(next).length) this.map.set(key, next);
      else this.map.delete(key);
    }
    this.save();
  }

  keys() {
    return [...this.map.keys()];
  }

  entriesFor(role) {
    const name = String(role ?? '').trim();
    const out = [];
    for (const [key, buckets] of this.map) {
      const id = buckets[name || '*'];
      if (id) out.push([key, id]);
    }
    return out;
  }

  activeEntries() {
    return this.entriesFor(this.#role());
  }

  allEntries() {
    const out = [];
    for (const [key, buckets] of this.map) {
      for (const [role, sessionId] of Object.entries(buckets)) out.push({ key, role, sessionId });
    }
    return out;
  }

  get size() { return this.map.size; }
}

export class DshDeliverer extends EventEmitter {

  constructor({
    dsh,
    sessionMap,
    cwdFor,
    workspaceFor,
    archivedProbe,
    agentPreset = '',
    logger,
  } = {}) {
    super();
    this.dsh = dsh;
    this.sessionMap = sessionMap;
    this.cwdFor = cwdFor;
    this.workspaceFor = workspaceFor;
    this.archivedProbe = archivedProbe;
    this.agentPreset = agentPreset;
    this.logger = logger;

    this.queues = new Map();

    this.tokens = new Map();

    this.workspaceCache = new Map();

    this.titled = new Set();

    this.titleTries = new Map();
  }

  async #syncTitle(key, sessionId) {
    if (!sessionId || this.titled.has(sessionId)) return;
    const tries = (this.titleTries.get(sessionId) ?? 0) + 1;
    this.titleTries.set(sessionId, tries);
    if (tries > 3) return;
    const title = titleFor(key, this.sessionMap.getRole());
    try {
      await this.dsh.call('session/rename', { sessionId, title });
      this.titled.add(sessionId);
      this.logger?.debug('已设置会话标题', { key, sessionId, title });
    } catch (error) {
      this.logger?.debug('设置会话标题失败（不影响投递）', {
        key, sessionId, title, attempt: tries, error: String(error),
      });
    }
  }

  async renameKnown() {
    const entries = this.sessionMap.activeEntries();
    await Promise.all(entries.map(([key, sessionId]) => this.#syncTitle(key, sessionId)));
    return entries.length;
  }

  tokenFor(key) {
    let t = this.tokens.get(key);
    if (!t) {
      t = crypto.randomBytes(16).toString('hex');
      this.tokens.set(key, t);
    }
    return t;
  }

  async deliver(key, prompt, { signal } = {}) {

    const prev = this.queues.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => this.#deliverOnce(key, prompt, { signal }));

    this.queues.set(key, next.catch(() => {}));
    return next;
  }

  async #deliverOnce(key, prompt, { signal } = {}) {
    const sessionId = await this.#ensureSession(key);
    this.logger?.debug('投递提示词', { key, sessionId, chars: prompt.length });

    const result = await this.dsh.call('session/prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: prompt }],
      requestId: crypto.randomUUID(),
    }, { signal });

    this.emit('delivered', { key, sessionId });
    return { sessionId, result };
  }

  async #ensureSession(key) {
    const existing = this.sessionMap.get(key);
    if (existing) {

      const check = await this.#checkSession(key, existing);

      if (check.ok) {
        void this.#syncTitle(key, existing);
        return existing;
      }
      this.logger?.warn('记住的会话已失效，将重建', {
        key, sessionId: existing, why: check.why, role: this.sessionMap.getRole(),
      });
      this.sessionMap.delete(key);
    }

    const cwd = this.cwdFor ? this.cwdFor(key) : undefined;

    const workspaceId = await this.#ensureWorkspace(key, cwd);

    const res = await this.dsh.call('session/create', {
      ...(workspaceId ? { workspaceId } : (cwd ? { cwd } : {})),
      ...(this.agentPreset ? { agentPreset: this.agentPreset } : {}),
      title: titleFor(key, this.sessionMap.getRole()),
    });

    const sessionId = res?.sessionId ?? res?.id ?? res?.session?.id ?? res?.value?.sessionId;
    if (!sessionId) {
      throw new DshDeliveryError('session/create 没有返回 sessionId', {
        hint: `实际返回：${JSON.stringify(res).slice(0, 300)}`,
      });
    }

    this.sessionMap.set(key, sessionId);
    this.logger?.info('已创建 DSH 会话', {
      key, sessionId, workspaceId: workspaceId || '(无)', role: this.sessionMap.getRole(),
    });
    void this.#syncTitle(key, sessionId);
    this.emit('session-created', { key, sessionId, workspaceId });
    return sessionId;
  }

  async #ensureWorkspace(key, cwd) {
    if (!cwd || !this.workspaceFor) return '';

    const cached = this.workspaceCache.get(cwd);
    if (cached !== undefined) return cached;

    try {
      const id = await this.workspaceFor(key, cwd);
      this.workspaceCache.set(cwd, id ?? '');
      return id ?? '';
    } catch (error) {
      this.logger?.warn('注册 workspace 失败（会话仍会创建，只是不分组）', {
        key, cwd, error: String(error),
      });
      this.workspaceCache.set(cwd, '');
      return '';
    }
  }

  async #checkSession(key, sessionId) {
    if (!this.archivedProbe) {
      this.logger?.debug('会话存活检查：未注入探针，跳过', { key });
      return { ok: true };
    }
    try {
      const archived = await this.archivedProbe();
      if (!archived) {

        this.logger?.debug('会话存活检查：拿不到归档集合，按活着处理', { key, sessionId });
        return { ok: true };
      }
      this.logger?.debug('会话存活检查', {
        key,
        sessionId,
        archivedCount: archived.size,
        isArchived: archived.has(sessionId),
      });
      if (archived.has(sessionId)) return { ok: false, why: 'archived' };
      return { ok: true };
    } catch (error) {
      this.logger?.debug('归档状态查询失败，按活着处理', { key, sessionId, error: String(error) });
      return { ok: true };
    }
  }

  snapshot() {
    return {
      sessions: this.sessionMap.allEntries(),
      pending: [...this.queues.keys()].filter((k) => this.queues.has(k)).length,
    };
  }
}

function titleFor(key, role) {
  const [kind, id] = String(key).split(':');
  const base = kind === 'group' ? `QQ群 ${id}` : `QQ私聊 ${id}`;
  const name = String(role || '').trim();
  return name ? `${base} · ${name}` : base;
}
