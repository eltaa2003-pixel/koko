import fs from 'node:fs';
import path from 'node:path';

// Path to your game-data.json relative to the plugin location
const GAME_DATA_PATH = path.resolve('plugins/game-data.json');

// Load words from game-data.json safely
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

// Helper to sanitize and normalize Arabic text
function normalizeText(text) {
  if (!text) return '';
  return text
    .trim()
    .replace(/[\u200B-\u200F\uFEFF]/g, '') // Strip invisible zero-width/BOM chars some keyboards sneak in
    .replace(/\u0640/g, '')          // Strip tatweel/kashida elongation character
    .replace(/[\u064B-\u0652]/g, '') // Remove diacritics (tashkeel)
    .replace(/[أإآ]/g, 'ا')         // Normalize Alef
    .replace(/ة/g, 'ه')             // Normalize Ta Marbouta
    .replace(/ۃ/g, 'ه')             // Normalize Urdu Ta Marbouta look-alike
    .replace(/ى/g, 'ي')             // Normalize Alef Maqsura
    .replace(/[یے]/g, 'ي')          // Normalize Persian/Urdu Yeh look-alikes to Arabic Yeh
    .replace(/ک/g, 'ك')             // Normalize Persian Keheh to Arabic Kaf
    .replace(/ہ/g, 'ه')             // Normalize Urdu Heh Goal to Arabic Heh
    .replace(/\s+/g, ' ');          // Normalize multiple spaces into one
}

// FIX #1 (lag): the old version did `[...ALL_WORDS].sort(() => 0.5 - Math.random())`
// on EVERY round transition. That's an O(n log n) sort with a comparator, run
// synchronously right on the hot path where a new round is supposed to start
// instantly. With any real-sized word pool this is the main source of the
// game feeling laggy - it blocks the event loop for a stretch every time
// someone wins a round, right when the bot should be firing off the next
// prompt immediately.
//
// This does a partial Fisher-Yates shuffle: it only shuffles as many slots as
// we actually need (`count`), not the whole array, and does it in O(count)
// instead of O(n log n). Much cheaper, and also actually uniform (the old
// sort-based "shuffle" is a well-known biased shuffle on top of being slow).
function getRandomWords(count) {
  const n = ALL_WORDS.length;
  if (!n) return [];
  const take = Math.min(count, n);
  const pool = ALL_WORDS.slice(); // shallow copy - we only mutate the copy
  const result = new Array(take);
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(Math.random() * (n - i));
    result[i] = pool[j];
    pool[j] = pool[i];
  }
  return result;
}

// Build a "remaining words" counter from a target word list.
// Using counts (not a plain Set) so duplicate target words are handled
// correctly - e.g. if the same word is picked twice, it takes two
// correct submissions to bank both copies.
function buildRemaining(normalizedWords) {
  const remaining = new Map();
  for (const w of normalizedWords) {
    remaining.set(w, (remaining.get(w) || 0) + 1);
  }
  return remaining;
}

// FIX #2 (lag + the "one participant's answer gives up" symptom):
// The old code registered a brand-new `messages.upsert` listener, scoped to
// one chat, EVERY time `.مكت` started a game. If a tournament has several
// groups running games at once - or any game that never got a clean `.سكت`
// - those listeners pile up. Every incoming message in EVERY chat the bot is
// in then gets checked against N separate closures, one per active/leftover
// game, before any of them even get to the "is this my chat" filter. That's
// bot-wide lag, not just "this game is slow", and under load it's exactly
// the kind of thing that makes individual messages get processed late or
// feel dropped.
//
// Fix: register ONE listener per socket, ever (guarded so restarts/reloads
// of this module don't double-register). It looks up the target chat
// directly in the store - O(1) - instead of every game independently
// re-scanning every message that comes through the whole bot.
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
      if (!state) continue; // no active game here - cheap skip, no per-game listener involved

      // Chain onto the existing per-chat queue instead of a boolean lock.
      // This guarantees strict ordering with zero message loss, even when
      // multiple messages land within the same tick (200+ WPM typers).
      state.queue = state.queue
        .then(() => processMessage(ctx, chatId, state, m))
        .catch(err => console.error('كت game processing error:', err));
    }
  });
}

