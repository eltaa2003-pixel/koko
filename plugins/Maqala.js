import fs from 'node:fs';
import path from 'node:path';
import { recordWin } from '../lib/playerStats.js';
import { normalizeLenient } from '../lib/normalizeArabic.js';
import { makeRecentTracker } from '../lib/recentPicks.js';
import { getRandomWords } from './kat.js';

// ============================================================================
// مقالة command family — all four modes now share one mechanic:
//   1. bot posts a challenge message
//   2. player must REPLY (quote) to the bot's latest message for that round
//   3. reply is checked word-by-word against a remaining-count map (كت-style)
//   4. incomplete/wrong -> "اكتب:" hint listing what's left, round continues
//   5. complete -> WPM + time announced, a new challenge auto-starts
//
//   .مقه   — full sentence WITH تشكيل (from plugins/maqala-tashkeel.json)
//   .مق    — full sentence, plain, from a random Arabic Wikipedia extract
//   .مغر   — 5–15 random unrelated words from كت's word bank
//   .مكرر  — same as مق, but the challenge is SHOWN as word(count) notation
//   .سقه / .سق / .سكرر / .سغر — stop the matching mode specifically
// ============================================================================

const GAME_ID = 'maqalaGame';
const GAME_LABEL_FOR_STATS = 'مقالة';

const TASHKEEL_DATA_PATH = path.resolve('plugins/maqala-tashkeel.json');
const WIKI_QUERY_API =
  'https://ar.wikipedia.org/w/api.php?action=query&format=json&generator=random&grnnamespace=0&grnlimit=6&prop=extracts&exintro=1&explaintext=1&exsectionformat=plain';

const STUB_PATTERNS = [
  /عدد السكان/,
  /قرية تقع/,
  /قرية تابعة/,
  /إحدى قرى/,
  /ناحية تتبع/,
  /هي قرية/,
  /لاعب كرة قدم/,
  /مواليد \d{4}/,
  /هو ممثل/,
  /هو مغني/
];

function isGoodQuality(text) {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 7) return false;

  const digitChars = (text.match(/[0-9\u0660-\u0669]/g) || []).length;
  if (digitChars / text.length > 0.08) return false;

  if (STUB_PATTERNS.some(re => re.test(text))) return false;

  return true;
}

async function fetchWikiPhrase() {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await fetch(WIKI_QUERY_API, {
        headers: { 'User-Agent': 'wa-bot/1.0 (maqala plugin)' }
      });
      if (!res.ok) continue;
      const data = await res.json();
      const pages = data?.query?.pages;
      if (!pages) continue;

      const candidates = Object.values(pages)
        .map(p => cleanWikiExtract(p.extract || ''))
        .filter(t => t && isGoodQuality(t));

      if (candidates.length) {
        const selected = candidates[Math.floor(Math.random() * candidates.length)];
        const words = selected.split(/\s+/).filter(Boolean);
        const targetLen = 5 + Math.floor(Math.random() * 3); // 5..7
        return words.slice(0, targetLen).join(' ');
      }
    } catch (err) {
      console.error('fetchWikiPhrase error:', err);
    }
  }
  return null;
}

const MODE_LABELS = {
  tashkeel: 'مقه (مشكولة)',
  plain: 'مق (بدون تشكيل)',
  salad: 'مغر (عشوائي)',
  count: 'مكرر (تكراري)'
};

const STOP_MODE_MAP = { 'سقه': 'tashkeel', 'سق': 'plain', 'سكرر': 'count', 'سغر': 'salad' };

// ---------------------------------------------------------------------------
// tashkeel phrase bank (local JSON, hand-maintained)
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
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// text helpers
// ---------------------------------------------------------------------------

function stripHamza(text) {
  return text
    .replace(/[أإآ]/g, 'ا')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/ء/g, '');
}

// comma after every word — breaks up the run of text so copy-pasting
// elsewhere doesn't reproduce it cleanly
function withCommas(text) {
  return text.split(/\s+/).filter(Boolean).map(w => `${w}،`).join(' ');
}

