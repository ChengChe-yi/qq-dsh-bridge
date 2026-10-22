import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

const REDACTIONS = [

  [/(dsh-auth-[A-Za-z0-9_-]+=)[^\s;,"']+/g, '$1<redacted>'],

  [/((?:set-)?cookie\s*:\s*)[^\r\n]+/gi, '$1<redacted>'],

  [/((?:authorization|proxy-authorization)\s*:\s*)[^\r\n]+/gi, '$1<redacted>'],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/-]+=*/g, '$1 <redacted>'],

  [
    /("?(?:access_?token|accessToken|auth_?token|launch_?token|api_?key|apiKey|secret|password|passwordHash|passwordSalt)"?\s*[:=]\s*)("?)([^"',\s}&]+)\2/gi,
    '$1$2<redacted>$2',
  ],

  [/([?&](?:access_token|token|key)=)[^&\s"']+/gi, '$1<redacted>'],
];

export function redact(text) {
  let out = String(text);
  for (const [re, to] of REDACTIONS) out = out.replace(re, to);
  return out;
}

export class Logger {

  constructor({ level = 'info', file = '', maxBytes = 8 * 1024 * 1024, maxFiles = 5, stdout = process.stdout, stderr = process.stderr } = {}) {
    this.setLevel(level);
    this.file = file;
    this.maxBytes = maxBytes;
    this.maxFiles = maxFiles;
    this.stdout = stdout;
    this.stderr = stderr;
    this.stream = null;
    this.written = 0;
    if (file) this.#openFile();
  }

  setLevel(level) {
    const normalized = String(level).toLowerCase();
    if (!(normalized in LEVELS)) {
      throw new Error(`未知日志级别 "${level}"，可用：${Object.keys(LEVELS).join(' / ')}`);
    }
    this.level = normalized;
    this.threshold = LEVELS[normalized];
  }

  #openFile() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });

      this.stream = fs.createWriteStream(this.file, { flags: 'a', encoding: 'utf8' });
      this.stream.on('error', (error) => {

        this.stderr.write(`[logger] 日志文件写入失败：${error.message}\n`);
        this.stream = null;
      });

      this.written = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0;
    } catch (error) {
      this.stderr.write(`[logger] 无法打开日志文件 ${this.file}：${error.message}\n`);
      this.stream = null;
    }
  }

  #rotateIfNeeded() {
    if (!this.stream || this.written < this.maxBytes) return;
    try {
      this.stream.end();

      for (let i = this.maxFiles - 1; i >= 1; i -= 1) {
        const from = i === 1 ? this.file : `${this.file}.${i - 1}`;
        const to = `${this.file}.${i}`;
        if (fs.existsSync(from)) fs.renameSync(from, to);
      }
      this.stream = fs.createWriteStream(this.file, { flags: 'a', encoding: 'utf8' });
      this.written = 0;
    } catch (error) {
      this.stderr.write(`[logger] 日志轮转失败：${error.message}\n`);
    }
  }

  #write(level, message, fields) {
    if (LEVELS[level] < this.threshold) return;

    const at = new Date();

    const ts = formatTimestamp(at);
    const safeMessage = redact(message);
    const suffix = fields && Object.keys(fields).length > 0 ? ` ${redact(stableFields(fields))}` : '';
    const line = `${ts} ${level.toUpperCase().padEnd(5)} ${safeMessage}${suffix}\n`;

    const sink = LEVELS[level] >= LEVELS.warn ? this.stderr : this.stdout;
    sink.write(line);

    if (this.stream) {
      this.stream.write(line);
      this.written += Buffer.byteLength(line, 'utf8');
      this.#rotateIfNeeded();
    }
  }

  debug(message, fields) { this.#write('debug', message, fields); }
  info(message, fields) { this.#write('info', message, fields); }
  warn(message, fields) { this.#write('warn', message, fields); }
  error(message, fields) { this.#write('error', message, fields); }

  static fromConfig(config, options = {}) {
    return new Logger({
      level: config.log.level,
      file: config.log.file,
      maxBytes: config.log.maxBytes,
      maxFiles: config.log.maxFiles,
      ...options,
    });
  }

  applyConfig(config) {
    this.setLevel(config.log.level);
    if (config.log.file !== this.file) {
      this.stream?.end();
      this.stream = null;
      this.file = config.log.file;
      this.maxBytes = config.log.maxBytes;
      this.maxFiles = config.log.maxFiles;
      if (this.file) this.#openFile();
    } else {
      this.maxBytes = config.log.maxBytes;
      this.maxFiles = config.log.maxFiles;
    }
  }

  async close() {
    if (!this.stream) return;
    await new Promise((resolve) => this.stream.end(resolve));
    this.stream = null;
  }
}

function formatTimestamp(date) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
    + `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function stableFields(fields) {
  const keys = Object.keys(fields).sort();
  const parts = [];
  for (const k of keys) {
    const v = fields[k];
    parts.push(`${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
  }
  return parts.join(' ');
}
