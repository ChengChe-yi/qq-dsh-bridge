export class WorkspaceSyncError extends Error {
  constructor(message, { hint = '' } = {}) {
    super(message);
    this.name = 'WorkspaceSyncError';
    this.hint = hint;
  }
  toString() {
    return this.hint ? `${this.name}: ${this.message}\n  ${this.hint}` : `${this.name}: ${this.message}`;
  }
}

export async function ensureWorkspace({ dsh, path: dir, title, logger } = {}) {
  if (!dir) return '';

  try {
    const res = await dsh.call('workspace/create', { path: dir });
    const v = res?.value ?? res;
    const id = v?.workspace?.workspaceId ?? v?.workspaceId ?? '';
    if (id) {
      logger?.debug(v.created ? '已注册新 workspace' : 'workspace 已存在', { path: dir, id });
    }
    return id;
  } catch (error) {
    logger?.warn('workspace/create 失败', { path: dir, error: String(error) });
    return '';
  }
}

export async function syncWorkspaces({ dsh, paths = [], logger } = {}) {
  const result = { created: [], existing: [], failed: [] };
  if (!paths.length) return result;

  for (const { path: dir, title } of paths) {
    try {
      const res = await dsh.call('workspace/create', { path: dir });
      const v = res?.value ?? res;
      const created = v?.created ?? false;
      if (created) {
        result.created.push(dir);
        logger?.info('已注册 workspace', { path: dir, title });
      } else {
        result.existing.push(dir);
        logger?.debug('workspace 已存在', { path: dir });
      }
    } catch (error) {
      result.failed.push({ path: dir, error: String(error) });
      logger?.warn('注册 workspace 失败（不影响收消息）', { path: dir, error: String(error) });
    }
  }

  return result;
}

export function workspaceEntries({ root, dirNameOf, convKeys = [], titles = {} }) {
  return convKeys.map((key) => ({
    path: joinPath(root, dirNameOf(key)),
    title: titles[key] ?? defaultTitle(key),
  }));
}

export function defaultTitle(convKey) {
  const [kind, id] = String(convKey).split(':');
  return kind === 'group' ? `QQ群 ${id}` : `QQ私聊 ${id}`;
}

function joinPath(root, name) {

  const sep = root.includes('\\') ? '\\' : '/';
  return `${root.replace(/[\\/]+$/, '')}${sep}${name}`;
}

function normalize(p) {
  const s = String(p).replace(/[\\/]+/g, '\\').replace(/\\+$/, '');
  return process.platform === 'win32' ? s.toLowerCase() : s;
}
