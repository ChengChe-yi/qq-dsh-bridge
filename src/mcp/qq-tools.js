#!/usr/bin/env node

import { McpServer, stderrLog } from './server.js';

const BRIDGE_URL = process.env.QQ_BRIDGE_API || 'http://127.0.0.1:3110/api';

const AUTH_PROPS = {
  key: {
    type: 'string',
    description: '会话 key，形如 group:100000000 或 private:100000001。'
      + '必须带前缀，且与提示词里给的完全一致。',
  },
  token: {
    type: 'string',
    description: '会话令牌，提示词里会给。与 key 配套，缺一个或对不上都会被拒绝。',
  },
};

function authSchema(extra = {}, required = []) {
  return {
    type: 'object',
    properties: { ...AUTH_PROPS, ...extra },
    required: ['key', 'token', ...required],
  };
}

function seqProp(description) {
  return { description, oneOf: [{ type: 'string' }, { type: 'number' }] };
}

function qqProp(description) {
  return { description, oneOf: [{ type: 'string' }, { type: 'number' }] };
}

function qqListProp(description) {
  return {
    description,
    oneOf: [
      { type: 'string' },
      { type: 'number' },
      { type: 'array', items: { oneOf: [{ type: 'string' }, { type: 'number' }] } },
    ],
  };
}

const BRIDGE_TIMEOUT_MS = Number(process.env.QQ_BRIDGE_TIMEOUT_MS) > 0
  ? Number(process.env.QQ_BRIDGE_TIMEOUT_MS)
  : 15 * 60 * 1000;

async function callBridge(op, args) {
  let res;
  const t0 = Date.now();
  try {
    res = await fetch(BRIDGE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op, args }),
      signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS),
    });
  } catch (error) {

    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    throw new Error(timedOut
      ? `桥接调用超时（${op}，等了 ${Math.round((Date.now() - t0) / 1000)} 秒）。`
        + '桥接可能在忙或卡住了 —— 稍后重试；如果是 qq_wait，说明这一轮等太久了。'
      : `连不上桥接（${BRIDGE_URL}）：${error.message}。确认桥接进程在运行。`);
  }

  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error(`桥接返回了非 JSON（HTTP ${res.status}）`);
  }

  if (!body.ok) {

    throw new Error(body.error || `桥接返回 HTTP ${res.status}`);
  }
  return body.result;
}

const server = new McpServer({
  name: 'qq-bridge',
  version: '0.1.0',
  instructions: 'QQ 群/私聊的工具面。所有工具都要传 key 与 token（提示词里会给）。'
    + '文本输出不会自动发到 QQ —— 要说话必须调 qq_send。',
});

server.tool('qq_unread', {
  description: '看未读概览：未读总数、按天分布、可用日期。'
    + '先看它，再决定要不要用 qq_read_chat 细查。',
  inputSchema: authSchema(),
}, async (args) => callBridge('unread', args));

const READ_FILTERS = {
  seq: {
    oneOf: [
      { type: 'integer', description: '精确匹配这个定位符' },
      { type: 'array', items: { type: 'integer' }, description: '区间 [起, 止]，含两端' },
    ],
    description: '按定位符取。给了区间就**按区间取全部**（区间自己限定了条数，此时 limit 无效）；'
      + '不给就走"从最新往回取 limit 条"。',
  },
  dates: {
    type: 'array', items: { type: 'string' },
    description: "限定日期，格式 'YYYY-MM-DD'；不传 = 全部已有记录。可用日期看 qq_unread 的 availableDates。",
  },
  unreadOnly: { type: 'boolean', description: '只看未读（等价于 readRounds: {eq: 0}）。' },
  readRounds: {
    type: 'object',
    description: '按"读过几轮"筛：{eq: 0} 未读、{min: 1} 读过的、{eq: 2} 读过两轮的。',
    properties: { eq: { type: 'integer' }, min: { type: 'integer' }, max: { type: 'integer' } },
  },
  sender: {
    oneOf: [
      { type: 'string', description: '一个 QQ 号' },
      { type: 'array', items: { type: 'string' }, description: '多个 QQ 号（任一命中即算）' },
    ],
    description: '发言者 QQ 号（纯数字无前缀）。可以给一个，也可以给数组。',
  },
  role: {
    type: 'string',
    enum: ['groupOwner', 'admin', 'member'],
    description: '发言者的群内身份：groupOwner 群主 / admin 群管理 / member 普通成员。'
      + '这里的 admin 是群里的管理员，与你自己的管理者无关。',
  },
  since: { type: 'integer', description: '起始时间，unix 秒（不是毫秒，也不是日期串）。' },
  until: { type: 'integer', description: '结束时间，unix 秒。' },
  contains: { type: 'string', description: '正文包含该子串即命中，大小写不敏感。只搜文字，不搜 [image] 这类标记。' },
  excludeRecalled: { type: 'boolean', default: false, description: '排除已撤回。默认 false（包含）—— 撤回本身也是信息。' },
  kinds: {
    type: 'array', items: { type: 'string' },
    description: '按消息类型筛：text / image / face / mixed / record / video / forward / json。',
  },
  limit: { type: 'integer', default: 50, description: '最多返回几条。默认 50；给了 seq 区间时无效。' },
  order: {
    type: 'string', enum: ['desc', 'asc'], default: 'desc',
    description: 'desc 最新在前（默认）/ asc 最早在前。',
  },
  raw: {
    type: 'boolean', default: false,
    description: '每条额外带原始 segments 数组（[{type, data}]），能拿到图片的 url/file/sub_type、'
      + '转发卡片的 id、@ 的完整 QQ 号。平时不用 —— segmentsText 已经够读。',
  },
};

