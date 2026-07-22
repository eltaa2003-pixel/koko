import fs from 'node:fs';
import path from 'node:path';

const GAME_DATA_PATH = path.resolve('plugins/game-data.json');

function loadGameData() {
  try {
    const raw = fs.readFileSync(GAME_DATA_PATH, 'utf-8');
    const data = JSON.parse(raw);
    return data['سس'] || [];
  } catch (err) {
    console.error('Error loading game-data.json:', err);
    return [];
  }
}

const SS_POOL = loadGameData();

function normalizeText(text) {
  if (!text) return '';
  return text
    .trim()
    .replace(/[\u200B-\u200F\uFEFF]/g, '')
    .replace(/\u0640/g, '')
    .replace(/[\u064B-\u0652]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ۃ/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[یے]/g, 'ي')
    .replace(/ک/g, 'ك')
    .replace(/ہ/g, 'ه')
    .replace(/[جغق]/g, 'ج')
    .replace(/\s+/g, ' ');
}

export function getRandomQuestion() {
  if (!SS_POOL.length) return null;
  return SS_POOL[Math.floor(Math.random() * SS_POOL.length)];
}

export function buildAnswerData(answersRaw) {
  const isGrouped = Array.isArray(answersRaw) && answersRaw.length > 0 && Array.isArray(answersRaw[0]);
  const slots = isGrouped ? answersRaw : [answersRaw];

  const lookup = new Map();
  let maxWords = 1;
  slots.forEach((variants, slotIndex) => {
    for (const v of variants) {
      const words = normalizeText(v).split(' ').filter(Boolean);
      if (!words.length) continue;
      lookup.set(words.join(' '), slotIndex);
      if (words.length > maxWords) maxWords = words.length;
    }
  });

  return { lookup, maxWords, slotCount: slots.length };
}

export function getDisplayAnswers(answersRaw) {
  const isGrouped = Array.isArray(answersRaw) && answersRaw.length > 0 && Array.isArray(answersRaw[0]);
  const slots = isGrouped ? answersRaw : [answersRaw];
  return slots.map(variants => variants[0]).join(' ， ');
}

const registeredSocks = new WeakSet();

function ensureGlobalListener(ctx) {
  if (registeredSocks.has(ctx.sock)) return;
  registeredSocks.add(ctx.sock);

  ctx.sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify' && type !== 'append') return;

    for (const m of messages) {
      if (!m.message || m.key.fromMe) continue;

      const chatId = m.key.remoteJid;

      const pendingHandled = await handlePendingAdd(ctx, chatId, null, m);
      if (pendingHandled) continue;

      const state = ctx.store.namespace('ssGame').get(chatId);
      if (!state) continue;

      state.queue = state.queue
        .then(() => processMessage(ctx, chatId, state, m))
        .catch(err => console.error('سس game processing error:', err));
    }
  });
}

export function pushHistory(ctx, chatId, questionSnapshot) {
  const historyStore = ctx.store.namespace('ssHistory');
  const history = historyStore.get(chatId) || [];
  history.push(questionSnapshot);
  if (history.length > 5) history.shift();
  historyStore.set(chatId, history);
}

