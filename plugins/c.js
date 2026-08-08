const CHECK_TTL_NS = 30n * 60n * 1000000000n;

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

async function getCachedResult(store, number) {
  const entry = store.get(number);
  if (!entry) return null;
  if (BigInt(process.hrtime.bigint()) - BigInt(entry.checkedAt) > CHECK_TTL_NS) {
    store.delete(number);
    return null;
  }
  return entry.exists;
}

async function setCachedResult(store, number, exists) {
  store.set(number, { exists, checkedAt: Number(process.hrtime.bigint()) });
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

    const checkStore = ctx.store.namespace('waChecks');
    const fresh = [];
    const cached = [];
    const registered = [];
    const unregistered = [];

    for (const num of numbers) {
      const cachedResult = await getCachedResult(checkStore, num);
      if (cachedResult !== null) {
        cached.push(num);
        if (cachedResult) registered.push(num);
        else unregistered.push(num);
      } else {
        fresh.push(num);
      }
    }

    for (const num of fresh) {
      const exists = await checkNumber(ctx.sock, num);
      await setCachedResult(checkStore, num, exists);
      if (exists) registered.push(num);
      else unregistered.push(num);
    }

    const fmt = (arr) => arr.map(n => `+${n}`).join('\n');

    const lines = [];
    if (fresh.length) lines.push(`فحص جديد (${fresh.length}):\n${fmt(fresh)}`);
    if (cached.length) lines.push(`محفوظ مسبقاً (${cached.length}):\n${fmt(cached)}`);

    if (!registered.length && !unregistered.length) {
      await ctx.reply('لا توجد أرقام للعرض.');
      return;
    }

    if (!unregistered.length) {
      await ctx.reply(`جميع الأرقام مسجلة في واتساب (${registered.length}):\n\n${lines.join('\n\n')}`);
      return;
    }

    if (!registered.length) {
      await ctx.reply(`لا توجد أرقام مسجلة (${unregistered.length}):\n\n${lines.join('\n\n')}`);
      return;
    }

    await ctx.reply(
      `مسجلة (${registered.length}):\n${fmt(registered)}\n\n` +
      `غير مسجلة (${unregistered.length}):\n${fmt(unregistered)}\n\n` +
      lines.join('\n\n')
    );
  }
};