// word -> count map, used for matching AND (for مكرر) for display
function buildCounts(rawPhrase) {
  const words = normalizeLenient(rawPhrase).split(/[^\u0621-\u064A]+/).filter(Boolean);
  if (words.length < 3) return null;
  const counts = new Map();
  for (const w of words) counts.set(w, (counts.get(w) || 0) + 1);
  return counts;
}

function countsTotal(counts) {
  let total = 0;
  for (const c of counts.values()) total += c;
  return total;
}

function countsDisplay(counts) {
  return [...counts.entries()].map(([w, c]) => `${w}(${c})`).join(' ');
}

function computeWpm(totalWords, seconds) {
  const minutes = seconds / 60;
  if (minutes <= 0) return 0;
  return totalWords / minutes;
}

const saladTracker = makeRecentTracker();

function buildSaladWords(chatId) {
  const count = 5 + Math.floor(Math.random() * 11); // 5..15
  const words = getRandomWords(count, saladTracker.getExcluded(chatId));
  if (!words.length) return null;
  saladTracker.record(chatId, words.map(normalizeLenient));
  return words.join(' ');
}

// ---------------------------------------------------------------------------
// build one round: { counts, total, displayText } for a given mode
// ---------------------------------------------------------------------------

async function buildRound(mode, chatId) {
  if (mode === 'tashkeel') {
    const phrase = pickTashkeelPhrase();
    if (!phrase) return null;
    const counts = buildCounts(phrase);
    if (!counts) return null;
    return { counts, total: countsTotal(counts), displayText: withCommas(phrase) };
  }

  if (mode === 'plain') {
    const phrase = await fetchWikiPhrase();
    if (!phrase) return null;
    const counts = buildCounts(phrase);
    if (!counts) return null;
    return { counts, total: countsTotal(counts), displayText: withCommas(stripHamza(phrase)) };
  }

  if (mode === 'salad') {
    const phrase = buildSaladWords(chatId);
    if (!phrase) return null;
    const counts = buildCounts(phrase);
    if (!counts) return null;
    return { counts, total: countsTotal(counts), displayText: withCommas(phrase) };
  }

  if (mode === 'count') {
    for (let attempt = 0; attempt < 5; attempt++) {
      const phrase = await fetchWikiPhrase();
      if (!phrase) continue;
      const counts = buildCounts(phrase);
      if (!counts) continue;
      return { counts, total: countsTotal(counts), displayText: `*${countsDisplay(counts)}*` };
    }
    return null;
  }

  return null;
}

// ---------------------------------------------------------------------------
// message extraction + global listener
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

function getQuotedId(m) {
  return m.message?.extendedTextMessage?.contextInfo?.stanzaId || null;
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

  // must be a reply to the round's latest bot message
  const quotedId = getQuotedId(m);
  if (!quotedId || quotedId !== state.lastMsgId) return;

  const text = getText(m);
  if (!text) return;

  const normInput = normalizeLenient(text);
  const incomingWords = normInput.split(/[^\u0621-\u064A]+/).filter(Boolean);
  if (!incomingWords.length) return;

  const senderJid = m.key.participant || m.key.remoteJid;

  if (!state.players) state.players = {};
  if (!state.players[senderJid]) {
    state.players[senderJid] = { remaining: new Map(state.round.counts), matchedCount: 0 };
  }
  const player = state.players[senderJid];

  let progressed = false;
  let justWon = false;

  for (const word of incomingWords) {
    if (player.matchedCount >= state.round.total) break;
    const left = player.remaining.get(word);
    if (left && left > 0) {
      player.remaining.set(word, left - 1);
      player.matchedCount++;
      progressed = true;
      if (player.matchedCount === state.round.total) {
        justWon = true;
        break;
      }
    }
  }

  if (!justWon) {
    if (progressed) {
      const remainingWords = [];
      for (const [word, count] of player.remaining.entries()) {
        for (let c = 0; c < count; c++) remainingWords.push(word);
      }
      const mention = `@${senderJid.split('@')[0]}`;
      const sent = await ctx.sock.sendMessage(chatId, {
        text: `${mention} اكتب:\n${remainingWords.join(',')}`,
        mentions: [senderJid]
      }, { quoted: m }).catch(() => null);
      if (sent?.key?.id) state.lastMsgId = sent.key.id;
    }
    return;
  }

  const seconds = Number(process.hrtime.bigint() - state.startTime) / 1e9;
  const wpm = computeWpm(state.round.total, seconds);
  const mention = `@${senderJid.split('@')[0]}`;

  try {
    await recordWin({
      jid: senderJid,
      game: GAME_LABEL_FOR_STATS,
      timeTaken: seconds,
      label: countsDisplay(state.round.counts),
      answeredCount: state.round.total
    });
  } catch (err) {
    console.error('recordWin failed (مقالة):', err);
  }

  const nextRound = await buildRound(state.mode, chatId);
  if (!nextRound) {
    await ctx.sock.sendMessage(chatId, {
      text: `كفو يا ${mention}\n\nسرعتك: ${wpm.toFixed(2)} كلمة/دقيقة\nالوقت: ${seconds.toFixed(2)} ثانية\n\nتعذر جلب جولة جديدة، أوقف باستخدام الأمر المناسب.`,
      mentions: [senderJid]
    }).catch(() => {});
    return;
  }

  state.round = nextRound;
  state.players = {};
  state.startTime = process.hrtime.bigint();

  const winText = `كفو يا ${mention}\n\nسرعتك: ${wpm.toFixed(2)} كلمة/دقيقة\nالوقت: ${seconds.toFixed(2)} ثانية\n\n${nextRound.displayText}`;

  const sent = await ctx.sock.sendMessage(chatId, { text: winText, mentions: [senderJid] }).catch(err => {
    console.error('مقالة send error:', err);
    return null;
  });
  if (sent?.key?.id) state.lastMsgId = sent.key.id;
}

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

