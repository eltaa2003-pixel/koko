import fs from 'node:fs';
import path from 'node:path';
import { recordWin } from '../lib/playerStats.js';
import { normalizeLenient } from '../lib/normalizeArabic.js';
import { makeRecentTracker } from '../lib/recentPicks.js';
import { getRandomWords } from './kat.js';

// ============================================================================
// مقالة command family
//
//   .مقه   — full sentence, WITH tashkeel (مشكولة). Any reply -> new one.
//   .مق    — full sentence, plain (no tashkeel), pulled from Arabic Wikipedia.
//            Any reply -> new one.
//   .مغر   — random word salad (5–15 unrelated words from the كت word bank).
//            Any reply -> new one.
//   .مكرر  — the "numbering" mode: like كت, but the target word/count list is
//            built live from a random Wikipedia sentence instead of a fixed
//            word bank. Players type the words out until the quota's filled.
//   .سق / .سقه — stop whichever مقالة round is running in the chat.
//
// مقه/مق/مغر are deliberately NOT a matching game — the phrases are already
// long, so "did you respond at all" is the only bar. مكرر is the one mode
// that keeps score, exactly like كت.
// ============================================================================

const GAME_ID = 'maqalaGame';
const GAME_LABEL_FOR_STATS = 'مكرر';

const TASHKEEL_DATA_PATH = path.resolve('plugins/maqala-tashkeel.json');
const WIKI_RANDOM_SUMMARY_API = 'https://ar.wikipedia.org/api/rest_v1/page/random/summary';

const MODE_LABELS = {
  tashkeel: 'مقه (مشكولة)',
  plain: 'مق (بدون تشكيل)',
  salad: 'مغر (عشوائي)',
  count: 'مكرر (تكراري)'
};

// ---------------------------------------------------------------------------
// tashkeel phrase bank (local JSON, hand-maintained — see the file's _note)
// ---------------------------------------------------------------------------

function loadTashkeelPhrases() {
  try {
    const raw = fs.readFileSync(TASHKEEL_DATA_PATH, 'utf-8');
    const data = JSON.parse(raw);
    return Array.isArray(data.phrases) ? data.phrases.filter(Boolean) : [];
  } catch (err) {
    console.error('Error loading maqala-tashkeel.json:', err);
    return [];
  }
}

const TASHKEEL_PHRASES = loadTashkeelPhrases();

function pickTashkeelPhrase() {
  if (!TASHKEEL_PHRASES.length) return null;
  return TASHKEEL_PHRASES[Math.floor(Math.random() * TASHKEEL_PHRASES.length)];
}

// ---------------------------------------------------------------------------
// Arabic Wikipedia random-article fetch (source for .مق and .مكرر)
// ---------------------------------------------------------------------------

function cleanWikiExtract(text) {
  return text
    .replace(/\([^)]*\)/g, ' ')   // pronunciation guides, English glosses, etc.
    .replace(/\[[^\]]*\]/g, ' ')  // stray reference brackets
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchWikiPhrase(minWords = 8) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(WIKI_RANDOM_SUMMARY_API, {
        headers: { 'User-Agent': 'wa-bot/1.0 (maqala plugin)' }
      });
      if (!res.ok) continue;
      const data = await res.json();
      const extract = cleanWikiExtract(data.extract || '');
      const words = extract.split(/\s+/).filter(Boolean);
      if (words.length >= minWords) return extract;
    } catch (err) {
      console.error('fetchWikiPhrase error:', err);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// display helpers
// ---------------------------------------------------------------------------

// Comma after every word — breaks up the run of text just enough that
// copy-pasting the whole thing elsewhere (to search for the source, etc.)
// doesn't reproduce it cleanly.
function withCommas(text) {
  return text.split(/\s+/).filter(Boolean).map(w => `${w}،`).join(' ');
}

// ---------------------------------------------------------------------------
// .مغر — random word salad, reuses كت's word bank + getRandomWords
// ---------------------------------------------------------------------------

const saladTracker = makeRecentTracker();

function buildSalad(chatId) {
  const count = 5 + Math.floor(Math.random() * 11); // 5..15
  const words = getRandomWords(count, saladTracker.getExcluded(chatId));
  if (!words.length) return null;
  saladTracker.record(chatId, words.map(normalizeLenient));
  return withCommas(words.join(' '));
}

// ---------------------------------------------------------------------------
// .مكرر — كت-style word/count target, built live from a Wikipedia sentence
// ---------------------------------------------------------------------------

function buildCountTarget(rawPhrase) {
  const words = normalizeLenient(rawPhrase).split(/[^\u0621-\u064A]+/).filter(Boolean);
  if (words.length < 3) return null;

  const counts = new Map();
  for (const w of words) counts.set(w, (counts.get(w) || 0) + 1);
  return counts;
}

function buildRemaining(counts) {
  return new Map(counts);
}

function buildTargetDisplay(counts) {
  return [...counts.entries()].map(([w, c]) => `${w}(${c})`).join(' ');
}

function targetTotal(counts) {
  let total = 0;
  for (const c of counts.values()) total += c;
  return total;
}

function buildRemainingText(player, counts) {
  const remaining = [];
  for (const [word, count] of player.remaining.entries()) {
    if (count <= 0) continue;
    for (let c = 0; c < count; c++) remaining.push(word);
  }
  return `اكتب:${remaining.join(',')}`;
}

async function fetchCountRound() {
  for (let attempt = 0; attempt < 5; attempt++) {
    const phrase = await fetchWikiPhrase(8);
    if (!phrase) continue;
    const counts = buildCountTarget(phrase);
    if (counts) return counts;
  }
  return null;
}

// ---------------------------------------------------------------------------
// message extraction + global listener (same shape as كت / بطولة)
// ---------------------------------------------------------------------------

function getText(m) {
  return (
    m.message?.conversation ||
    m.message?.extendedTextMessage?.text ||
    m.message?.imageMessage?.caption ||
    m.message?.videoMessage?.caption ||
    ''
  );
}

const registeredSocks = new WeakSet();

function ensureGlobalListener(ctx) {
  if (registeredSocks.has(ctx.sock)) return;
  registeredSocks.add(ctx.sock);

  ctx.sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify' && type !== 'append') return;

    const store = ctx.store.namespace(GAME_ID);

    for (const m of messages) {
      if (!m.message || m.key.fromMe) continue;

      const chatId = m.key.remoteJid;
      const state = store.get(chatId);
      if (!state) continue;

      state.queue = state.queue
        .then(() => processMessage(ctx, chatId, state, m))
        .catch(err => console.error('مقالة game processing error:', err));
    }
  });
}

