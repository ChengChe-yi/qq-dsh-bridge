export const op = 'recall';
export const needsAllow = true;
export const logsAsSend = true;

import { seqOf } from '../../chatlog/store.js';

function targetsOf(args) {
  const out = [];
  const push = (v) => {
    if (v === undefined || v === null || v === '') return;
    if (Array.isArray(v)) { for (const one of v) push(one); return; }
    out.push({ kind: 'seq', value: v });
  };
  push(args?.seq);

  if (!out.length) {

    const hint = args?.messageId !== undefined
      ? '（`messageId` 已不再接受 —— 它从来不给你，定位符只有 `seq`。）'
      : '';
    throw new Error(`要撤哪条？传 \`seq\`（消息行首 [seq] 里那个）；要撤多条就传数组，如 \`seq: [296094, 296095]\`。${hint}`);
  }
  return out;
}

export async function run({ registry, http, logger }, convKey, args) {
  const conv = registry.get(convKey);

  const pool = conv.turnPool;

  const selfQq = pool.selfQq;

  const targets = targetsOf(args);
  const results = [];

  const recallOne = async ({ value }) => {
    const label = `seq=${value}`;

    let found = null;
    try {
      found = pool.find(value);
    } catch (error) {
      return { seq: value, error: `按 ${label} 查消息出错：${error?.message ?? error}` };
    }
    if (!found) {
      return {
        seq: value,
        notRecalled: true,
        error: `按 ${label} 找不到这条消息 —— 不在近期窗口里（多半已经超过撤回时限）。`,
      };
    }

    const target = { ...found.message, date: found.date };
    const key = seqOf(target, target.date);

    if (target.state?.recalled) {
      return { seq: key, recalled: 0, note: '这条**已经被撤回过**了，不用再撤。' };
    }
    if (!target.messageId) {
      return { seq: key, notRecalled: true, error: '没有 message_id（可能是老数据），撤不了。' };
    }

    const who = String(target.sender?.qq ?? '');
    if (selfQq === '') {
      return { seq: key, notRecalled: true, error: '不知道本号（selfQq 为空），无法确认这条是不是你发的，拒绝撤回。' };
    }
    if (who !== selfQq) {
      return {
        seq: key,
        notRecalled: true,
        error: `是${target.sender?.name || who}发的，**不是你发的** —— 只能撤回自己的消息。`
          + '（撤回别人的属于群管理行为，本桥接不提供。）',
      };
    }

    try {
      await http.deleteMessage(target.messageId);
    } catch (error) {

      const raw = String(error?.message ?? error);
      const tooLate = /retcode/.test(raw) || /time|超时|过期|expire/i.test(raw);
      return {
        seq: key,
        notRecalled: true,
        error: raw + (tooLate ? '（多半是超过 2 分钟撤回时限了 —— 别再重试这条。）' : ''),
      };
    }

    logger.info('已撤回自己的消息', { conv: convKey, seq: key, msgId: target.messageId });
    return { seq: key, recalled: 1 };
  };

  for (const t of targets) results.push(await recallOne(t));

  const count = (k) => results.filter((r) => r[k] === 1).length;
  const recalled = count('recalled');
  const failed = results.filter((r) => r.error).length;
  const notRecalled = results.filter((r) => r.notRecalled).length;

  if (results.length === 1) {
    const one = results[0];
    const base = { recalled: one.recalled ?? 0, seq: one.seq, messages: results };
    if (one.error) return { ...base, failed: 1, notRecalled: 1 };
    if (one.note) return { ...base, note: one.note };
    return {
      ...base,
      failed: 0,
      notRecalled: 0,
      note: '撤掉了。注意 QQ 只允许撤回约 2 分钟内发出的消息 —— 这条赶上了。',
    };
  }

  return {
    recalled,
    failed,
    notRecalled,
    messages: results,
    note: recalled === results.length
      ? `全部撤掉了（${recalled} 条）。`
      : `撤掉 ${recalled} 条，没撤 ${results.length - recalled} 条 —— 原因写在各自的 error / note 里；`
        + '只补那些失败的，别整批重来（成功的再撤一次会报"已撤回"）。',
  };
}
