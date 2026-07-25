import fs from 'node:fs';
import path from 'node:path';
import { recordWin } from '../lib/playerStats.js';
import { makeRecentTracker } from '../lib/recentPicks.js';
import { normalizeLenient } from '../lib/normalizeArabic.js';

const GAME_DATA_PATH = path.resolve('plugins/game-data.json');

function loadWords() {
  try {
    const raw = fs.readFileSync(GAME_DATA_PATH, 'utf-8');
    const data = JSON.parse(raw);
    return data['كت'] || [];
  } catch (err) {
    console.error('Error loading game-data.json:', err);
    return [];
  }
}

const ALL_WORDS = loadWords();

export function getRandomWords(count, excludeSet) {
  const n = ALL_WORDS.length;
  if (!n) return [];
  const take = Math.min(count, n);

  let pool = ALL_WORDS.slice();
  if (excludeSet && excludeSet.size > 0) {
    const filtered = pool.filter(w => !excludeSet.has(normalizeLenient(w)));
    if (filtered.length >= take) {
      pool = filtered;
    }
  }

  const m = pool.length;
  const result = new Array(take);
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(Math.random() * (m - i));
    result[i] = pool[j];
    pool[j] = pool[i];
  }
  return result;
}

export const recentTracker = makeRecentTracker();

function buildRemaining(normalizedWords) {
  const remaining = new Map();
  for (const w of normalizedWords) {
    remaining.set(w, (remaining.get(w) || 0) + 1);
  }
  return remaining;
}

// Maps a normalized word back to how it's actually spelled/displayed,
// so feedback text shows real words instead of the stripped-down form.
export function buildNormToOriginal(words, normalized) {
  const map = new Map();
  for (let i = 0; i < words.length; i++) {
    if (!map.has(normalized[i])) map.set(normalized[i], words[i]);
  }
  return map;
}

// Builds the "اكتب:اسم,اسم" text for whatever a given player hasn't found yet.
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

    const store = ctx.store.namespace('katGame');

    for (const m of messages) {
      if (!m.message || m.key.fromMe) continue;

      const chatId = m.key.remoteJid;
      const state = store.get(chatId);
      if (!state) continue; 

      state.queue = state.queue
        .then(() => processMessage(ctx, chatId, state, m))
        .catch(err => console.error('كت game processing error:', err));
    }
  });
}

async function processMessage(ctx, chatId, state, m) {
  const store = ctx.store.namespace('katGame');
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
      remaining: buildRemaining(state.targetNormalized),
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

  // Instead of a ✅ react (which is slow to show and gives zero info about
  // what's left), tell the player directly and instantly what's still missing.
  if (progressed && !justWon) {
    const remainingText = buildRemainingText(state, player);
    ctx.sock.sendMessage(chatId, { text: remainingText }, { quoted: m }).catch(() => {});
  }

  if (!justWon) return;

  const timeTaken = Number(process.hrtime.bigint() - state.startTime) / 1e9;
  const winnerMention = `@${senderJid.split('@')[0]}`;

  state.scores[senderJid] = (state.scores[senderJid] || 0) + 1;

  try {
    await recordWin({ jid: senderJid, game: 'كت', timeTaken, label: state.targetWords.join(' '), answeredCount: state.targetTotal });
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
  state.targetTotal = nextNormalized.length;
  state.normToOriginal = buildNormToOriginal(nextWords, nextNormalized);
  state.players = {}; 
  
  const replyText = `+1 ${winnerMention} (${timeTaken.toFixed(3)}s)\n\n*${nextWords.join(' ')}*`;

  ctx.sock.sendMessage(
    chatId,
    { text: replyText, mentions: [senderJid] },
    { quoted: m }
  ).then(() => {
    state.startTime = process.hrtime.bigint();
  }).catch(err => console.error('كت game send error:', err));
}

export default {
  name: 'مكت',
  aliases: ['سكت'],
  description: 'Fast-paced word matching game for كت/تفكيك',
  cooldown: 0, 

  async execute(ctx) {
    ensureGlobalListener(ctx);

    const store = ctx.store.namespace('katGame');
    const commandUsed = ctx.command.toLowerCase();

    if (commandUsed === 'سكت') {
      if (!store.has(ctx.chatId)) {
        await ctx.reply('لا توجد لعبة شغالة حالياً.');
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

    ctx.store.namespace('ta3Game').delete(ctx.chatId);
    ctx.store.namespace('picGame').delete(ctx.chatId);
    ctx.store.namespace('ssGame').delete(ctx.chatId);
    ctx.store.namespace('tafkikGame').delete(ctx.chatId);

    let count = 1;
    const match = commandUsed.match(/^مكت(\d+)$/);

    if (match) {
      count = parseInt(match[1], 10);
    } else if (ctx.args.length > 0 && !isNaN(parseInt(ctx.args[0], 10))) {
      count = parseInt(ctx.args[0], 10);
    }

    if (count < 1) count = 1;

    if (!ALL_WORDS.length) {
      await ctx.reply('خطأ: لم يتم العثور على كلمات في game-data.json');
      return;
    }

    const targetWords = getRandomWords(count, recentTracker.getExcluded(ctx.chatId));
    const targetNormalized = targetWords.map(normalizeLenient);
    recentTracker.record(ctx.chatId, targetNormalized);

    if (targetWords.length < count) {
      await ctx.reply(`يوجد فقط ${targetWords.length} كلمة متاحة في هذه الفئة (تم طلب ${count}).`);
    }

    const state = {
      targetWords,
      targetCount: count,
      targetNormalized, 
      targetTotal: targetNormalized.length,
      normToOriginal: buildNormToOriginal(targetWords, targetNormalized),
      players: {}, 
      startTime: process.hrtime.bigint(),
      scores: {},
      queue: Promise.resolve() 
    };

    store.set(ctx.chatId, state);

    await ctx.reply(`*${targetWords.join(' ')}*`);
    state.startTime = process.hrtime.bigint();
  }
};