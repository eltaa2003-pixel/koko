import { getRandomWords, buildNormToOriginal, recentTracker as reverseTracker } from './kat.js';
import { recordWin } from '../lib/playerStats.js';
import { normalizeLenient } from '../lib/normalizeArabic.js';

export function reverseNormalized(text) {
  return text.split('').reverse().join('');
}

function buildRemaining(normalizedWords) {
  const remaining = new Map();
  for (const w of normalizedWords) {
    remaining.set(w, (remaining.get(w) || 0) + 1);
  }
  return remaining;
}

function buildRemainingText(state, player) {
  const remaining = [];
  for (const [key, count] of player.remaining.entries()) {
    if (count <= 0) continue;
    const display = state.normToOriginal.get(key) || key;
    for (let c = 0; c < count; c++) remaining.push(display);
  }
  return `اكتب:${remaining.join(',')}`;
}

const registeredSocks = new WeakSet();

function ensureGlobalListener(ctx) {
  if (registeredSocks.has(ctx.sock)) return;
  registeredSocks.add(ctx.sock);

  ctx.sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify' && type !== 'append') return;

    const store = ctx.store.namespace('reverseGame');

    for (const m of messages) {
      if (!m.message || m.key.fromMe) continue;

      const chatId = m.key.remoteJid;
      const state = store.get(chatId);
      if (!state) continue;

      state.queue = state.queue
        .then(() => processMessage(ctx, chatId, state, m))
        .catch(err => console.error('معكس game processing error:', err));
    }
  });
}

async function processMessage(ctx, chatId, state, m) {
  const store = ctx.store.namespace('reverseGame');
  if (store.get(chatId) !== state) return;

  const text =
    m.message?.conversation ||
    m.message?.extendedTextMessage?.text ||
    m.message?.imageMessage?.caption ||
    m.message?.videoMessage?.caption ||
    '';

  if (!text) return;

  const normInput = normalizeLenient(text);
  const incomingWords = normInput.split(/[^\u0621-\u064A]+/).filter(Boolean);
  if (incomingWords.length === 0) return;

  const senderJid = m.key.participant || m.key.remoteJid;

  if (!state.players) state.players = {};
  if (!state.players[senderJid]) {
    state.players[senderJid] = {
      remaining: buildRemaining(state.targetReversed),
      matchedCount: 0
    };
  }

  const player = state.players[senderJid];
  let progressed = false;
  let justWon = false;
  let i = 0;

  while (i < incomingWords.length && player.matchedCount < state.targetTotal) {
    let matched = false;
    for (let n = incomingWords.length - i; n > 0; n--) {
      const candidate = incomingWords.slice(i, i + n).join(' ');
      const left = player.remaining.get(candidate);
      if (left && left > 0) {
        player.remaining.set(candidate, left - 1);
        player.matchedCount++;
        i += n;
        matched = true;
        if (player.matchedCount === state.targetTotal) {
          justWon = true;
          break;
        }
        break;
      }
    }
    if (!matched) {
      i++;
    } else {
      progressed = true;
    }
  }

  if (progressed && !justWon) {
    const remainingText = buildRemainingText(state, player);
    ctx.sock.sendMessage(chatId, { text: remainingText }, { quoted: m }).catch(() => {});
  }

  if (!justWon) return;

  const rawTime = Number(process.hrtime.bigint() - state.startTime) / 1e9;
  const timeTaken = Math.max(0, rawTime - (state.sendLatency || 0));
  const winnerMention = `@${senderJid.split('@')[0]}`;

  state.scores[senderJid] = (state.scores[senderJid] || 0) + 1;

  try {
    await recordWin({ jid: senderJid, game: 'عكس', timeTaken, label: state.targetWords.join(' '), answeredCount: state.targetTotal });
  } catch (err) {
    console.error('recordWin failed:', err);
  }

  const nextWords = getRandomWords(state.targetCount, reverseTracker.getExcluded(chatId));
  const nextNormalized = nextWords.map(normalizeLenient);
  const nextReversed = nextNormalized.map(reverseNormalized);
  reverseTracker.record(chatId, nextNormalized);

  if (nextWords.length < state.targetCount) {
    ctx.sock.sendMessage(chatId, {
      text: `يوجد فقط ${nextWords.length} كلمة متاحة في هذه الفئة (تم طلب ${state.targetCount}).`
    }).catch(() => {});
  }

  state.targetWords = nextWords;
  state.targetNormalized = nextNormalized;
  state.targetReversed = nextReversed;
  state.targetTotal = nextReversed.length;
  state.normToOriginal = buildNormToOriginal(nextWords, nextReversed);
  state.players = {};

  const replyText = `+1 ${winnerMention} (${timeTaken.toFixed(3)}s)\n\n*${nextWords.join(' ')}*`;

  state.startTime = process.hrtime.bigint();
  const sendStart = state.startTime;

  ctx.sock.sendMessage(
    chatId,
    { text: replyText, mentions: [senderJid] },
    { quoted: m }
  ).then(() => {
    state.sendLatency = Number(process.hrtime.bigint() - sendStart) / 1e9;
  }).catch(err => {
    console.error('معكس game send error:', err);
  });
}