server.tool('qq_read_chat', {
  description: '查聊天记录，返回 { messages, count, marked, unreadRemaining, availableDates }。'
    + '每条形如 { seq, time, sender: { qq, name, groupRole }, segmentsText, recalled?, quote? }。'
    + 'segmentsText 是正文的文本化写法：其中 [image:…] / [face:…] / [@你] / [reply:seq=…] / [recall] '
    + '是标记，不是文字。'
    + 'seq 是这条的定位符 —— 引用时填 qq_send 的 messages[].reply。'
    + '筛选条件都是"与"关系，能自由组合（某人 + 某时段 + 某关键词，或多人的某类消息）。'
    + '取条数只有两种：给了 seq 区间就按区间取全部；否则从最新往回取 limit 条。'
    + '默认不改已读状态。',
  inputSchema: authSchema(READ_FILTERS),
}, async (args) => callBridge('readChat', args));

const BUBBLE_PROPS = {
  reply: qqListProp('引用哪条：填定位符 seq（不是 messageId）。查不到就不引用 —— 引错比不引更糟。可给一个或数组。'),
  at: qqListProp('提醒谁（QQ 号）。只写给确实要收到提醒的人，不要无脑填上一条的发送者。可给一个或数组。'),
  text: { type: 'string', description: '正文。' },
  image: {
    type: 'object',
    description: '图片：url（上下文里出现过的图片地址，或 qq_get_message_images 给的本地短地址）'
      + '或 base64（自己渲染的图，如 latex_to_image 的返回）。二选一。',
    properties: {
      url: { type: 'string', description: '图片地址。' },
      base64: { type: 'string', description: 'base64 或 data URL。原样抄回，别改动或省略字符。' },
    },
  },
  sticker: { type: 'string', description: '收藏表情：ref / shortId（md5 前 8 位）/ 它的描述，三者都认。' },
  face: { type: 'integer', description: 'QQ 自带表情的 id（数字）。' },
  segments: {
    type: 'array',
    description: '完全自定义顺序的段落列表：每个元素只有一个键，取值 text / at / reply / image / sticker / face。'
      + '与属性式二选一，不能混用。',
    items: { type: 'object' },
  },
};

