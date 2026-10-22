export function attachPoolFeed(store, pool) {
  if (!store || typeof store.on !== 'function') {
    throw new TypeError('attachPoolFeed: 第一个参数要是 ChatStore（得能 on/off）');
  }
  if (!pool || typeof pool.addMessage !== 'function') {
    throw new TypeError('attachPoolFeed: 第二个参数要是 TurnPool');
  }

  const onAppended = ({ message } = {}) => {
    if (message) pool.addMessage(message);
  };

  store.on('appended', onAppended);
  return () => store.off('appended', onAppended);
}