async function handlePendingAdd(ctx, chatId, state, m) {
  const pendingStore = ctx.store.namespace('ssPendingAdd');
  const senderJid = m.key.participant || m.key.remoteJid;
  const pending = pendingStore.get(senderJid);
  if (!pending) return false;

  if (Date.now() - pending.timestamp > 120000) {
    pendingStore.delete(senderJid);
    await ctx.sock.sendMessage(chatId, { text: 'انتهت مهلة الإضافة. أرسل .ضف مجدداً إذا أردت.' }, { quoted: m }).catch(() => {});
    return true;
  }

  const text = m.message?.conversation || m.message?.extendedTextMessage?.text || '';
  if (!text) return true;

  if (pending.step === 1) {
    const num = parseInt(text.trim(), 10);
    if (!Number.isInteger(num) || num < 1 || num > pending.snapshots.length) {
      await ctx.sock.sendMessage(chatId, { text: `أرسل رقماً بين 1 و ${pending.snapshots.length}` }, { quoted: m }).catch(() => {});
      return true;
    }
    const chosen = pending.snapshots[num - 1];
    const isGrouped = Array.isArray(chosen.answersRaw) && chosen.answersRaw.length > 0 && Array.isArray(chosen.answersRaw[0]);
    if (isGrouped) {
      await ctx.sock.sendMessage(chatId, { text: 'عذراً، لا يمكن إضافة إجابات لأسئلة سس متعددة الخانات حالياً.' }, { quoted: m }).catch(() => {});
      pendingStore.delete(senderJid);
      return true;
    }
    pendingStore.set(senderJid, {
      step: 2,
      snapshot: chosen,
      timestamp: Date.now()
    });
    await ctx.sock.sendMessage(chatId, { text: `تم اختيار: ${chosen.question}\n\nأرسل الأسماء الجديدة مفصولة بفاصلة (مثال: اسم1، اسم2، اسم3)` }, { quoted: m }).catch(() => {});
    return true;
  }

  if (pending.step === 2) {
    const newAnswers = text.split(',').map(s => s.trim()).filter(Boolean);
    if (!newAnswers.length) {
      await ctx.sock.sendMessage(chatId, { text: 'أرسل اسم واحد على الأقل مفصول بفاصلة.' }, { quoted: m }).catch(() => {});
      return true;
    }

    let data;
    try {
      const raw = fs.readFileSync(GAME_DATA_PATH, 'utf-8');
      data = JSON.parse(raw);
    } catch (err) {
      await ctx.sock.sendMessage(chatId, { text: 'حدث خطأ أثناء قراءة ملف البيانات.' }, { quoted: m }).catch(() => {});
      pendingStore.delete(senderJid);
      return true;
    }

    const entry = (data['سس'] || []).find(q => q.question === pending.snapshot.question);
    if (!entry) {
      await ctx.sock.sendMessage(chatId, { text: 'لم يتم العثور على السؤال في ملف البيانات.' }, { quoted: m }).catch(() => {});
      pendingStore.delete(senderJid);
      return true;
    }

    const poolEntry = SS_POOL.find(q => q.question === pending.snapshot.question);
    if (!poolEntry) {
      await ctx.sock.sendMessage(chatId, { text: 'لم يتم العثور على السؤال في الذاكرة.' }, { quoted: m }).catch(() => {});
      pendingStore.delete(senderJid);
      return true;
    }

    const seen = new Set();
    const deduped = [];
    for (const ans of newAnswers) {
      const key = normalizeText(ans);
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(ans);
      }
    }

    for (const ans of deduped) {
      const key = normalizeText(ans);
      if (!entry.answers.some(a => normalizeText(a) === key)) entry.answers.push(ans);
      if (!poolEntry.answers.some(a => normalizeText(a) === key)) poolEntry.answers.push(ans);
    }

    const liveState = ctx.store.namespace('ssGame').get(chatId);
    if (liveState && liveState.currentQuestion === pending.snapshot.question) {
      for (const ans of deduped) {
        const words = normalizeText(ans).split(' ').filter(Boolean);
        if (!words.length) continue;
        const key = words.join(' ');
        if (!liveState.answerData.lookup.has(key)) {
          liveState.answerData.lookup.set(key, 0);
          if (words.length > liveState.answerData.maxWords) liveState.answerData.maxWords = words.length;
          liveState.answersRaw.push(ans);
        }
      }
    }

    try {
      fs.writeFileSync(GAME_DATA_PATH, JSON.stringify(data, null, 2));
    } catch (err) {
      await ctx.sock.sendMessage(chatId, { text: 'حدث خطأ أثناء كتابة ملف البيانات.' }, { quoted: m }).catch(() => {});
      pendingStore.delete(senderJid);
      return true;
    }

    pendingStore.delete(senderJid);
    await ctx.sock.sendMessage(chatId, { text: `تمت إضافة ${newAnswers.length} إجابة جديدة إلى "${pending.snapshot.question}".` }, { quoted: m }).catch(() => {});
    return true;
  }

  pendingStore.delete(senderJid);
  return true;
}