async function processMessage(ctx, chatId, state, m) {
  const store = ctx.store.namespace(GAME_ID);
  if (store.get(chatId) !== state) return;

  const text = getText(m);
  if (!text) return;

  if (state.mode === 'count') {
    await processCountAnswer(ctx, chatId, state, m, text);
    return;
  }

  // loose modes (tashkeel / plain / salad): ANY reply advances, no scoring.
  await advanceLoose(ctx, chatId, state, m);
}

async function advanceLoose(ctx, chatId, state, m) {
  const store = ctx.store.namespace(GAME_ID);
  if (store.get(chatId) !== state) return;

  const next = await buildLoosePhrase(state.mode, chatId);
  if (!next) {
    ctx.sock.sendMessage(chatId, {
      text: 'تعذر جلب مقالة جديدة (مشكلة في المصدر). حاول لاحقاً أو أوقف باستخدام .سق'
    }).catch(() => {});
    return;
  }

  ctx.sock.sendMessage(chatId, { text: next }, { quoted: m }).catch(() => {});
}

async function buildLoosePhrase(mode, chatId) {
  if (mode === 'tashkeel') {
    const phrase = pickTashkeelPhrase();
    return phrase ? withCommas(phrase) : null;
  }
  if (mode === 'plain') {
    const phrase = await fetchWikiPhrase(8);
    return phrase ? withCommas(phrase) : null;
  }
  if (mode === 'salad') {
    return buildSalad(chatId);
  }
  return null;
}

async function processCountAnswer(ctx, chatId, state, m, text) {
  const normInput = normalizeLenient(text);
  const incomingWords = normInput.split(/[^\u0621-\u064A]+/).filter(Boolean);
  if (incomingWords.length === 0) return;

  const senderJid = m.key.participant || m.key.remoteJid;

  if (!state.players) state.players = {};
  if (!state.players[senderJid]) {
    state.players[senderJid] = {
      remaining: buildRemaining(state.targetCounts),
      matchedCount: 0
    };
  }

  const player = state.players[senderJid];
  let progressed = false;
  let justWon = false;

  for (const word of incomingWords) {
    if (player.matchedCount >= state.targetTotal) break;
    const left = player.remaining.get(word);
    if (left && left > 0) {
      player.remaining.set(word, left - 1);
      player.matchedCount++;
      progressed = true;
      if (player.matchedCount === state.targetTotal) {
        justWon = true;
        break;
      }
    }
  }

  if (progressed && !justWon) {
    const remainingText = buildRemainingText(player, state.targetCounts);
    ctx.sock.sendMessage(chatId, { text: remainingText }, { quoted: m }).catch(() => {});
  }

  if (!justWon) return;

  const rawTime = Number(process.hrtime.bigint() - state.startTime) / 1e9;
  const winnerMention = `@${senderJid.split('@')[0]}`;

  state.scores[senderJid] = (state.scores[senderJid] || 0) + 1;

  try {
    await recordWin({
      jid: senderJid,
      game: GAME_LABEL_FOR_STATS,
      timeTaken: rawTime,
      label: buildTargetDisplay(state.targetCounts),
      answeredCount: state.targetTotal
    });
  } catch (err) {
    console.error('recordWin failed (مكرر):', err);
  }

  const nextCounts = await fetchCountRound();
  if (!nextCounts) {
    ctx.sock.sendMessage(chatId, {
      text: `+1 ${winnerMention}\n\nتعذر جلب جولة جديدة، أوقف باستخدام .سق`,
      mentions: [senderJid]
    }).catch(() => {});
    return;
  }

  state.targetCounts = nextCounts;
  state.targetTotal = targetTotal(nextCounts);
  state.players = {};
  state.startTime = process.hrtime.bigint();

  const replyText = `+1 ${winnerMention} (${rawTime.toFixed(3)}s)\n\n*${buildTargetDisplay(nextCounts)}*`;

  ctx.sock.sendMessage(chatId, { text: replyText, mentions: [senderJid] }, { quoted: m }).catch(err => {
    console.error('مقالة (مكرر) send error:', err);
  });
}

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