// Process a single incoming message against the live state for its chat.
async function processMessage(ctx, chatId, state, m) {
  const store = ctx.store.namespace('katGame');

  // Game may have been stopped/replaced while this message was queued
  if (store.get(chatId) !== state) return;

  const text =
    m.message?.conversation ||
    m.message?.extendedTextMessage?.text ||
    m.message?.imageMessage?.caption ||
    m.message?.videoMessage?.caption ||
    '';

  if (!text) return;

  const normInput = normalizeText(text);
  // Split on ANY run of non-Arabic-letter characters (spaces, periods,
  // commas, slashes, etc). Fast typers very often use "." or "," instead
  // of a space between names ("تانجيرو.شانكس") - splitting on whitespace
  // only would treat that as a single garbled word and break matching.
  const incomingWords = normInput.split(/[^\u0621-\u064A]+/).filter(Boolean);
  if (incomingWords.length === 0) return;

  // N-GRAM MATCHING: generate 1-word, 2-word, 3-word... runs from the
  // typed tokens and check longest-first against the remaining pool.
  // This lets multi-word target entries like "مي مي" land as a unit
  // even though the input was split on spaces before matching.
  let progressed = false;
  let justWon = false;
  let i = 0;
  while (i < incomingWords.length && state.matchedCount < state.targetTotal) {
    let matched = false;
    for (let n = incomingWords.length - i; n > 0; n--) {
      const candidate = incomingWords.slice(i, i + n).join(' ');
      const left = state.remaining.get(candidate);
      if (left && left > 0) {
        state.remaining.set(candidate, left - 1);
        state.matchedCount++;
        i += n;
        matched = true;
        if (state.matchedCount === state.targetTotal) {
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

  // Give visible feedback on ANY progress, not just the final word.
  if (progressed && !justWon) {
    ctx.sock.sendMessage(chatId, { react: { text: '✅', key: m.key } }).catch(() => {});
  }

  if (!justWon) return;

  const timeTaken = ((Date.now() - state.startTime) / 1000).toFixed(3);
  const winnerJid = m.key.participant || m.key.remoteJid;
  const winnerMention = `@${winnerJid.split('@')[0]}`;

  // Track the point for the end-of-game scoreboard
  state.scores[winnerJid] = (state.scores[winnerJid] || 0) + 1;

  // Pick next set of words
  const nextWords = getRandomWords(state.targetCount);
  const nextNormalized = nextWords.map(normalizeText);

  // FIX #3 (the "stops after the 4th name" symptom):
  // getRandomWords caps at the pool size (Math.min(count, pool.length)). If
  // your "كت/تفكيك" category in game-data.json has, say, only 4 unique
  // entries, asking for a round of 5+ names silently gives back only those
  // 4 - it LOOKS like the game "gives up" past the 4th name, but it's
  // actually just run out of unique words to hand out. This makes that
  // visible instead of silent, so it's obvious when it's a data problem
  // rather than a bug.
  if (nextWords.length < state.targetCount) {
    ctx.sock.sendMessage(chatId, {
      text: `⚠️ يوجد فقط ${nextWords.length} كلمة متاحة في هذه الفئة (تم طلب ${state.targetCount}).`
    }).catch(() => {});
  }

  // Reset target for the next round (timer is started AFTER sending, below)
  state.targetWords = nextWords;
  state.targetTotal = nextNormalized.length;
  state.remaining = buildRemaining(nextNormalized);
  state.matchedCount = 0;

  // Minimal required format response with tag
  const replyText = `+1 ${winnerMention} (${timeTaken}s)\n\n*${nextWords.join(' ')}*`;

  // Fire the reply WITHOUT blocking the processing queue. The next round's
  // target is already live above, so incoming messages get checked against
  // it immediately instead of waiting on this send's network round-trip.
  // The clock for the next round still only starts once this particular
  // send actually resolves (tracked separately).
  ctx.sock.sendMessage(
    chatId,
    {
      text: replyText,
      mentions: [winnerJid]
    },
    { quoted: m }
  )
    .then(() => {
      state.startTime = Date.now();
    })
    .catch(err => console.error('كت game send error:', err));
}

export default {
  name: 'مكت',
  aliases: ['سكت'],
  description: 'Fast-paced word matching game for كت/تفكيك',
  cooldown: 0, // No delay for hyper-fast typing

  async execute(ctx) {
    ensureGlobalListener(ctx);

    const store = ctx.store.namespace('katGame');
    const commandUsed = ctx.command.toLowerCase();

    // 1. STOP COMMAND (.سكت)
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
        text: `تم إيقاف اللعبة 🏁\n\nالنتائج النهائية:\n${lines.join('\n')}`,
        mentions
      });
      return;
    }

    // 2. START COMMAND (.مكت / .مكت 3 / .مكت3)
    let count = 1;
    const match = commandUsed.match(/^مكت(\d+)$/);

    if (match) {
      count = parseInt(match[1], 10);
    } else if (ctx.args.length > 0 && !isNaN(parseInt(ctx.args[0], 10))) {
      count = parseInt(ctx.args[0], 10);
    }

    if (count < 1) count = 1;

    // Check pool
    if (!ALL_WORDS.length) {
      await ctx.reply('خطأ: لم يتم العثور على كلمات في game-data.json');
      return;
    }

    // Pick target words
    const targetWords = getRandomWords(count);
    const targetNormalized = targetWords.map(normalizeText);

    if (targetWords.length < count) {
      await ctx.reply(`⚠️ يوجد فقط ${targetWords.length} كلمة متاحة في هذه الفئة (تم طلب ${count}).`);
    }

    // Initialize state (no per-game listener anymore - the global one handles dispatch)
    const state = {
      targetWords,
      targetCount: count,
      targetTotal: targetNormalized.length,
      remaining: buildRemaining(targetNormalized),
      matchedCount: 0,
      startTime: Date.now(), // placeholder, gets set for real right after the prompt is sent
      scores: {}, // jid -> points, used for the final scoreboard on .سكت
      queue: Promise.resolve() // Serializes processing WITHOUT dropping messages
    };

    // Replace any existing active game in this chat
    store.set(ctx.chatId, state);

    // Send initial prompt, then start the clock only once it's actually sent
    await ctx.reply(`*${targetWords.join(' ')}*`);
    state.startTime = Date.now();
  }
};