export function stateConfig(chatlog) {
  return {
    trigger: { who: chatlog.triggerWho },
    window: { who: chatlog.windowWho },
    wakeLimit: chatlog.wakeLimit,
    replyLimit: chatlog.replyLimit,
    maxDays: chatlog.maxDays,
    maxChars: chatlog.maxChars,
    waitDefaultMs: chatlog.waitDefaultMs,

    waitMaxMs: chatlog.waitMaxMs,
    waitRequireMention: chatlog.waitRequireMention,

    idleMs: chatlog.idleMs,
  };
}