async function stopGame(ctx) {
  const store = ctx.store.namespace(GAME_ID);

  if (!store.has(ctx.chatId)) {
    await ctx.reply('لا توجد مقالة شغالة حالياً.');
    return;
  }

  const state = store.get(ctx.chatId);
  store.delete(ctx.chatId);

  const label = MODE_LABELS[state.mode] || 'مقالة';

  if (state.mode !== 'count') {
    await ctx.reply(`تم إيقاف ${label}.`);
    return;
  }

  const leaderboard = Object.entries(state.scores || {}).sort((a, b) => b[1] - a[1]);
  if (!leaderboard.length) {
    await ctx.reply(`تم إيقاف ${label}. لم يسجل أحد أي نقطة.`);
    return;
  }

  const lines = leaderboard.map(([jid, pts], i) => `${i + 1}. @${jid.split('@')[0]} - ${pts}`);
  const mentions = leaderboard.map(([jid]) => jid);

  await ctx.sock.sendMessage(ctx.chatId, {
    text: `تم إيقاف ${label}\n\nالنتائج النهائية:\n${lines.join('\n')}`,
    mentions
  });
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

async function startLoose(ctx, mode) {
  const phrase = await buildLoosePhrase(mode, ctx.chatId);
  if (!phrase) {
    const hint = mode === 'tashkeel'
      ? 'لا توجد عبارات مشكولة محفوظة (plugins/maqala-tashkeel.json فارغ).'
      : 'تعذر جلب مقالة من ويكيبيديا، حاول مرة أخرى.';
    await ctx.reply(hint);
    return;
  }

  const store = ctx.store.namespace(GAME_ID);
  store.set(ctx.chatId, {
    mode,
    queue: Promise.resolve()
  });

  await ctx.reply(phrase);
}

async function startCount(ctx) {
  const counts = await fetchCountRound();
  if (!counts) {
    await ctx.reply('تعذر جلب مقالة من ويكيبيديا، حاول مرة أخرى.');
    return;
  }

  const store = ctx.store.namespace(GAME_ID);
  const state = {
    mode: 'count',
    targetCounts: counts,
    targetTotal: targetTotal(counts),
    players: {},
    scores: {},
    startTime: process.hrtime.bigint(),
    queue: Promise.resolve()
  };
  store.set(ctx.chatId, state);

  await ctx.reply(`*${buildTargetDisplay(counts)}*`);
}

export default {
  name: 'مقه',
  aliases: ['مق', 'مكرر', 'مغر', 'سق', 'سقه'],
  description: 'عائلة أوامر المقالة: .مقه (مشكولة) / .مق (بدون تشكيل) / .مغر (كلمات عشوائية) / .مكرر (تحدي عد وتكرار) — وقف بـ .سق أو .سقه',
  cooldown: 0,

  async execute(ctx) {
    ensureGlobalListener(ctx);

    const commandUsed = ctx.command.toLowerCase();

    if (commandUsed === 'سق' || commandUsed === 'سقه') {
      await stopGame(ctx);
      return;
    }

    ctx.store.stopAllGames(ctx);
    ctx.store.namespace('reverseGame').delete(ctx.chatId);
    ctx.store.namespace('reverseTafkikGame').delete(ctx.chatId);

    if (commandUsed === 'مقه') {
      await startLoose(ctx, 'tashkeel');
    } else if (commandUsed === 'مق') {
      await startLoose(ctx, 'plain');
    } else if (commandUsed === 'مغر') {
      await startLoose(ctx, 'salad');
    } else if (commandUsed === 'مكرر') {
      await startCount(ctx);
    }
  }
};
