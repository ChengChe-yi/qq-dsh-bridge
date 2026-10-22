import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_MAX_INJECT_CHARS = 12000;

export const DEFAULT_OWNER_TITLE = '管理员';

const OWNER_TITLE_RE = /^[ \t]*<!--\s*owner-title\s*[:：]\s*(.+?)\s*-->[ \t]*$/gim;

export function extractOwnerTitle(content) {
  const text = String(content ?? '');
  let title = '';
  const stripped = text.replace(OWNER_TITLE_RE, (_, captured) => {

    if (!title) title = String(captured).trim();
    return '';
  });
  return { title, text: stripped };
}

export class RoleError extends Error {
  constructor(message, { hint = '' } = {}) {
    super(message);
    this.name = 'RoleError';
    this.hint = hint;
  }
  toString() {
    return this.hint ? `${this.name}: ${this.message}\n  ${this.hint}` : `${this.name}: ${this.message}`;
  }
}

const RESERVED = new Set(['CON','PRN','AUX','NUL','COM1','COM2','COM3','COM4','COM5','COM6','COM7','COM8','COM9',
  'LPT1','LPT2','LPT3','LPT4','LPT5','LPT6','LPT7','LPT8','LPT9']);

export function validateRoleName(raw) {
  const name = String(raw ?? '').trim();
  if (!name) throw new RoleError('角色名不能为空');
  if (name.length > 40) throw new RoleError('角色名过长（最多 40 字符）');
  if (/[\\/:*?"<>|]/.test(name)) throw new RoleError('角色名不能包含 \\ / : * ? " < > | 这些字符');
  if (name === '.' || name === '..') throw new RoleError('非法的角色名');
  if (/^readme$/i.test(name)) throw new RoleError('角色名不能叫 README');
  if (RESERVED.has(name.toUpperCase())) throw new RoleError(`"${name}" 是 Windows 保留名，换一个`);
  return name;
}

export function listRoles({ dir } = {}) {
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.md'))
      .filter((f) => !/^readme\.md$/i.test(f))
      .map((f) => f.replace(/\.md$/i, ''))
      .sort((a, b) => a.localeCompare(b, 'zh'));
  } catch {
    return [];
  }
}

export function readRoleContent({ dir, name } = {}) {
  const safe = validateRoleName(name);
  const file = path.join(dir, `${safe}.md`);
  if (!fs.existsSync(file)) {
    throw new RoleError(`找不到角色卡 "${safe}"`, {
      hint: `可用角色：${listRoles({ dir }).join('、') || '（无）'}`,
    });
  }
  return fs.readFileSync(file, 'utf8');
}

export function writeRoleContent({ dir, name, content } = {}) {
  const safe = validateRoleName(name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${safe}.md`);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, String(content ?? ''), 'utf8');
  fs.renameSync(tmp, file);
  return { file, bytes: Buffer.byteLength(String(content ?? ''), 'utf8') };
}

export function selectRoleText({ content, maxChars = DEFAULT_MAX_INJECT_CHARS } = {}) {
  const { title: ownerTitle, text: body } = extractOwnerTitle(content);

  const text = body;
  if (!text.trim()) return { text: '', chars: 0, truncated: false, ownerTitle };

  let out = text.replace(/\r?\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  let truncated = false;

  if (maxChars > 0 && out.length > maxChars) {
    const cut = out.slice(0, maxChars);
    const at = cut.lastIndexOf('\n\n');
    out = (at > maxChars * 0.5 ? cut.slice(0, at) : cut).trimEnd() + '\n\n（人格卡因长度上限截断）';
    truncated = true;
  }

  return { text: out, chars: out.length, truncated, ownerTitle };
}

export class RoleStore {

  constructor({ dir, stateFile, maxChars = DEFAULT_MAX_INJECT_CHARS, logger } = {}) {
    this.dir = dir;
    this.stateFile = stateFile;
    this.maxChars = maxChars;
    this.logger = logger;
    this.current = this.#load() ?? '';
  }

  #load() {
    try {
      const j = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      const name = String(j?.role ?? '');
      if (!name) return null;

      return fs.existsSync(path.join(this.dir, `${name}.md`)) ? name : null;
    } catch {
      return null;
    }
  }

  #save() {
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      const tmp = `${this.stateFile}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify({ role: this.current, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
      fs.renameSync(tmp, this.stateFile);
    } catch (error) {
      this.logger?.warn('角色状态保存失败', { error: String(error) });
    }
  }

  get name() { return this.current; }

  list() { return listRoles({ dir: this.dir }); }

  set(name) {
    const safe = validateRoleName(name);
    readRoleContent({ dir: this.dir, name: safe });
    this.current = safe;
    this.#save();
    this.logger?.info('已切换角色', { role: safe });
    return safe;
  }

  clear() {
    this.current = '';
    this.#save();
    this.logger?.info('已清除角色');
  }

  forPrompt() {
    if (!this.current) return { text: '', mode: 'none', chars: 0, name: '', ownerTitle: '' };
    try {
      const content = readRoleContent({ dir: this.dir, name: this.current });
      const sel = selectRoleText({ content, maxChars: this.maxChars });
      if (!sel.text) return { text: '', mode: 'empty', chars: 0, name: this.current, ownerTitle: sel.ownerTitle };
      return { ...sel, mode: 'role', name: this.current };
    } catch (error) {

      this.logger?.warn('读取角色卡失败，本次不注入人设', { role: this.current, error: String(error) });
      return { text: '', mode: 'error', chars: 0, name: this.current, ownerTitle: '' };
    }
  }
}
