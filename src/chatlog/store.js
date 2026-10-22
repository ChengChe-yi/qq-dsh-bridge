import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

export const SCHEMA_VERSION = 3;

export const MAX_QUOTE_DEPTH = 3;

const MAX_CACHED_DAYS = 8;

const PERSISTED = Symbol('persisted');

function copyRecord(record, depth) {
  if (!record || depth <= 0) return undefined;
  const out = { ...record };

  if (Array.isArray(record.segments)) out.segments = record.segments.map((s) => ({ ...s }));
  if (record.quote?.data) {
    const inner = copyRecord(record.quote.data, depth - 1);
    if (inner) out.quote = { date: record.quote.date, data: inner };
    else delete out.quote;
  }
  return out;
}

export function dateOf(tsMs) {
  const d = new Date(Number(tsMs) || 0);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function dateTimeOf(tsMs) {
  const d = new Date(Number(tsMs) || 0);
  const p = (n) => String(n).padStart(2, '0');
  return `${dateOf(tsMs)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function dirNameOf(convKey) {
  return String(convKey).replace(':', '_');
}

export function seqOf(record, date = '') {
  if (!record) return undefined;
  if (record.msgSeq !== undefined && record.msgSeq !== null) return String(record.msgSeq);
  if (record.no === undefined || record.no === null) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? ''));
  return m ? `${m[2]}${m[3]}#${record.no}` : String(record.no);
}

export class ChatStoreError extends Error {
  constructor(message, { hint = '' } = {}) {
    super(message);
    this.name = 'ChatStoreError';
    this.hint = hint;
  }
}

export class ChatStore extends EventEmitter {

  constructor({ root, convKey, logger, flushDelayMs = 2000, selfQq = '', maxCachedDays = MAX_CACHED_DAYS } = {}) {
    super();
    this.root = root;
    this.convKey = convKey;
    this.dir = path.join(root, dirNameOf(convKey));
    this.chatDir = path.join(this.dir, 'chat');
    this.logger = logger;
    this.flushDelayMs = flushDelayMs;
    this.selfQq = selfQq ? String(selfQq) : '';
    this.maxCachedDays = Number(maxCachedDays) > 0 ? Number(maxCachedDays) : MAX_CACHED_DAYS;

    this.isPrivate = String(convKey).startsWith('private:');

    this.cache = new Map();

    this.flushTimers = new Map();
    this.conv = null;
  }

  init() {
    fs.mkdirSync(this.chatDir, { recursive: true });
    this.#guardOldFormat();
    this.#loadConv();
    return this;
  }

  ensureDir() {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.mkdirSync(this.chatDir, { recursive: true });
    return this;
  }

  fileFor(date) {
    return path.join(this.chatDir, `${date}.jsonl`);
  }

  stateFileFor(date) {
    return path.join(this.chatDir, `${date}.state.jsonl`);
  }

  emptyDoc(date) {
    return this.isPrivate
      ? { date, lastNo: 0, messages: [] }
      : { date, lastMsgSeq: 0, messages: [] };
  }

  #guardOldFormat() {
    let old = [];
    try {
      old = fs.readdirSync(this.chatDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
    } catch {  }
    if (old.length) {
      throw new ChatStoreError(
        `${this.chatDir} 里还有 ${old.length} 个 v2 旧日文件（如 ${old.sort()[0]}），
当前结构版本是 v${SCHEMA_VERSION}`,
        {
          hint: '新格式是 .jsonl（一行一条消息）+ .state.jsonl（状态增量）。'
            + '旧文件请移走备份（例如移到 chat/_v2-archive/）后再启动 —— 不要留在原地，'
            + '否则每次启动都会停在这里。',
        },
      );
    }
  }

  #loadConv() {
    const file = path.join(this.dir, 'conv.json');
    if (fs.existsSync(file)) {
      let parsed;
      try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (error) {
        throw new ChatStoreError(`解析 ${file} 失败：${error.message}`, {
          hint: '会话元数据损坏。修好它，或把它移走后重启（只会重建这一份元数据）。',
        });
      }
      if (parsed.schemaVersion !== SCHEMA_VERSION) {
        throw new ChatStoreError(
          `${file} 的结构版本是 ${parsed.schemaVersion ?? '(缺失)'}，期望 ${SCHEMA_VERSION}`,
          { hint: '这是旧结构的会话。请把整个会话目录（或其 chat/ 下的旧文件）移走备份后重启。' },
        );
      }

      if (!parsed.selfQq && this.selfQq) {
        parsed.selfQq = this.selfQq;
        this.#writeConv(parsed);
      }
      this.conv = parsed;
      return parsed;
    }

    const fresh = {
      schemaVersion: SCHEMA_VERSION,
      conv: this.convKey,
      selfQq: this.selfQq || undefined,
    };
    this.#writeConv(fresh);
    this.conv = fresh;
    return fresh;
  }

  #writeConv(conv) {
    const file = path.join(this.dir, 'conv.json');
    const tmp = `${file}.tmp-${process.pid}`;
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(conv, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
  }

  load(date) {
    const hit = this.cache.get(date);
    if (hit) return hit.doc;

    const messages = [];
    const file = this.fileFor(date);
    if (fs.existsSync(file)) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        const raw = lines[i].trim();
        if (raw === '') continue;
        try {
          messages.push(JSON.parse(raw));
        } catch (error) {

          this.logger?.error('聊天记录有坏行，已跳过', {
            conv: this.convKey, date, line: i + 1, error: String(error), preview: raw.slice(0, 120),
          });
        }
      }
    }

    const doc = this.emptyDoc(date);
    doc.messages = messages;
    this.#foldStates(date, doc);
    if (this.isPrivate) {
      for (const m of doc.messages) {
        const no = Number(m.no);
        if (Number.isFinite(no) && no > doc.lastNo) doc.lastNo = no;
      }
    } else {
      for (const m of doc.messages) {
        const seq = Number(m.msgSeq);
        if (Number.isFinite(seq) && seq > doc.lastMsgSeq) doc.lastMsgSeq = seq;
      }
    }

    this.cache.set(date, { doc, dirty: false });
    this.#evict(date);
    return doc;
  }

  #foldStates(date, doc) {
    for (const m of doc.messages) this.#track(m, m.readCount ?? 0, m.state);

    const file = this.stateFileFor(date);
    if (!fs.existsSync(file)) {
      for (const m of doc.messages) m.readCount = m.readCount ?? 0;
      return;
    }

    const lines = fs.readFileSync(file, 'utf8').split('\n');
    let applied = 0;
    for (let ln = 0; ln < lines.length; ln += 1) {
      const raw = lines[ln].trim();
      if (raw === '') continue;
      let patch;
      try {
        patch = JSON.parse(raw);
      } catch (error) {

        this.logger?.warn('状态日志有坏行，已跳过', {
          conv: this.convKey, date, line: ln + 1, error: String(error), preview: raw.slice(0, 120),
        });
        continue;
      }
      const i = Number(patch?.i);
      const m = Number.isInteger(i) ? doc.messages[i] : undefined;
      if (!m) {
        this.logger?.warn('状态日志指向不存在的行号，已跳过', {
          conv: this.convKey, date, line: ln + 1, i: patch?.i,
        });
        continue;
      }

      if (patch.g !== undefined && String(patch.g) !== String(this.#guardOf(m))) {
        this.logger?.warn('状态日志与消息对不上（文件被外部改动过？），已跳过', {
          conv: this.convKey, date, line: ln + 1, i, guard: patch.g, got: this.#guardOf(m),
        });
        continue;
      }
      if (patch.r !== undefined) m.readCount = Number(patch.r);

      if (patch.s !== undefined) m.state = patch.s === null ? undefined : patch.s;
      applied += 1;
    }

    for (const m of doc.messages) {
      m.readCount = m.readCount ?? 0;
      this.#track(m, m.readCount, m.state);
    }
    if (applied) this.logger?.debug('已折叠状态增量', { conv: this.convKey, date, applied });
  }

  #track(record, r, s) {
    Object.defineProperty(record, PERSISTED, {
      value: { r, s }, writable: true, enumerable: false, configurable: true,
    });
  }

  #guardOf(record) {
    if (!this.isPrivate && record?.msgSeq !== undefined && record?.msgSeq !== null) return record.msgSeq;
    return record?.messageId;
  }

  #toLine(record) {
    const out = {
      messageId: record.messageId,
    };

    if (record.no !== undefined) out.no = record.no;
    if (record.msgSeq !== undefined) out.msgSeq = record.msgSeq;
    out.tsMs = record.tsMs;
    out.sender = record.sender;
    if (record.segments !== undefined) out.segments = record.segments;
    if (record.quote !== undefined) out.quote = record.quote;
    return out;
  }

  findByMessageId(messageId) {
    const id = String(messageId ?? '');
    if (!id) return null;
    for (const date of this.#datesDescending()) {
      const doc = this.load(date);
      for (let i = doc.messages.length - 1; i >= 0; i -= 1) {
        if (String(doc.messages[i].messageId) !== id) continue;
        return { message: doc.messages[i], date };
      }
    }
    return null;
  }

  findByMsgSeq(msgSeq) {
    const want = Number(msgSeq);
    if (!Number.isFinite(want) || want === 0) return null;
    for (const date of this.#datesDescending()) {
      const doc = this.load(date);
      for (let i = doc.messages.length - 1; i >= 0; i -= 1) {
        if (Number(doc.messages[i].msgSeq) !== want) continue;
        return { message: doc.messages[i], date };
      }
    }
    return null;
  }

  findByNo(no) {
    const want = Number(no);
    if (!Number.isFinite(want) || want <= 0) return null;
    for (const date of this.#datesDescending()) {
      const doc = this.load(date);
      for (let i = doc.messages.length - 1; i >= 0; i -= 1) {
        if (Number(doc.messages[i].no) === want) return { message: doc.messages[i], date };
      }
    }
    return null;
  }

  findByDateNo(mmdd, no) {
    const want = String(no);
    for (const date of this.#datesDescending()) {
      if (date.slice(5, 7) + date.slice(8, 10) !== String(mmdd)) continue;
      const doc = this.load(date);
      for (const m of doc.messages) {
        if (String(m.no) === want) return { message: m, date };
      }
    }
    return null;
  }

  findByRef(ref) {
    const s = String(ref ?? '').trim();
    if (!s) return null;
    const dated = /^(\d{4})#(\d+)$/.exec(s);
    if (dated) return this.findByDateNo(dated[1], dated[2]);
    if (/^\d+$/.test(s)) {
      if (!this.isPrivate) {
        const hit = this.findByMsgSeq(Number(s));
        if (hit) return hit;
      } else {
        const hit = this.findByNo(Number(s));
        if (hit) return hit;
      }
    }
    return this.findByMessageId(s);
  }

  #resolveQuote(quote) {
    if (!quote) return undefined;
    const id = String(quote.id ?? quote.messageId ?? '');
    if (!id) return undefined;
    const found = this.findByMessageId(id);
    if (!found) return undefined;
    return { date: found.date, data: copyRecord(found.message, MAX_QUOTE_DEPTH) };
  }

  #stampReplySeq(segments) {
    if (!Array.isArray(segments)) return segments;
    if (!segments.some((s) => s?.type === 'reply')) return segments;

    return segments.map((seg) => {
      if (seg?.type !== 'reply') return seg;
      const id = String(seg.data?.id ?? '');
      if (!id) return seg;
      const found = this.findByMessageId(id);
      if (!found) return seg;
      return { ...seg, data: { ...seg.data, seq: seqOf(found.message, found.date) } };
    });
  }

  flush(date) {
    const entry = this.cache.get(date);
    if (!entry || !entry.dirty) return false;

    const lines = [];
    const msgs = entry.doc.messages;
    for (let i = 0; i < msgs.length; i += 1) {
      const m = msgs[i];
      const r = Number(m.readCount ?? 0);
      const s = m.state;
      const last = m[PERSISTED] ?? { r: 0, s: undefined };
      const patch = {};
      if (r !== last.r) patch.r = r;
      if (JSON.stringify(s ?? null) !== JSON.stringify(last.s ?? null)) patch.s = s ?? null;
      if (patch.r === undefined && patch.s === undefined) continue;

      const line = { i, g: this.#guardOf(m) };
      if (patch.r !== undefined) line.r = patch.r;
      if (patch.s !== undefined) line.s = patch.s;
      lines.push(`${JSON.stringify(line)}\n`);
      this.#track(m, r, s);
    }

    if (!lines.length) {
      entry.dirty = false;
      return false;
    }

    fs.appendFileSync(this.stateFileFor(date), lines.join(''), 'utf8');
    entry.dirty = false;
    this.emit('flushed', { date, count: msgs.length, stateLines: lines.length });
    return true;
  }

  flushAll() {
    let n = 0;
    for (const date of [...this.cache.keys()]) if (this.flush(date)) n += 1;
    return n;
  }

  scheduleFlush(date) {
    if (this.flushTimers.has(date)) return;
    const t = setTimeout(() => {
      this.flushTimers.delete(date);
      try {
        this.flush(date);
      } catch (error) {

        this.logger?.error('聊天记录落盘失败', { date, conv: this.convKey, error: String(error) });
      }
    }, this.flushDelayMs);
    t.unref?.();
    this.flushTimers.set(date, t);
  }

  flushPending() {
    for (const [date, t] of this.flushTimers) {
      clearTimeout(t);
      this.flushTimers.delete(date);
    }
    return this.flushAll();
  }

  append(message) {

    const seq = Number(message.msgSeq);
    const hasSeq = !this.isPrivate && Number.isFinite(seq) && seq > 0;
    if (hasSeq) {

      const hit = this.findByMsgSeq(seq);
      if (hit) return hit.message;
    } else {

      const incomingId = String(message.messageId ?? '');
      if (incomingId !== '') {
        const found = this.findByMessageId(incomingId);
        if (found) return found.message;
      }
    }

    const tsMs = Number(message.tsMs) || Date.now();
    const date = dateOf(tsMs);
    const doc = this.load(date);

    if (String(message.sender?.qq ?? '') === '') {
      this.logger?.error('消息的发送者 qq 是空串 —— 落盘后"谁说的"会丢失', {
        conv: this.convKey,
        messageId: message.messageId,
        gotSender: JSON.stringify(message.sender ?? null),
        hint: '大概率是调用方写了 sender.id 而这里读 sender.qq（字段名必须统一成 qq）',
      });
    }

    const msgSeq = message.msgSeq === undefined || message.msgSeq === null
      ? undefined
      : Number(message.msgSeq);
    if (!this.isPrivate && Number.isFinite(msgSeq) && msgSeq > (doc.lastMsgSeq ?? 0)) {
      doc.lastMsgSeq = msgSeq;
    }

    const no = this.isPrivate ? (doc.lastNo ?? 0) + 1 : undefined;
    if (this.isPrivate) doc.lastNo = no;

    const record = {
      no,
      messageId: String(message.messageId ?? ''),
      msgSeq,
      tsMs,
      sender: {
        qq: String(message.sender?.qq ?? ''),
        name: String(message.sender?.name ?? ''),

        groupRole: normalizeGroupRole(message.sender?.groupRole),
      },

      segments: this.#stampReplySeq(
        Array.isArray(message.segments) ? message.segments : undefined,
      ),

      quote: this.#resolveQuote(message.quote),
      readCount: 0,
    };

    for (const k of Object.keys(record)) {
      if (record[k] === undefined) delete record[k];
    }

    doc.messages.push(record);
    this.#track(record, 0, undefined);
    fs.mkdirSync(this.chatDir, { recursive: true });
    fs.appendFileSync(this.fileFor(date), `${JSON.stringify(this.#toLine(record))}\n`, 'utf8');
    this.emit('appended', { date, message: record });
    return record;
  }

  recall(messageId, info = {}) {
    const id = String(messageId);
    for (const date of this.#datesDescending()) {
      const doc = this.load(date);
      for (let i = doc.messages.length - 1; i >= 0; i -= 1) {
        if (doc.messages[i].messageId !== id) continue;
        const msg = doc.messages[i];

        const qq = String(info.sender?.qq ?? '');
        const known = qq === '' ? undefined : this.#knownIdentityOf(qq);
        const name = String(info.sender?.name || known?.name || '');
        const roleRaw = info.sender?.groupRole || known?.groupRole;
        msg.state = {
          ...msg.state,
          recalled: 1,
          recalledTime: info.atMs ?? Date.now(),
          ...(qq === '' ? {} : {
            sender: {
              qq,
              ...(name === '' ? {} : { name }),
              ...(roleRaw ? { groupRole: normalizeGroupRole(roleRaw) } : {}),
            },
          }),
        };
        this.cache.get(date).dirty = true;
        this.scheduleFlush(date);
        this.emit('recalled', { date, message: msg });
        return { found: true, message: msg, date };
      }
    }
    return { found: false, message: null, date: null };
  }

  #knownIdentityOf(qq) {
    const want = String(qq);
    for (const date of this.#datesDescending()) {
      const doc = this.load(date);
      for (let i = doc.messages.length - 1; i >= 0; i -= 1) {
        const s = doc.messages[i]?.sender;
        if (String(s?.qq ?? '') !== want) continue;
        if (s.name || s.groupRole) return s;
      }
    }
    return undefined;
  }

  #evict(protect = '') {
    if (this.cache.size <= this.maxCachedDays) return;
    const dates = [...this.cache.keys()].sort();
    const newest = dates.slice(-2);
    for (const date of dates) {
      if (this.cache.size <= this.maxCachedDays) break;

      if (date === protect) continue;
      if (newest.includes(date)) continue;
      const entry = this.cache.get(date);
      if (entry.dirty) continue;
      this.cache.delete(date);
      this.logger?.debug('已驱逐内存中的历史天', { conv: this.convKey, date, cached: this.cache.size });
    }
  }

  #datesDescending() {

    const set = new Set(this.cache.keys());
    try {
      for (const f of fs.readdirSync(this.chatDir)) {

        const m = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
        if (m) set.add(m[1]);
      }
    } catch {  }
    return [...set].sort().reverse();
  }

  dates() {
    return this.#datesDescending().reverse();
  }

}

export function normalizeGroupRole(value) {
  const v = String(value ?? '');
  if (v === 'groupOwner' || v === 'owner') return 'groupOwner';
  if (v === 'admin') return 'admin';
  return 'member';
}
