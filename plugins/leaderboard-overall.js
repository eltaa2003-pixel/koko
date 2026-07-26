import { getOverallLeaderboardText } from '../lib/playerStats.js';

const GAMES = [
  ['كت', 'كت'],
  ['تفكيك', 'تفكيك'],
  ['تع', 'تع'],
  ['سس', 'سس'],
  ['صور', 'الصور']
];

export default {
  name: 'الافضل',
  description: 'يعرض الأفضل (متوسط وقت الرد وعدد الكلمات بالدقيقة) في كل لعبة',
  cooldown: 5,

  async execute(ctx) {
    const sections = [];
    const allMentions = new Set();

    for (const [game, displayName] of GAMES) {
      const result = await getOverallLeaderboardText(game, displayName);
      if (!result) continue;
      sections.push(result.text);
      result.mentions.forEach(m => allMentions.add(m));
    }

    if (!sections.length) {
      await ctx.reply('لا توجد بيانات كافية بعد.');
      return;
    }

    await ctx.sock.sendMessage(ctx.chatId, {
      text: sections.join('\n\n━━━━━━━━━━━━━━\n\n'),
      mentions: Array.from(allMentions)
    });
  }
};
