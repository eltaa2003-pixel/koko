const CHECK_TTL_NS = 30n * 60n * 1000000000n;
const BATCH_SIZE = 100;
const BATCH_DELAY_MS = 2000;

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

async function getHistory(store, number) {
  return store.get(number) || null;
}

async function recordCheck(store, number, exists) {
  const prev = store.get(number);
  const entry = {
    exists,
    checkedAt: Number(process.hrtime.bigint()),
    count: (prev?.count || 0) + 1
  };
  store.set(number, entry);
  return entry;
}

function formatDuration(ns) {
  const hours = Number(ns / 3600000000000n);
  if (hours < 1) return 'أقل من ساعة';
  if (hours === 1) return 'ساعة واحدة';
  if (hours < 24) return `${hours} ساعات`;
  const days = Math.floor(hours / 24);
  const rem = hours % 24;
  if (!rem) return days === 1 ? 'يوم واحد' : `${days} أيام`;
  return `${days} يوم و ${rem} ساعة`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
    const rawNumbers = extractNumbers(sourceText);
    const numbers = [...new Set(rawNumbers)];

    if (!numbers.length) {
      await ctx.reply('لم يتم العثور على أرقام صالحة في الرسالة.');
      return;
    }

    const totalBatches = Math.ceil(numbers.length / BATCH_SIZE);
    await ctx.reply(`تم العثور على ${numbers.length} رقم (${totalBatches} دفعة). جاري الفحص...`);

    const historyStore = ctx.store.namespace('waCheckHistory');
    const now = BigInt(process.hrtime.bigint());
    const COOLDOWN_NS = 24n * 3600000000000n;

    const allRegistered = [];
    const allUnregistered = [];
    const allFresh = [];
    const allPreviouslyChecked = [];
    const recentlyTried = [];

    for (let i = 0; i < numbers.length; i += BATCH_SIZE) {
      const batch = numbers.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;

      if (batchNum > 1) {
        await ctx.reply(`الدفعة ${batchNum - 1}/${totalBatches} مكتملة. جاري الدفعة ${batchNum}/${totalBatches}...`);
        await sleep(BATCH_DELAY_MS);
      }

      for (const num of batch) {
        const history = await getHistory(historyStore, num);
        if (history) {
          allPreviouslyChecked.push({ num, history });
          if (history.exists) allRegistered.push(num);
          else {
            allUnregistered.push(num);
            const age = now - BigInt(history.checkedAt);
            if (age < COOLDOWN_NS) {
              recentlyTried.push({ num, history, remaining: COOLDOWN_NS - age });
            }
          }
        } else {
          allFresh.push(num);
          const exists = await checkNumber(ctx.sock, num);
          await recordCheck(historyStore, num, exists);
          if (exists) allRegistered.push(num);
          else {
            allUnregistered.push(num);
            recentlyTried.push({ num, history: { exists, checkedAt: Number(process.hrtime.bigint()), count: 1 }, remaining: COOLDOWN_NS });
          }
        }
      }
    }

    await ctx.reply(`اكتمل الفحص! جاري تجميع النتائج...`);

    const fmt = (arr) => arr.map(n => `+${n}`).join('\n');

    const lines = [];
    if (allFresh.length) lines.push(`أرقام جديدة لم يُفحصها أحد من قبل (${allFresh.length}):\n${fmt(allFresh)}`);
    if (allPreviouslyChecked.length) {
      const detail = allPreviouslyChecked.map(({ num, history }) => {
        const age = now - BigInt(history.checkedAt);
        const suffix = !history.exists && age < COOLDOWN_NS ? ` ⚠️ ${formatDuration(COOLDOWN_NS - age)} متبقي` : '';
        return `+${num} (${history.count} فحص${suffix})`;
      }).join('\n');
      lines.push(`أرقام تم فحصها سابقاً (${allPreviouslyChecked.length}):\n${detail}`);
    }

    if (!allRegistered.length && !allUnregistered.length) {
      await ctx.reply('لا توجد أرقام للعرض.');
      return;
    }

    const header = [];
    if (allRegistered.length) header.push(`مسجلة (${allRegistered.length}):\n${fmt(allRegistered)}`);
    if (allUnregistered.length) {
      const suffix = recentlyTried.length ? `\n⚠️ الأرقام المُعلَّمة تحتاج 24 ساعة على الأقل قبل المحاولة مجدداً` : '';
      header.push(`غير مسجلة (${allUnregistered.length}):\n${fmt(allUnregistered)}${suffix}`);
    }

    const body = [header.join('\n\n')];
    if (lines.length) body.push(lines.join('\n\n'));

    await ctx.reply(body.filter(Boolean).join('\n\n'));
  }
};
