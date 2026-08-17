import { setGateStatus } from '../lib/groupGate.js';

export default {
  name: 'o',
  description: 'تم الفتح',
  cooldown: 0,

  async execute(ctx) {
    const { msg, chatId, isGroup, reply } = ctx;
    if (!msg.key.fromMe) return;
    if (!isGroup) { await reply('اطلع من الخاص يعرص'); return; }

    await setGateStatus(chatId, 'open');
    await reply('تمت,رجعنا طبيعي');
  }
};
