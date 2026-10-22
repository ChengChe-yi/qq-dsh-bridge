const ROLE_REMINDER = (name) => `【当前角色】${name}（角色卡全文可用工具随时取回）`;

const DEFAULT_OWNER_TITLE = '管理员';

export function buildPrompt({
  key,
  token,
  role,
  delivery,
  label,
  triggerBy,
  woke,
  waiting = false,

  ownerTitle = '',
  ownerQq = '',

  selfQq = '',
}) {
  const parts = [];

  const bits = [];
  bits.push(woke === false ? '你还在这个群里（刚才也在聊）' : '你刚打开这个群（之前不在）');
  if (waiting) bits.push('你正在等待新消息');
  if (typeof delivery?.remainingUnread === 'number') {
    bits.push(delivery.remainingUnread > 0
      ? `另有 ${delivery.remainingUnread} 条未读（比下面这段更早）`
      : '没有更早的未读');
  }
  if (delivery?.span?.crossDay) {
    bits.push(`下面这段跨天（${delivery.span.from} → ${delivery.span.to}）`);
  }
  parts.push(`【此刻状态】${bits.join('；')}`);

  let triggerLine = `【群里刚发生】${label}`;
  if (triggerBy?.name || triggerBy?.qq) {
    triggerLine += `（${triggerBy.name || triggerBy.qq}，${triggerBy.qq}）`;
  }

  triggerLine += '（回不回随你）';
  parts.push(triggerLine);

  if (delivery?.triggerLine) {
    parts.push(`【被提到的那条】（它不在下面这段里）\n${delivery.triggerLine}`);
  }

  if (delivery?.context?.text) {
    const c = delivery.context;

    let block = `【最近消息】以下是最新 ${c.count} 条（时间从旧到新）：\n`
      + '（读之前先扫一眼：有没有哪个词按字面读不对劲？可疑就在心里试一遍同音字 —— 试不出来就不接，也别硬给一个解释。）\n'
      + c.text;
    if (c.truncated) block += '\n（太长，只给了最新的这些；更早的用 readChat 往前查）';
    block += '\n**这只是最近一段**：需要更早的用 readChat 工具往前查（可按时间、发言者、未读轮次筛）。';
    parts.push(block);
  }

  if (key && token) {
    parts.push(
      `【本会话】key：${key}\n令牌：${token}\n`
      + '调用任何 qq_* 工具都要**同时**带上这两个：`key` 传上面那个 key，'
      + '`token` 传令牌。缺一个都会被拒绝。',
    );
  }

  return parts.join('\n\n');
}

export function decideRole({
  cardText = '',
  roleName = '',
  mode = 'changed',
  refreshMs = 1_800_000,
  lastKey = '',
  cardKey = '',
  lastSentAt = 0,
  now = Date.now(),
} = {}) {
  if (!cardText) return { text: '', mode: 'none', nextKey: lastKey, nextSentAt: lastSentAt };

  if (mode === 'always') return { text: cardText, mode: 'full', nextKey: cardKey, nextSentAt: now };
  if (mode === 'never') {
    return { text: roleName ? ROLE_REMINDER(roleName) : '', mode: 'remind', nextKey: lastKey, nextSentAt: lastSentAt };
  }

  const changed = cardKey !== '' && cardKey !== lastKey;
  const expired = refreshMs > 0 && (!lastSentAt || now - Number(lastSentAt) > refreshMs);
  if (changed || expired || !lastSentAt) {
    return { text: cardText, mode: 'full', nextKey: cardKey, nextSentAt: now };
  }

  return {
    text: roleName ? ROLE_REMINDER(roleName) : '',
    mode: 'remind',
    nextKey: lastKey,
    nextSentAt: lastSentAt,
  };
}