server.tool('qq_send', {
  description: '往当前会话发消息。这是唯一能让群里看到你说话的途径 —— 文本输出不会自动发送。'
    + 'messages 是数组，一个元素 = 一条气泡；每个元素二选一：属性式（reply / at / image / sticker / face / text，'
    + '按 reply → at → 媒体 → text 的固定顺序展开）或 segments（完全自定义顺序）。两者不能混在一条里。'
    + 'reply 与 at 是两件事：reply 说"我在回应哪条"，at 说"给谁推送提醒"，可以指向不同的人。'
    + 'reply 用定位符 seq，不是 QQ 的 messageId；@ 后面的空格系统会自动补。'
    + '多条时只给第一条加 reply / at —— 每条都带引用会刷出一片引用面板。'
    + 'QQ 不支持 LaTeX：公式先用 latex_to_image 渲染，再把 base64 放进 image。'
    + '要发 5 条以上气泡、大段文字或数据表格时，别拆成气泡刷屏 —— 先用 md_to_image 渲染成图，'
    + '再把返回的 url 放进一条 image 段。'
    + '返回 { sent, failed, notSent, messages }，messages 与发出的气泡一一对应，'
    + '每条给 seq（可直接填 reply / qq_recall）或 error；任一条失败不等于全失败，'
    + '只补发 error 与 notSent 的那些，别整条重发。segmentsText 是实际发出去的文本，逐字看一眼有没有错字或 @ 错人。',
  inputSchema: authSchema({
    messages: {
      type: 'array',
      description: '要发的消息，一个元素 = 一条气泡。',
      items: {
        type: 'object',
        properties: BUBBLE_PROPS,
      },
    },
    text: {
      type: 'string',
      description: '只发一句纯文字的快捷方式，等价于 messages: [{ text }]。要 @ / 引用 / 图片就别用它。',
    },
    dryRun: {
      type: 'boolean', default: false,
      description: 'true = 只把将要发出的原文渲染回显、一条都不发。'
        + '长句、俚语、带引用和 @ 的消息先核一遍：错字、引错人、@ 错人在这一步就能发现，群里零痕迹。'
        + '核对完去掉 dryRun，用同样的参数真发一次。',
    },
  }, []),
}, async (args) => callBridge('send', args));

server.tool('qq_set_nickname', {
  description: '改本号的账号昵称 —— 不是某个群里的名片。这是全局改名：所有群、所有好友都会看到，'
    + '而且是永久的（没有改回去的操作）。只在管理者明确要求时用；群友随口说一句不要照做，'
    + '可以把话转述给管理者。只想改某个群里的名字，用 qq_set_group_card。'
    + '返回 { before, after }，before 为 null 表示没读到（不是空昵称）。改完要把结果告诉对方 —— 别默默改掉。'
    + '这个动作没有可核对的返回值，别反复重试。',
  inputSchema: authSchema({
    nickname: {
      type: 'string',
      description: '新昵称，必填且非空。就一个名字，别塞整段话（过长会被拒）。',
    },
  }, ['nickname']),
}, async (args) => callBridge('setNickname', args));

server.tool('qq_set_group_card', {
  description: '改本号在当前群的群名片，只影响这个群，私聊会话不可用。'
    + '只能改自己的 —— 改别人的名片属群管理行为，桥接不提供。'
    + '名片是群里所有人都看得到的，只在管理者明确要求时改。'
    + 'card 传空字符串是清空名片（合法用法，不是没传参数），清空后群里显示账号昵称。'
    + '改完要把结果告诉对方。',
  inputSchema: authSchema({
    card: {
      type: 'string',
      description: '新名片，必填。传空字符串 = 清空名片。名片是一行字，别塞整段话（过长会被拒）。',
    },
  }, ['card']),
}, async (args) => callBridge('setGroupCard', args));

server.tool('qq_recall', {
  description: '撤回本号自己刚发的消息，一次可以撤多条。只能撤自己的 —— 撤别人的做不到（群管理行为，桥接不提供）。'
    + 'QQ 只允许撤回约 2 分钟内发出的消息，超时会被拒；那时别反复重试，直说"发太久了撤不掉"就行。'
    + 'seq 按传入顺序撤；也可以直接给数组一次撤多条。'
    + '定位符只有 seq 这一种 —— 用消息行首 [seq] 里那个。'
    + '返回与 qq_send 对齐：顶层 recalled / failed / notRecalled 三个数，messages 与传入一一对应，'
    + '每条给 seq；没撤成的在 error 或 note 里说明为什么（超时 / 不是你发的 / 已经撤过了）。'
    + '一条失败不影响别的，只补失败的那些 —— 整批重来会给已经撤掉的再报一次错。',
  inputSchema: authSchema({
    seq: {
      description: '要撤回那条的定位符（消息行首 [seq] 里那个，如 296094 或 1008#52）。'
        + '给数组就是一次撤多条。',
      oneOf: [
        { type: 'string' },
        { type: 'number' },
        { type: 'array', items: { oneOf: [{ type: 'string' }, { type: 'number' }] } },
      ],
    },
  }),
}, async (args) => callBridge('recall', args));

