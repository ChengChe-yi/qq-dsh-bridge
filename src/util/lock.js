import fs from 'node:fs';
import path from 'node:path';

export class LockError extends Error {
  constructor(message, { hint = '', pid = 0 } = {}) {
    super(message);
    this.name = 'LockError';
    this.hint = hint;
    this.pid = pid;
  }
  toString() {
    return this.hint ? `${this.name}: ${this.message}\n  ${this.hint}` : `${this.name}: ${this.message}`;
  }
}

export function acquireLock({ file, isAlive = defaultIsAlive, now = Date.now } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const existing = readLock(file);
  if (existing && existing.pid > 0 && isAlive(existing.pid)) {
    throw new LockError(
      `已有实例在运行（PID ${existing.pid}，启动于 ${new Date(existing.startedAt).toLocaleString()}）`,
      {
        pid: existing.pid,
        hint: '关掉那个窗口再启动，或者确认它不是僵尸进程。'
          + '同时跑两个会让同一条 QQ 消息被回两遍，聊天记录的 seq 也会互相覆盖。',
      },
    );
  }

  if (fs.existsSync(file)) {
    try {
      fs.unlinkSync(file);
    } catch {  }
  }

  const payload = { pid: process.pid, startedAt: now(), cwd: process.cwd() };

  try {
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new LockError('另一个实例刚刚抢先启动了', { hint: '稍等一秒再试。' });
    }
    throw error;
  }

  let released = false;
  return {
    pid: process.pid,
    file,
    release() {
      if (released) return;
      released = true;
      try {

        const cur = readLock(file);
        if (cur && cur.pid !== process.pid) return;
        fs.unlinkSync(file);
      } catch {  }
    },
  };
}

function readLock(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof raw?.pid !== 'number') return null;
    return raw;
  } catch {
    return null;
  }
}

function defaultIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {

    return error.code === 'EPERM';
  }
}