async function stopGame(ctx, expectedMode) {
  const store = ctx.store.namespace(GAME_ID);

  if (!store.has(ctx.chatId)) {
    await ctx.reply('لا توجد مقالة شغالة حالياً.');
    return;
  }

  const state = store.get(ctx.chatId);
  if (state.mode !== expectedMode) {
    await ctx.reply(`النشاط الحالي هو ${MODE_LABELS[state.mode]}. استخدم أمر الإيقاف الخاص به، أو .سكل لإيقاف أي نشاط.`);
    return;
  }

  store.delete(ctx.chatId);
  await ctx.reply(`تم إيقاف ${MODE_LABELS[state.mode]}.`);
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

async function startRound(ctx, mode) {
  const round = await buildRound(mode, ctx.chatId);
  if (!round) {
    const hint = mode === 'tashkeel'
      ? 'لا توجد عبارات مشكولة محفوظة (plugins/maqala-tashkeel.json فارغ).'
      : 'تعذر جلب مقالة جديدة، حاول مرة أخرى.';
    await ctx.reply(hint);
    return;
  }

  const store = ctx.store.namespace(GAME_ID);
  const state = {
    mode,
    round,
    players: {},
    startTime: process.hrtime.bigint(),
    queue: Promise.resolve(),
    lastMsgId: null
  };
  store.set(ctx.chatId, state);

  const sent = await ctx.sock.sendMessage(ctx.chatId, { text: round.displayText });
  state.lastMsgId = sent?.key?.id || null;
}

export default {
  name: 'مقه',
  aliases: ['مق', 'مكرر', 'مغر', 'سقه', 'سق', 'سكرر', 'سغر'],
  description: 'عائلة أوامر المقالة: .مقه / .مق / .مغر / .مكرر — رد على رسالة البوت بالإجابة. وقف بـ .سقه/.سق/.سكرر/.سغر',
  cooldown: 0,

  async execute(ctx) {
    ensureGlobalListener(ctx);

    const commandUsed = ctx.command.toLowerCase();

    if (STOP_MODE_MAP[commandUsed]) {
      await stopGame(ctx, STOP_MODE_MAP[commandUsed]);
      return;
    }

    ctx.store.stopAllGames(ctx);
    ctx.store.namespace('reverseGame').delete(ctx.chatId);
    ctx.store.namespace('reverseTafkikGame').delete(ctx.chatId);

    const modeMap = { 'مقه': 'tashkeel', 'مق': 'plain', 'مغر': 'salad', 'مكرر': 'count' };
    const mode = modeMap[commandUsed];
    if (mode) await startRound(ctx, mode);
  }
};