server.tool('qq_wait', {
  description: '在当前回合里等下一个触发（默认：有人 @ 你或引用你），等到就带着新消息返回，'
    + '到点没人就超时 —— 全程不重发上下文。'
    + 'qq 是免 @ 名单：填了的人不用 @ 你、不用引用你也算叫到你；不填则只认 @ 与引用。'
    + '它只是触发器，不影响 newMessages 的内容 —— 等待期间群里说的话照旧全给你。'
    + '等多久不由你决定：单次默认 5 分钟，本轮各次累计有上限，用完会返回 budgetExhausted。'
    + '超时是滑动的 —— 只要还有人说话就自动续期，不会在你们正聊着的时候硬断。'
    + '返回 { arrived, timeout, from, newMessages, omitted?, budgetExhausted?, waitedMs }。'
    + 'arrived 为真时 newMessages 是你还没见过的消息（除了叫你的那条，也含同段的群友消息）；'
    + '哪些是在说你，得你自己判断。timeout 不是错误。',
  inputSchema: authSchema({
    qq: qqListProp('免 @ 名单（QQ 号）。填了这些人，他们说话不用 @ 你就算叫到你。可给一个或数组；不填 = 只认 @ / 引用。'),
  }),
}, async (args) => callBridge('wait', args));

server.tool('qq_get_message_images', {
  description: '取某条消息里的图片，并作为图像交给模型 —— 上下文里只显示成 [image]，想知道是什么必须调它。'
    + '一次一张，一条消息有多张时用 index 选。'
    + '返回里附一个约 10 分钟有效的本地短地址，可放进 qq_send 的 image.url 转出去（别抄 base64）。'
    + '下载失败会把地址与原因一并给出 —— 那时直说看不到，别猜图里是什么。',
  inputSchema: authSchema({
    seq: seqProp('那条消息的定位符（消息行首 [seq] 里那个）。'),
    index: { type: 'integer', default: 0, description: '该消息里第几张图，从 0 起。默认 0。' },
  }, ['seq']),
}, async (args) => callBridge('getMessageImages', args));

server.tool('qq_list_stickers', {
  description: '列出可用的收藏表情：每条给 ref（完整 id）、shortId（md5 前 8 位）和描述。'
    + '描述是挑表情的关键线索，发送时 ref / shortId / 描述三者都认。'
    + '没有合适的就用 qq_sticker_collect 现收一张，描述起得不好用 qq_sticker_rename 改。',
  inputSchema: authSchema({
    limit: { type: 'integer', default: 50, description: '最多列几个。默认 50。' },
  }),
}, async (args) => callBridge('listStickers', args));

server.tool('qq_sticker_collect', {
  description: '把一张图收进表情库，之后可用 qq_send 的 sticker 段发出去。'
    + '收进来的是图片字节（落盘），不是会过期的 URL —— 所以第二天还能发。'
    + '图片来源二选一：seq（+ index 选第几张）走 QQ 图床下载；url 只接受本桥接发布的短地址，外网地址一律拒绝。'
    + 'desc 必填，而且它是日后挑表情的唯一依据，要写具体（"猫娘抱鱼"），别写"表情1"。'
    + '同一张图（md5 相同）再收一次不会重复，只更新描述。'
    + '返回 { replaced, id, shortId, desc, file }，拿到就能发。',
  inputSchema: authSchema({
    seq: seqProp('那条消息的定位符。与 url 二选一。'),
    index: { type: 'integer', default: 0, description: '那条消息里第几张图，从 0 起。默认 0。' },
    url: {
      type: 'string',
      description: '本桥接发布的图片短地址（qq_get_message_images / qq_get_forward 给出的那个）。'
        + '与 seq 二选一；外网地址一律拒绝 —— 那会变成一个抓取入口。',
    },
    desc: { type: 'string', description: '描述，必填。以后就靠它挑这张表情，写具体。' },
    tags: { type: 'array', items: { type: 'string' }, description: '标签，如 ["猫", "搞笑"]。可选。' },
    localNote: { type: 'string', description: '给自己看的备注，比如何时、谁发的。可选。' },
  }, ['desc']),
}, async (args) => callBridge('stickerCollect', args));

