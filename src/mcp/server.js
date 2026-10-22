import readline from 'node:readline';

export const PROTOCOL_VERSION = '2024-11-05';

export function stderrLog(...args) {
  process.stderr.write(`[qq-mcp] ${args.join(' ')}\n`);
}

export class McpServer {
  constructor({ name, version = '0.1.0', instructions = '' } = {}) {
    this.name = name;
    this.version = version;
    this.instructions = instructions;

    this.tools = new Map();
  }

  tool(name, spec, handler) {
    if (this.tools.has(name)) throw new Error(`工具重名：${name}`);
    this.tools.set(name, { name, ...spec, handler });
    return this;
  }

  listTools() {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
    }));
  }

  async handle(req) {
    const { id, method, params } = req ?? {};

    const isNotification = id === undefined || id === null;

    const reply = (result) => (isNotification ? null : { jsonrpc: '2.0', id, result });
    const fail = (code, message, data) => (isNotification ? null : {
      jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) },
    });

    try {
      switch (method) {
        case 'initialize':
          return reply({
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: this.name, version: this.version },
            ...(this.instructions ? { instructions: this.instructions } : {}),
          });

        case 'notifications/initialized':
        case 'initialized':
          return null;

        case 'ping':
          return reply({});

        case 'tools/list':
          return reply({ tools: this.listTools() });

        case 'tools/call': {
          const toolName = params?.name;
          const args = params?.arguments ?? {};
          const tool = this.tools.get(toolName);
          if (!tool) {

            return reply({
              content: [{ type: 'text', text: `未知工具：${toolName}。可用：${[...this.tools.keys()].join(', ')}` }],
              isError: true,
            });
          }
          try {
            const out = await tool.handler(args);
            return reply({ content: toContent(out) });
          } catch (error) {

            return reply({
              content: [{ type: 'text', text: `工具 ${toolName} 执行失败：${error?.message ?? error}` }],
              isError: true,
            });
          }
        }

        default:
          return fail(-32601, `不支持的方法：${method}`);
      }
    } catch (error) {
      return fail(-32603, `内部错误：${error?.message ?? error}`);
    }
  }

  start() {
    const rl = readline.createInterface({ input: process.stdin, terminal: false });

    const chains = new Map();

    const pending = new Set();

    const chainKeyOf = (req) => {
      const k = req?.params?.arguments?.key;
      return typeof k === 'string' && k !== '' ? k : '__global__';
    };

    rl.on('line', (line) => {
      const text = line.trim();
      if (text === '') return;

      let req;
      try {
        req = JSON.parse(text);
      } catch {

        stderrLog('收到无法解析的帧：', text.slice(0, 200));
        return;
      }

      const key = chainKeyOf(req);
      const prev = chains.get(key) ?? Promise.resolve();
      const next = prev.then(async () => {
        const res = await this.handle(req);
        if (res) process.stdout.write(`${JSON.stringify(res)}\n`);
      }).catch((error) => {
        stderrLog('处理请求出错：', error?.stack ?? String(error));
      });

      chains.set(key, next);
      pending.add(next);

      void next.then(() => {
        pending.delete(next);
        if (chains.get(key) === next) chains.delete(key);
      });
    });

    rl.on('close', () => {
      void Promise.allSettled([...pending]).then(() => {
        stderrLog('stdin 关闭，退出');
        process.exit(0);
      });
    });
  }
}

export function toContent(out) {
  if (out && typeof out === 'object' && Array.isArray(out.content)) {
    return out.content;
  }

  if (out && typeof out === 'object' && Array.isArray(out.images)) {
    const blocks = [];
    if (out.text) blocks.push({ type: 'text', text: String(out.text) });
    for (const img of out.images) {
      if (!img?.data) continue;
      blocks.push({
        type: 'image',
        data: String(img.data),
        mimeType: String(img.mimeType || 'image/png'),
      });
    }
    if (blocks.length) return blocks;

  }

  if (out && typeof out === 'object' && typeof out.text === 'string' && !Array.isArray(out.images)) {
    const rest = Object.keys(out).filter((k) => k !== 'text');
    if (rest.length === 0) {

      return [{ type: 'text', text: out.text }];
    }

    return [
      { type: 'text', text: out.text },
      { type: 'text', text: JSON.stringify(Object.fromEntries(rest.map((k) => [k, out[k]])), null, 2) },
    ];
  }

  return [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 2) }];
}