async function processMessage(ctx, chatId, state, m) {
  const store = ctx.store.namespace('ssGame');
  if (store.get(chatId) !== state) return;

  const handled = await handlePendingAdd(ctx, chatId, state, m);
  if (handled) return;

  const text = m.message?.conversation || m.message?.extendedTextMessage?.text || '';
  if (!text) return;

  const incomingWords = normalizeText(text).split(/[^\u0621-\u064A]+/).filter(Boolean);
  if (!incomingWords.length) return;

  const senderJid = m.key.participant || m.key.remoteJid;
  if (!state.playerProgress[senderJid]) state.playerProgress[senderJid] = new Set();
  const playerFound = state.playerProgress[senderJid];

  const { lookup, maxWords, slotCount } = state.answerData;

  for (let i = 0; i < incomingWords.length; i++) {
    for (let len = 1; len <= maxWords && i + len <= incomingWords.length; len++) {
      const slotIndex = lookup.get(incomingWords.slice(i, i + len).join(' '));
      if (slotIndex !== undefined) playerFound.add(slotIndex);
    }
  }

  if (playerFound.size < slotCount) return;

  if (state.isTransitioning) return;
  state.isTransitioning = true;

  const timeTaken = ((Date.now() - state.startTime) / 1000).toFixed(3);
  const winnerMention = `@${senderJid.split('@')[0]}`;
  state.scores[senderJid] = (state.scores[senderJid] || 0) + 1;

  const nextQ = getRandomQuestion();
  if (!nextQ) {
    store.delete(chatId);
    ctx.sock.sendMessage(chatId, { text: 'خطأ: لم يتم العثور على أسئلة في فئة سس.' }).catch(() => {});
    state.isTransitioning = false;
    return;
  }

  pushHistory(ctx, chatId, { question: nextQ.question, answersRaw: nextQ.answers });

  state.currentQuestion = nextQ.question;
  state.answersRaw = nextQ.answers;
  state.answerData = buildAnswerData(nextQ.answers);
  state.playerProgress = {};

  const replyText = `+1 ${winnerMention} (${timeTaken}s)\n\n*س/ ${nextQ.question}*`;

  ctx.sock.sendMessage(chatId, { text: replyText, mentions: [senderJid] }, { quoted: m })
    .then(() => {
      state.startTime = Date.now();
      state.isTransitioning = false;
    })
    .catch(err => {
      console.error('سس game send error:', err);
      state.isTransitioning = false;
    });
}

export default {
  name: 'مس',
  aliases: ['سس', 'ضفسس'],
  description: 'لعبة سس: تخمين إجابة واحدة صحيحة لكل سؤال',
  cooldown: 0,

  async execute(ctx) {
    ensureGlobalListener(ctx);

    const store = ctx.store.namespace('ssGame');
    const commandUsed = ctx.command.toLowerCase();

    if (commandUsed === 'سس') {
      if (!store.has(ctx.chatId)) {
        await ctx.reply('لا توجد فعالية سس شغالة حالياً.');
        return;
      }
      const oldState = store.get(ctx.chatId);
      store.delete(ctx.chatId);

      const leaderboard = Object.entries(oldState.scores || {}).sort((a, b) => b[1] - a[1]);
      if (!leaderboard.length) {
        await ctx.reply('تم إيقاف الفعالية. لم يسجل أحد أي نقطة.');
        return;
      }

      const lines = leaderboard.map(([jid, pts], i) => `${i + 1}. @${jid.split('@')[0]} - ${pts}`);
      const mentions = leaderboard.map(([jid]) => jid);

      await ctx.sock.sendMessage(ctx.chatId, {
        text: `تم إيقاف الفعالية\n\nالنتائج النهائية:\n${lines.join('\n')}`,
        mentions
      });
      return;
    }

    if (commandUsed === 'ضفسس') {
      const historyStore = ctx.store.namespace('ssHistory');
      const history = historyStore.get(ctx.chatId) || [];
      if (!history.length) {
        await ctx.reply('لا يوجد سجل أسئلة لإضافتها بعد.');
        return;
      }

      const lines = history.map((h, i) => `${i + 1}. ${h.question}`);
      await ctx.reply(`اختر رقم السؤال الذي تريد إضافة إجابات إليه:\n\n${lines.join('\n')}`);

      const pendingStore = ctx.store.namespace('ssPendingAdd');
      pendingStore.set(ctx.sender, {
        step: 1,
        snapshots: history.slice(-5),
        timestamp: Date.now()
      });
      return;
    }

    ctx.store.namespace('katGame').delete(ctx.chatId);
    ctx.store.namespace('picGame').delete(ctx.chatId);
    ctx.store.namespace('ta3Game').delete(ctx.chatId);

    if (!SS_POOL.length) {
      await ctx.reply('علقت');
      return;
    }

    const firstQ = getRandomQuestion();
    if (!firstQ) return;

    pushHistory(ctx, ctx.chatId, { question: firstQ.question, answersRaw: firstQ.answers });

    const state = {
      currentQuestion: firstQ.question,
      answersRaw: firstQ.answers,
      answerData: buildAnswerData(firstQ.answers),
      startTime: Date.now(),
      scores: {},
      playerProgress: {},
      queue: Promise.resolve(),
      isTransitioning: false
    };

    store.set(ctx.chatId, state);

    await ctx.reply(`*س/ ${firstQ.question}*`);
    state.startTime = Date.now();
  }
};
