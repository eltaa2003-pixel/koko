import { getSpeedLeaderboardText } from '../lib/playerStats.js';

const GAMES = [
  ['كت', 'كت'],
  ['تفكيك', 'تفكيك'],
  ['تع', 'تع'],
  ['سس', 'سس'],
  ['صور', 'الصور'],
  ['عكس', 'عكس'],
  ['عكس تفكيك', 'عكس تفكيك'],
  ['مكرر', 'مقالة (مكرر)']
];

export default {
  name: 'توب',
  description: 'يعرض أفضل 3 لاعبين في كل الألعاب',
  cooldown: 5,

  async execute(ctx) {
    const sections = [];
    const allMentions = new Set();

    for (const [game, displayName] of GAMES) {
      const result = await getSpeedLeaderboardText(game, displayName);
      if (!result) continue;

      sections.push(result.text);
      result.mentions.forEach(m => allMentions.add(m));
    }

    if (!sections.length) {
      await ctx.reply('لا توجد بيانات كافية لعرض المتصدرين بعد.');
      return;
    }

    await ctx.sock.sendMessage(ctx.chatId, {
      text: sections.join('\n\n━━━━━━━━━━━━━━\n\n'),
      mentions: Array.from(allMentions)
    });
  }
};