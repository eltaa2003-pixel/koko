export const GAME_REGISTRY = [
  { id: 'katGame', name: 'كت' },
  { id: 'tafkikGame', name: 'تفكيك' },
  { id: 'tournamentGame', name: 'بطولة' },
  { id: 'ta3Game', name: 'تع/3' },
  { id: 'picGame', name: 'الصور' },
  { id: 'ssGame', name: 'س/سس' },
  { id: 'reverseGame', name: 'عكس' },
  { id: 'reverseTafkikGame', name: 'عكس تفكيك' }
];

export async function stopAllGamesWithReport(ctx) {
  const { sock, chatId, store } = ctx;

  for (const game of GAME_REGISTRY) {
    const state = store.namespace(game.id).get(chatId);
    if (!state) continue;

    store.namespace(game.id).delete(chatId);

    const leaderboard = Object.entries(state.scores || {}).sort((a, b) => b[1] - a[1]);
    if (!leaderboard.length) {
      await sock.sendMessage(chatId, { text: `تم إيقاف *${game.name}* لبدء نشاط جديد.\nلم يسجل أحد أي نقطة.` }).catch(() => {});
      continue;
    }

    const lines = leaderboard.map(([jid, pts], i) => `${i + 1}. @${jid.split('@')[0]} - ${pts}`);
    const mentions = leaderboard.map(([jid]) => jid);
    await sock.sendMessage(chatId, {
      text: `تم إيقاف *${game.name}* لبدء نشاط جديد.\n\nالنتائج النهائية:\n${lines.join('\n')}`,
      mentions
    }).catch(() => {});
  }
}