server.tool('qq_sticker_rename', {
  description: '改一条已收藏表情的描述 / 标签 / 备注，不动图片本身。'
    + '趁刚用过、记得它长什么样的时候改 —— 描述越具体越好用。'
    + 'ref 认 ref / shortId / 现有描述，与发送时同一套认法；desc / tags / localNote 至少给一个，'
    + 'tags 是整体替换而不是追加。'
    + '返回改前与改后的 desc。找不到时会列出库里最接近的几条。',
  inputSchema: authSchema({
    ref: { type: 'string', description: '要改哪条：ref（完整 id）/ shortId（md5 前 8 位）/ 它现有的描述。' },
    desc: { type: 'string', description: '新描述。不能改成空字符串。' },
    tags: { type: 'array', items: { type: 'string' }, description: '新的标签数组，整体替换。' },
    localNote: { type: 'string', description: '新的备注。' },
  }, ['ref']),
}, async (args) => callBridge('stickerRename', args));

server.tool('qq_get_forward', {
  description: '展开一条合并转发（QQ 的"聊天记录"卡片）里的内容 —— 它在上下文里只显示成 [forward]，'
    + '看不到里面说了什么。'
    + '返回每个节点的发言人与文本化正文；带 images 字段的节点就是那条里有图（值是张数）。'
    + '要看某个节点里的图，再调一次并传 index（从 0 起，对应返回里 messages 的下标），'
    + '那个节点有多张时用 imgIndex 选第几张 —— 图会作为图像给出，并附一个可放进 qq_send 的本地短地址。'
    + '取图失败不会让整次调用失败，会退回文本说明原因（图过期 / 下载失败）；那时别猜图里是什么。',
  inputSchema: authSchema({
    seq: seqProp('那条转发消息的定位符（消息行首 [seq] 里那个）。'),
    id: { type: 'string', description: 'forward 段的 id。一般不用 —— 直接传 seq 就行。' },
    index: {
      type: 'integer',
      description: '要看第几个节点里的图，从 0 起。不传就只列清单；传了就下载那个节点里的一张图。',
    },
    imgIndex: { type: 'integer', default: 0, description: '那个节点里的第几张图，从 0 起。默认 0。' },
  }),
}, async (args) => callBridge('getForwardMessages', args));

server.tool('qq_group_info', {
  description: '看当前群的信息：群号、群名、群备注（只有本号能看到的名字，可能和群名不同）、'
    + '当前人数与上限、群等级、建群时间、群简介，以及 allMuted（是否全员禁言 —— 禁言时你发得出去但没人能回）。'
    + '私聊会话不可用。',
  inputSchema: authSchema(),
}, async (args) => callBridge('groupInfo', args));

server.tool('qq_member_info', {
  description: '看某个群成员的资料：群名片、昵称、群内身份 groupRole、专属头衔 title、群等级 level、'
    + '入群时间 joinTime、最后发言时间 lastSentTime（判断还活跃吗）、禁言到期 mutedUntil、'
    + 'QQ 等级与号龄。'
    + '时间字段已是可读格式（2026-10-10 13:20），没值就是空串。'
    + '不提供"是不是机器人" —— 那个标记只认官方登记过的号，很多人拿自己的号跑 bot，给了反而误导。',
  inputSchema: authSchema({
    qq: qqProp('目标 QQ 号，纯数字无前缀。'),
  }, ['qq']),
}, async (args) => callBridge('memberInfo', args));

server.tool('qq_member_list', {
  description: '在群里筛人，不是把成员全列出来（大群上千人，列不完）。'
    + '返回 { total, matched, shown, members, note? }：total 是群里总人数，别把 members 当成全部人；'
    + 'members 每条的字段与 qq_member_info 相同。'
    + '排序决定你看到谁 —— 只给前 limit 条。',
  inputSchema: authSchema({
    role: {
      type: 'string',
      enum: ['groupOwner', 'admin', 'member'],
      description: '只看这个群内身份。查管理员用 admin，查群主用 groupOwner。这里说的是群里的身份，不是你的管理者。',
    },
    name: { type: 'string', description: '名字包含该子串即匹配 —— 群名片和昵称都搜，大小写不敏感。' },
    hasTitle: { type: 'boolean', description: '只列有专属头衔的（如「龙王」）。' },
    sort: {
      type: 'string', enum: ['active', 'joinTime', 'level'], default: 'active',
      description: 'active 最近发过言的在前（默认）/ joinTime 新入群的在前 / level 群等级高的在前。',
    },
    limit: { type: 'integer', default: 30, description: '最多几条。默认 30，上限 100。' },
  }),
}, async (args) => callBridge('memberList', args));

server.start();
stderrLog(`已启动，桥接地址 ${BRIDGE_URL}，暴露 ${server.listTools().length} 个工具`);
