import crypto from 'node:crypto';
import fs from 'node:fs';

export function pickSections(markdown, keys = []) {
  const text = String(markdown ?? '');
  if (!keys.length) return text.trim();

  const lines = text.split('\n');
  const heads = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (/^#{2,3} /.test(lines[i])) heads.push(i);
  }
  const out = [];
  for (let k = 0; k < heads.length; k += 1) {
    const title = lines[heads[k]];
    if (!keys.some((p) => title.includes(p))) continue;
    const end = k + 1 < heads.length ? heads[k + 1] : lines.length;
    out.push(lines.slice(heads[k], end).join('\n').trim());
  }
  return out.join('\n\n');
}

function taskWake({ name, capabilities }) {
  return `────────────────────────
你是「${name}」的决策层，不是写手 —— **你不写回复，只判断这一轮她要不要开口**。

判断标准照上面那份人设来：
- 该开口：有人真的在跟她说话（问她事、找她办事、接她的话），而且她按人设**愿意**接。
- 不该开口：别人之间的对话（哪怕提到她）；玩梗带她、只是叫一声名字；命令句（"说""快点""发我"）；
  她已经拒绝过的事被追问；她刚连着说了好几条；纯图片/表情/无文字。
- **服从明确的叫停**：有人说"别回""闭嘴""别理我""这条不要放"→ 那就是明确要她**不开口**。
${capabilities ? `- **她能给的**：${capabilities} —— 落到这些话题上，多半该开口。\n` : ''}- 管理者 @ 她通常是例外（人设里怎么写的就怎么办）。

拿不准时倾向 **ignore** —— 她不说话没有任何代价，群里看不到痕迹。

只输出 JSON，不要别的内容：
{"act":"reply","reason":"十五字以内"} 或 {"act":"ignore","reason":"十五字以内"}`;
}

function taskWait({ name }) {
  return `────────────────────────
你是「${name}」的决策层。她正在等，你只判断这一批新消息**值不值得打断等待**。

- 该返回：有人明确在跟她说话（@ 她、引用她、叫她名字并提问）；管理者说话；她等的那个人说了与她相关的内容。
- 继续等：只是群友之间在聊；玩梗、刷屏、表情；她等的人只是随便说了句不相干的。

注意：继续等**不等于漏消息** —— 这些会留在池子里，下次返回时一起给她。所以拿不准时选"继续等"。

只输出 JSON：{"act":"return","reason":"十五字以内"} 或 {"act":"keep","reason":"十五字以内"}`;
}

function renderLines(list, selfName) {
  return list.map((m) => {
    const who = m.self ? selfName : (m.who || '某人');
    const ago = m.secsAgo === undefined ? '' : `${m.secsAgo}秒前`;
    return `[${ago}][${who}] ${m.text}`;
  }).join('\n');
}

