function extractNumbers(text) {
  if (!text) return [];
  const matches = text.match(/\+?[\d\s\-\(\)]{7,20}/g) || [];
  return matches
    .map(n => n.replace(/[\s\-\(\)]/g, '').replace(/^\+/, ''))
    .filter(n => /^\d{7,15}$/.test(n));
}

async function checkNumber(sock, number) {
  try {
    const result = await sock.onWhatsApp(`${number}@s.whatsapp.net`);
    return result[0]?.exists || false;
  } catch (err) {
    console.error(`check error for ${number}:`, err);
    return false;
  }
}

export default {
  name: 'c',
  aliases: ['check', 'تحقق'],
  description: 'التحقق من الأرقام المسجلة في واتساب (رد على رسالة تحتوي أرقام)',
  cooldown: 10,

  async execute(ctx) {
    if (!ctx.msg.message?.extendedTextMessage?.contextInfo?.quotedMessage) {
      await ctx.reply('رد على رسالة تحتوي أرقام لفحصها.');
      return;
    }

    const quoted = ctx.msg.message.extendedTextMessage.contextInfo.quotedMessage;
    const sourceText = quoted.conversation || quoted.extendedTextMessage?.text || '';

    const numbers = extractNumbers(sourceText);
    if (!numbers.length) {
      await ctx.reply('لم يتم العثور على أرقام صالحة في الرسالة.');
      return;
    }

    await ctx.reply(`جاري فحص ${numbers.length} رقم...`);

    const unregistered = [];
    for (const num of numbers) {
      const exists = await checkNumber(ctx.sock, num);
      if (!exists) unregistered.push(num);
    }

    if (!unregistered.length) {
      await ctx.reply('جميع الأرقام مسجلة في واتساب.');
      return;
    }

    await ctx.reply(`الأرقام غير المسجلة (${unregistered.length}):\n\n${unregistered.map(n => `+${n}`).join('\n')}`);
  }
};
