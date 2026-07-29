import { getRandomWords } from './kat.js';
import { recordWin } from '../lib/playerStats.js';
import { makeRecentTracker } from '../lib/recentPicks.js';
import { normalizeLenient } from '../lib/normalizeArabic.js';

export const recentTracker = makeRecentTracker();

export function buildReversedLetterSeqs(normalizedWords) {
  return normalizedWords.map(w => Array.from(w).filter(ch => ch !== ' ').reverse());
}

const registeredSocks = new WeakSet();

function ensureGlobalListener(ctx) {
  if (registeredSocks.has(ctx.sock)) return;
  registeredSocks.add(ctx.sock);

  ctx.sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify' && type !== 'append') return;

    const store = ctx.store.namespace('reverseTafkikGame');

    for (const m of messages) {
      if (!m.message || m.key.fromMe) continue;

      const chatId = m.key.remoteJid;
      const state = store.get(chatId);
      if (!state) continue;

      state.queue = state.queue
        .then(() => processMessage(ctx, chatId, state, m))
        .catch(err => console.error('معكستف game processing error:', err));
    }
  });
}

async function processMessage(ctx, chatId, state, m) {
  const store = ctx.store.namespace('reverseTafkikGame');
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
      solved: new Set(),
      solvedCount: 0
    };
  }

  const player = state.players[senderJid];
  let progressed = false;
  let justWon = false;
  let i = 0;

  const unsolvedIndices = () =>
    state.targetLetterSeqs
      .map((_, idx) => idx)
      .filter(idx => !player.solved.has(idx))
      .sort((a, b) => state.targetLetterSeqs[b].length - state.targetLetterSeqs[a].length);

  while (i < incomingWords.length && player.solvedCount < state.targetTotal) {
    let matchedIdx = -1;
    for (const idx of unsolvedIndices()) {
      const letters = state.targetLetterSeqs[idx];
      const L = letters.length;
      if (i + L > incomingWords.length) continue;
      let ok = true;
      for (let k = 0; k < L; k++) {
        if (incomingWords[i + k] !== letters[k]) { ok = false; break; }
      }
      if (ok) { matchedIdx = idx; break; }
    }

    if (matchedIdx !== -1) {
      player.solved.add(matchedIdx);
      player.solvedCount++;
      i += state.targetLetterSeqs[matchedIdx].length;
      progressed = true;
      if (player.solvedCount === state.targetTotal) {
        justWon = true;
        break;
      }
    } else {
      i++;
    }
  }

  if (progressed && !justWon) {
    const remaining = state.targetWords.filter((_, idx) => !player.solved.has(idx));
    ctx.sock.sendMessage(chatId, { text: `اكتب:${remaining.join(',')}` }, { quoted: m }).catch(() => {});
  }

  if (!justWon) return;

  const rawTime = Number(process.hrtime.bigint() - state.startTime) / 1e9;
  const timeTaken = Math.max(0, rawTime - (state.sendLatency || 0));
  const winnerMention = `@${senderJid.split('@')[0]}`;

  state.scores[senderJid] = (state.scores[senderJid] || 0) + 1;

  try {
    await recordWin({ jid: senderJid, game: 'عكس تفكيك', timeTaken, label: state.targetWords.join(' '), answeredCount: state.targetTotal });
  } catch (err) {
    console.error('recordWin failed:', err);
  }

  const nextWords = getRandomWords(state.targetCount, recentTracker.getExcluded(chatId));
  const nextNormalized = nextWords.map(normalizeLenient);
  recentTracker.record(chatId, nextNormalized);

  if (nextWords.length < state.targetCount) {
    ctx.sock.sendMessage(chatId, {
      text: `يوجد فقط ${nextWords.length} كلمة متاحة في هذه الفئة (تم طلب ${state.targetCount}).`
    }).catch(() => {});
  }

  state.targetWords = nextWords;
  state.targetNormalized = nextNormalized;
  state.targetLetterSeqs = buildReversedLetterSeqs(nextNormalized);
  state.targetTotal = nextWords.length;
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
    console.error('معكستف game send error:', err);
  });
}

export default {
  name: 'معكستف',
  aliases: ['سعكستف'],
  description: 'معكستف: نفس تفكيك، بس لازم تكتب الحروف معكوسة',
  cooldown: 0,

  async execute(ctx) {
    ensureGlobalListener(ctx);

    const store = ctx.store.namespace('reverseTafkikGame');
    const commandUsed = ctx.command.toLowerCase();

    if (commandUsed === 'سعكستف') {
      if (!store.has(ctx.chatId)) {
        await ctx.reply('لا توجد لعبة معكستف شغالة حالياً.');
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

    const targetWords = getRandomWords(count, recentTracker.getExcluded(ctx.chatId));
    if (!targetWords.length) {
      await ctx.reply('خطأ: لم يتم العثور على كلمات في game-data.json');
      return;
    }

    const targetNormalized = targetWords.map(normalizeLenient);
    recentTracker.record(ctx.chatId, targetNormalized);

    if (targetWords.length < count) {
      await ctx.reply(`يوجد فقط ${targetWords.length} كلمة متاحة في هذه الفئة (تم طلب ${count}).`);
    }

    const state = {
      targetWords,
      targetCount: count,
      targetNormalized,
      targetLetterSeqs: buildReversedLetterSeqs(targetNormalized),
      targetTotal: targetWords.length,
      players: {},
      startTime: process.hrtime.bigint(),
      scores: {},
      queue: Promise.resolve()
    };

    store.set(ctx.chatId, state);

    await ctx.reply(`*${targetWords.join(' ')}*`);
  }
};