export function createJudge({ getConfig, getRoleName, logger, cardPath } = {}) {
  const cfg = () => (typeof getConfig === 'function' ? (getConfig()?.decide ?? {}) : {});
  const cardPathOf = () => (typeof cardPath === 'function' ? cardPath() : cardPath);
  const roleNameOf = () => String((typeof getRoleName === 'function' ? getRoleName() : '') || '角色');

  let stamp = '';
  let card = '';

  let systems = { wake: '', wait: '' };
  let hashes = { wake: '', wait: '' };
  let roleName = '';
  let keyCache = { value: '', at: 0 };
  let inflight = 0;

  function build(c) {
    const path = cardPathOf() || '';
    let raw = '';
    let mtime = 0;
    if (path) {
      try {
        mtime = fs.statSync(path).mtimeMs;
        raw = fs.readFileSync(path, 'utf8');
      } catch (error) {
        logger?.warn('决策层：角色卡读不到，判断将退化为"只看上下文"', { path, error: String(error) });
      }
    }
    roleName = roleNameOf();
    const max = Math.max(200, Number(c.cardMaxChars) || 3000);
    card = pickSections(raw, Array.isArray(c.cardSections) ? c.cardSections : []).slice(0, max);
    const head = card ? `${card}\n\n` : '';
    const caps = String(c.capabilities ?? '');
    const fallback = '按"是个有自己脾气的人"来';
    systems = {
      wake: head + (card ? taskWake({ name: roleName, capabilities: caps }) : taskWake({ name: roleName, capabilities: caps }).replace('照上面那份人设来', fallback)),
      wait: head + (card ? taskWait({ name: roleName }) : taskWait({ name: roleName })),
    };
    hashes = {
      wake: crypto.createHash('sha1').update(systems.wake).digest('hex').slice(0, 12),
      wait: crypto.createHash('sha1').update(systems.wait).digest('hex').slice(0, 12),
    };
    stamp = `${path}|${mtime}|${roleName}|${max}|${(c.cardSections ?? []).join(',')}|${c.capabilities ?? ''}`;
  }

  function apiKey(c) {
    if (c.apiKey) return c.apiKey;
    if (Date.now() - keyCache.at < 60_000 && keyCache.value) return keyCache.value;
    let value = '';
    if (c.apiKeyFile) {
      try {
        const text = fs.readFileSync(c.apiKeyFile, 'utf8');
        const ref = String(c.apiKeyRef || 'WB2API_KEY').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        value = text.match(new RegExp(`${ref}:\\s*(\\S+)`))?.[1] ?? '';
      } catch {
        value = '';
      }
    }
    if (!value) value = String(process.env.QQ_DECIDE_API_KEY ?? '');
    keyCache = { value, at: Date.now() };
    return value;
  }

  function enabled() {
    const c = cfg();
    return c.mode === 'shadow' || c.mode === 'enforce';
  }

  function refresh(c) {
    const path = cardPathOf() || '';
    let mtime = 0;
    try {
      mtime = fs.statSync(path).mtimeMs;
    } catch {
      mtime = 0;
    }
    const next = `${path}|${mtime}|${roleNameOf()}|${Math.max(200, Number(c.cardMaxChars) || 3000)}|${(c.cardSections ?? []).join(',')}|${c.capabilities ?? ''}`;
    if (next !== stamp) build(c);
  }

  async function decide({ kind = 'wake', recent = [], trigger = {}, state = {} } = {}) {
    const c = cfg();
    if (!enabled()) return { act: 'off', reason: '', ms: 0 };
    refresh(c);

    const key = apiKey(c);
    if (!key) return { act: 'error', reason: '没有 apiKey', ms: 0 };

    if (inflight >= 1) return { act: 'busy', reason: '', ms: 0 };
    inflight += 1;

    const max = Math.max(1, Number(c.maxRecentLines) || 8);
    const lines = renderLines(recent.slice(-max), roleName);
    const parts = [];
    if (lines) parts.push(`【最近 ${Math.min(recent.length, max)} 条】\n${lines}`);
    parts.push(
      `${kind === 'wait' ? '【这一批】' : '【这一条】'}\n`
      + `[${trigger.who || '某人'}${trigger.atMe ? '，@了她' : ''}${trigger.exempt ? '，是她等的人（免@名单）' : ''}] ${trigger.text || ''}`,
    );
    const since = Number(state.sinceSelfSec);
    parts.push(
      '【她的状态】'
      + (Number.isFinite(since) ? `距上次发言 ${since} 秒；` : '还没说过话；')
      + `今天在这个群已发 ${Number(state.todayCount) || 0} 条`,
    );

    const t0 = Date.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), Math.max(500, Number(c.timeoutMs) || 3000));
    try {
      const res = await fetch(`${String(c.apiBase || 'http://127.0.0.1:7863/v1').replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        signal: ac.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: c.model || 'cn:deepseek-v4.1-flash',
          messages: [{ role: 'system', content: systems[kind === 'wait' ? 'wait' : 'wake'] }, { role: 'user', content: parts.join('\n\n') }],
          temperature: 0,

          ...(String(c.thinking ?? 'off') === 'on' ? {} : { thinking: { type: 'disabled' } }),

          max_tokens: Math.max(200, Number(c.maxTokens) || 900),
        }),
      });
      if (!res.ok) return { act: 'error', reason: `HTTP ${res.status}`, ms: Date.now() - t0 };
      const json = await res.json();
      const text = String(json?.choices?.[0]?.message?.content ?? '');
      const hit = text.match(/\{[\s\S]*\}/);
      if (!hit) return { act: 'error', reason: '没有 JSON', ms: Date.now() - t0, raw: text.slice(0, 120) };
      let obj = {};
      try {
        obj = JSON.parse(hit[0]);
      } catch {
        return { act: 'error', reason: 'JSON 解析失败', ms: Date.now() - t0, raw: hit[0].slice(0, 120) };
      }
      const act = String(obj.act ?? '');
      if (act !== 'reply' && act !== 'ignore' && act !== 'return' && act !== 'keep') {
        return { act: 'error', reason: `未知 act=${act}`, ms: Date.now() - t0 };
      }
      return { act, reason: String(obj.reason ?? '').slice(0, 40), ms: Date.now() - t0, usage: json.usage };
    } catch (error) {
      const aborted = error?.name === 'AbortError';
      return { act: aborted ? 'timeout' : 'error', reason: aborted ? '' : String(error?.message ?? error), ms: Date.now() - t0 };
    } finally {
      clearTimeout(timer);
      inflight -= 1;
    }
  }

  if (enabled()) refresh(cfg());

  return {
    decide,
    enabled,

    get mode() {
      return String(cfg().mode ?? 'off');
    },

    get ownerAlways() {
      return cfg().ownerAlways !== false;
    },

    get roleName() {
      return roleName;
    },

    get sysHash() {
      return hashes.wake;
    },

    hashOf(kind) {
      return hashes[kind === 'wait' ? 'wait' : 'wake'];
    },

    get cardChars() {
      return card.length;
    },
  };
}
