const MAX_HISTORY = 12;

export function makeRecentTracker() {
  const byChat = new Map();

  return {
    getExcluded(chatId) {
      return new Set(byChat.get(chatId) || []);
    },
    record(chatId, normalizedKeys) {
      const list = byChat.get(chatId) || [];
      list.push(...normalizedKeys);
      while (list.length > MAX_HISTORY) list.shift();
      byChat.set(chatId, list);
    }
  };
}
