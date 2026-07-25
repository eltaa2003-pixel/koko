import { getLeaderboardText } from '../lib/playerStats.js';

const GAME_MAP = {
  'متصدرينكت': ['كت', 'كت'],
  'متصدرينتف': ['تفكيك', 'تفكيك'],
  'متصدرينتع': ['تع', 'تع'],
  'متصدرينسس': ['سس', 'سس'],
  'متصدرينصور': ['صور', 'الصور']
};

export default {
  name: 'متصدرينكت',
  aliases: Object.keys(GAME_MAP).slice(1),
  description: 'يعرض أفضل 3 لاعبين في لعبة معينة',
  cooldown: 3,

  async execute(ctx) {
    const [game, displayName] = GAME_MAP[ctx.command] || GAME_MAP['متصدرينكت'];
    const result = await getLeaderboardText(game, displayName);

    if (!result) {
      await ctx.reply(`لا توجد بيانات كافية لعرض المتصدرين في *${displayName}* بعد.`);
      return;
    }

    await ctx.sock.sendMessage(ctx.chatId, { text: result.text, mentions: result.mentions });
  }
};