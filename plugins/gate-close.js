import { setGateStatus } from '../lib/groupGate.js';
import { stopAllGamesWithReport } from '../lib/games.js';

export default {
  name: 'c',
  description: 'مالك البوت فقط — يقفل كل الألعاب بهاد الكروب (الملصقات بتضل شغالة)',
  cooldown: 0,

  async execute(ctx) {
    const { msg, chatId, isGroup, reply } = ctx;
    if (!msg.key.fromMe) return;
    if (!isGroup) { await reply('برا الخاص يعرص ا'); return; }

    await stopAllGamesWithReport(ctx);
    await setGateStatus(chatId, 'closed');
    await reply('كاكككككك تم التقفيللللللل');
  }
};
