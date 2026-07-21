export default {
  name: 'سكل',
  aliases: ['انهاء', 'stopall'],
  description: 'يوقف أي فعالية شغالة في الكروب (تع، كت، صور) ويظهر النتائج',
  cooldown: 3,

  async execute(ctx) {
    const { sock, chatId, store, reply } = ctx;
    let stoppedAny = false;

    const games = [
      { id: 'katGame', name: 'كت/تفكيك' },
      { id: 'ta3Game', name: 'تع/3' },
      { id: 'picGame', name: 'الصور' },
      { id: 'ssGame', name: 'س/سس' }
    ];

    for (const game of games) {
      const state = store.namespace(game.id).get(chatId);

      if (state) {
        store.namespace(game.id).delete(chatId);
        stoppedAny = true;

        const leaderboard = Object.entries(state.scores || {}).sort((a, b) => b[1] - a[1]);
        let resultText = `تم إيقاف فعالية *${game.name}*\n`;

        if (leaderboard.length === 0) {
          resultText += '\nلم يسجل أحد أي نقطة.';
          await sock.sendMessage(chatId, { text: resultText });
        } else {
          const lines = leaderboard.map(([jid, pts], i) => `${i + 1}. @${jid.split('@')[0]} - ${pts}`);
          const mentions = leaderboard.map(([jid]) => jid);
          resultText += `\nالنتائج النهائية:\n${lines.join('\n')}`;

          await sock.sendMessage(chatId, { text: resultText, mentions });
        }
      }
    }

    if (!stoppedAny) {
      await reply('لا توجد أي فعاليات شغالة حالياً لإيقافها.');
    }
  }
};
