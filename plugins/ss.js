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
    .replace(/\s+/g, ' ');
}

export function getRandomQuestion() {
  if (!SS_POOL.length) return null;
  return SS_POOL[Math.floor(Math.random() * SS_POOL.length)];
}

// A question's "answers" can be either:
//   ["نايم", "نايم2", ...]                → ONE required answer, all entries are spelling variants (any match wins)
//   [["نايم"], ["نايم2"]]                  → MULTIPLE required answers (need one match per slot)
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
  return slots.map(variants => variants[0]).join(' ، ');
}

const registeredSocks = new WeakSet();

function ensureGlobalListener(ctx) {
  if (registeredSocks.has(ctx.sock)) return;
  registeredSocks.add(ctx.sock);

  ctx.sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify' && type !== 'append') return;

    const store = ctx.store.namespace('ssGame');

    for (const m of messages) {
      if (!m.message || m.key.fromMe) continue;

      const chatId = m.key.remoteJid;
      const state = store.get(chatId);
      if (!state) continue;

      state.queue = state.queue
        .then(() => processMessage(ctx, chatId, state, m))
        .catch(err => console.error('سس game processing error:', err));
    }
  });
}

async function processMessage(ctx, chatId, state, m) {
  const store = ctx.store.namespace('ssGame');
  if (store.get(chatId) !== state) return;

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
  aliases: ['سس'],
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

    ctx.store.namespace('katGame').delete(ctx.chatId);
    ctx.store.namespace('picGame').delete(ctx.chatId);
    ctx.store.namespace('ta3Game').delete(ctx.chatId);

    if (!SS_POOL.length) {
      await ctx.reply('علقت');
      return;
    }

    const firstQ = getRandomQuestion();
    if (!firstQ) return;

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