export default {
  name: 'معكس',
  aliases: ['سعكس'],
  description: 'معكس: نفس بنك كلمات كت، بس لازم تكتب الكلمة معكوسة',
  cooldown: 0,

  async execute(ctx) {
    ensureGlobalListener(ctx);

    const store = ctx.store.namespace('reverseGame');
    const commandUsed = ctx.command.toLowerCase();

    if (commandUsed === 'سعكس') {
      if (!store.has(ctx.chatId)) {
        await ctx.reply('لا توجد لعبة معكوسة شغالة حالياً.');
        return;
      }
      const oldState = store.get(ctx.chatId);
      store.delete(ctx.chatId);

      const leaderboard = Object.entries(oldState.scores || {}).sort((a, b) => b[1] - a[1]);

      if (leaderboard.length === 0) {
        await ctx.reply('تم إيقاف اللعبة. لم يسجل أحد أي نقطة.');
        return;
      }

      const lines = leaderboard.map(([jid, pts], i) => `${i + 1}. @${jid.split('@')[0]} - ${pts}`);
      const mentions = leaderboard.map(([jid]) => jid);

      await ctx.sock.sendMessage(ctx.chatId, {
        text: `تم إيقاف اللعبة\n\nالنتائج النهائية:\n${lines.join('\n')}`,
        mentions
      });
      return;
    }

    ctx.store.stopAllGames(ctx);

    let count = Math.floor(Math.random() * 10) + 1;

    if (ctx.args.length > 0 && !isNaN(parseInt(ctx.args[0], 10))) {
      count = parseInt(ctx.args[0], 10);
    }

    if (count < 1) count = 1;

    const targetWords = getRandomWords(count, reverseTracker.getExcluded(ctx.chatId));
    if (!targetWords.length) {
      await ctx.reply('خطأ: لم يتم العثور على كلمات في game-data.json');
      return;
    }

    const targetNormalized = targetWords.map(normalizeLenient);
    const targetReversed = targetNormalized.map(reverseNormalized);
    reverseTracker.record(ctx.chatId, targetNormalized);

    if (targetWords.length < count) {
      await ctx.reply(`يوجد فقط ${targetWords.length} كلمة متاحة في هذه الفئة (تم طلب ${count}).`);
    }

    const state = {
      targetWords,
      targetCount: count,
      targetNormalized,
      targetReversed,
      targetTotal: targetReversed.length,
      normToOriginal: buildNormToOriginal(targetWords, targetReversed),
      players: {},
      startTime: process.hrtime.bigint(),
      scores: {},
      queue: Promise.resolve()
    };

    store.set(ctx.chatId, state);

    await ctx.reply(`*${targetWords.join(' ')}*`);
  }
};
