import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const COOKIE_PREFIX = 'dsh-auth-';
export const COOKIE_PAYLOAD_VERSION = 1;
export const SECRET_BYTES = 32;
export const STORED_SECRET_VERSION = 1;

export class DshAuthError extends Error {
  constructor(message, { hint = '' } = {}) {
    super(message);
    this.name = 'DshAuthError';
    this.hint = hint;
  }
  toString() {
    return this.hint ? `${this.name}: ${this.message}\n  ${this.hint}` : `${this.name}: ${this.message}`;
  }
}

export function encodeBase64Url(value) {
  return Buffer.from(value).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;

export function decodeBase64Url(value) {
  if (typeof value !== 'string') return undefined;
  if (!BASE64URL_PATTERN.test(value) || value.length % 4 === 1) return undefined;
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const decoded = Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/') + padding, 'base64');

  return encodeBase64Url(decoded) === value ? decoded : undefined;
}

export function resolveDshHome(explicit) {
  if (explicit) return path.resolve(explicit);
  if (process.env.DSH_HOME) return path.resolve(process.env.DSH_HOME);
  return path.join(os.homedir(), '.dsh');
}

export function readBrowserSessionSecret({ home, file } = {}) {
  const credFile = file ?? path.join(home ?? resolveDshHome(), '.credentials.yaml');

  let raw;
  try {
    raw = fs.readFileSync(credFile, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new DshAuthError(
        `找不到凭据文件：${credFile}`,
        { hint: '确认 DSH_HOME 指向真正的 .dsh 目录（该目录下应有 .credentials.yaml）。' },
      );
    }
    throw new DshAuthError(`无法读取凭据文件 ${credFile}：${error.message}`);
  }

  const block = extractBrowserSessionRecord(raw);
  if (!block) {
    throw new DshAuthError(
      `${credFile} 里没有 client-connection/browser-session 记录`,
      { hint: 'DSH 首次以 web 方式启动后才会写入该记录；先启动一次 dsh web。' },
    );
  }

  const secretText = matchScalar(block, 'secret');
  if (!secretText) {
    throw new DshAuthError(`browser-session 记录里没有 secret 字段（${credFile}）`);
  }

  const kind = matchScalar(block, 'kind');
  if (kind && kind !== 'grant') {
    throw new DshAuthError(
      `browser-session 记录的 kind 是 "${kind}"，期望 "grant"`,
      { hint: '凭据格式可能是别的 DSH 版本，请检查该文件。' },
    );
  }
  const payloadVersion = matchScalar(block, 'version');
  if (payloadVersion && Number(payloadVersion) !== STORED_SECRET_VERSION) {
    throw new DshAuthError(
      `browser-session 的 payload.version 是 "${payloadVersion}"，期望 ${STORED_SECRET_VERSION}`,
    );
  }

  const secret = decodeBase64Url(secretText);
  if (secret === undefined) {
    throw new DshAuthError('secret 不是合法的 base64url');
  }
  if (secret.byteLength !== SECRET_BYTES) {
    throw new DshAuthError(
      `secret 解码后是 ${secret.byteLength} 字节，期望 ${SECRET_BYTES} 字节`,
      { hint: '这说明取到的不是 browser-session 的签名密钥（可能匹配到了别的记录）。' },
    );
  }

  return { secret, file: credFile };
}

function extractBrowserSessionRecord(yaml) {
  const key = 'client-connection/browser-session';
  const at = yaml.indexOf(key);
  if (at === -1) return '';

  const after = yaml.slice(at + key.length);
  const lines = after.split('\n');
  const baseIndent = leadingSpaces(lines[0] ?? '') || 0;
  const out = [];
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      out.push(line);
      continue;
    }
    const indent = leadingSpaces(line);

    if (indent <= baseIndent && /^\s*[^\s#][^:]*:/.test(line)) break;
    out.push(line);
  }
  return out.join('\n');
}

function leadingSpaces(line) {
  const m = /^(\s*)/.exec(line);
  return m ? m[1].length : 0;
}

function matchScalar(text, key) {
  const re = new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`, 'm');
  const m = re.exec(text);
  if (!m) return '';
  let value = m[1];

  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return value;
}

export function cookieName(authority) {
  return COOKIE_PREFIX + encodeBase64Url(crypto.createHash('sha256').update(authority).digest());
}

function sign(secret, body) {
  return crypto.createHmac('sha256', secret).update(body).digest();
}

export function encodeCookie(payload, secret) {
  const body = encodeBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `v1.${body}.${encodeBase64Url(sign(secret, body))}`;
}

export function decodeCookie(value, secret) {
  const parts = String(value).split('.');
  const [version, body, encodedSignature] = parts;
  if (parts.length !== 3 || version !== 'v1' || body === undefined || encodedSignature === undefined) return undefined;

  const actual = decodeBase64Url(encodedSignature);
  if (actual === undefined) return undefined;
  const expected = sign(secret, body);
  if (actual.byteLength !== expected.byteLength || !crypto.timingSafeEqual(actual, expected)) return undefined;

  const bodyBytes = decodeBase64Url(body);
  if (bodyBytes === undefined) return undefined;
  try {
    const decoded = JSON.parse(bodyBytes.toString('utf8'));
    if (decoded?.version !== COOKIE_PAYLOAD_VERSION) return undefined;
    if (typeof decoded.authority !== 'string') return undefined;
    if (!Number.isSafeInteger(decoded.issuedAt) || !Number.isSafeInteger(decoded.expiresAt)) return undefined;
    return decoded;
  } catch {
    return undefined;
  }
}

export function authorityOf(baseUrl) {
  return new URL(baseUrl).host;
}

export function mintSessionCookie({ baseUrl, secret, lifetimeMs, now = Date.now() }) {
  const authority = authorityOf(baseUrl);
  const issuedAt = now;
  const expiresAt = issuedAt + lifetimeMs;
  const value = encodeCookie({ version: COOKIE_PAYLOAD_VERSION, authority, issuedAt, expiresAt }, secret);
  return { name: cookieName(authority), value, authority, issuedAt, expiresAt };
}

export function shouldRefresh(cookie, { skewMs, now = Date.now() }) {
  if (!cookie) return true;
  return now >= cookie.expiresAt - skewMs;
}
