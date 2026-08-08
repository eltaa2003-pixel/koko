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

    const numbers = [...new Set(extractNumbers(sourceText))];
    if (!numbers.length) {
      await ctx.reply('لم يتم العثور على أرقام صالحة في الرسالة.');
      return;
    }

    await ctx.reply(`جاري فحص ${numbers.length} رقم...`);

    const registered = [];
    const unregistered = [];
    for (const num of numbers) {
      const exists = await checkNumber(ctx.sock, num);
      if (exists) registered.push(num);
      else unregistered.push(num);
    }

    const fmt = (arr) => arr.map(n => `+${n}`).join('\n');

    if (!registered.length && !unregistered.length) {
      await ctx.reply('لا توجد أرقام للعرض.');
      return;
    }

    if (!unregistered.length) {
      await ctx.reply(`جميع الأرقام مسجلة في واتساب (${registered.length}):\n\n${fmt(registered)}`);
      return;
    }

    if (!registered.length) {
      await ctx.reply(`لا توجد أرقام مسجلة (${unregistered.length}):\n\n${fmt(unregistered)}`);
      return;
    }

    await ctx.reply(
      `مسجلة (${registered.length}):\n${fmt(registered)}\n\n` +
      `غير مسجلة (${unregistered.length}):\n${fmt(unregistered)}`
    );
  }
};
