import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ============================================================
// Picture guessing game — one file, three commands:
//   .مص   -> start a tournament round
//   سص    -> stop it / show the scoreboard   (alias)
//   ص     -> send one random picture, no scoring, spam freely (alias)
//
// Images are pulled straight from:
//   https://github.com/eltaa2003-pixel/images/tree/main/saved_images
// ============================================================

// ---- CONFIG ----
const GITHUB_OWNER = 'eltaa2003-pixel';
const GITHUB_REPO = 'images';
const GITHUB_BRANCH = 'main';
const GITHUB_PATH = 'saved_images';

// No GITHUB_TOKEN needed - jsDelivr's public CDN/data API requires no auth.

// How long the file list is cached before re-checking GitHub for new/removed
// images. Kept high so a round never waits on a GitHub API call - only the
// first game after a restart (or after this expires) pays that cost.
const LIST_CACHE_MS = 30 * 60 * 1000; // 30 minutes
const FAILURE_BACKOFF_MS = 2 * 60 * 1000; // 2 minutes - retry sooner than a normal refresh after an error

// The in-memory cache alone resets every time the bot process restarts,
// which during dev/testing can happen dozens of times an hour - each
// restart otherwise means an immediate fresh GitHub API call. Persisting
// the list to disk means a restart reads the last known list instead of
// hitting GitHub again, and only actually refreshes once LIST_CACHE_MS has
// genuinely elapsed in real time.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DISK_CACHE_PATH = path.join(__dirname, '.pic-game-cache.json');

const IMAGE_EXT_RE = /\.(jpe?g|png|webp)$/i;

// ------------------------------------------------------------
// Arabic normalization — same base rules kat.js uses (diacritics,
// Alef/Ta-Marbouta/Yeh variants, invisible chars...) PLUS: ج / ق / غ are
// folded into one letter, since dialect typing swaps these interchangeably
// and a correct answer shouldn't get rejected over that.
// ------------------------------------------------------------
function normalizeText(text) {
  if (!text) return '';
  return text
    .trim()
    .replace(/[\u200B-\u200F\uFEFF]/g, '') // invisible zero-width/BOM chars
    .replace(/\u0640/g, '')                // tatweel/kashida
    .replace(/[\u064B-\u0652]/g, '')       // diacritics (tashkeel)
    .replace(/[أإآ]/g, 'ا')                // Alef variants
    .replace(/ة/g, 'ه')                    // Ta Marbouta
    .replace(/ۃ/g, 'ه')                    // Urdu Ta Marbouta look-alike
    .replace(/ى/g, 'ي')                    // Alef Maqsura
    .replace(/[یے]/g, 'ي')                 // Persian/Urdu Yeh look-alikes
    .replace(/ک/g, 'ك')                    // Persian Keheh -> Arabic Kaf
    .replace(/ہ/g, 'ه')                    // Urdu Heh Goal
    .replace(/[جقغ]/g, 'ق')                // ج / ق / غ treated as the same letter
    .replace(/\s+/g, ' ');
}

// Turns "اسم (2).jpeg" or "اسم-2.jpeg" into "اسم" - handles the duplicate-
// file suffixes GitHub/Windows tend to add without breaking the real answer.
function filenameToAnswer(filename) {
  return filename
    .replace(IMAGE_EXT_RE, '')
    .replace(/\s*\(\d+\)\s*$/, '')
    .replace(/[-_]\d+$/, '')
    .trim();
}

let cachedList = null;    // [{ name, answer, answerNormalized, url }]
let cachedAt = 0;
let inFlightFetch = null; // dedupes concurrent refreshes

// Load whatever was last saved to disk, if anything, so a bot restart
// doesn't immediately have to hit the network again.
try {
  const raw = fs.readFileSync(DISK_CACHE_PATH, 'utf-8');
  const saved = JSON.parse(raw);
  if (Array.isArray(saved.list) && typeof saved.cachedAt === 'number') {
    cachedList = saved.list;
    cachedAt = saved.cachedAt;
  }
} catch {
  // no cache file yet, or it's unreadable - fine, will fetch fresh below
}

function saveDiskCache() {
  try {
    fs.writeFileSync(DISK_CACHE_PATH, JSON.stringify({ list: cachedList, cachedAt }));
  } catch (err) {
    console.error('Could not write pic-game disk cache:', err);
  }
}

// ------------------------------------------------------------
// jsDelivr is a free CDN that mirrors every public GitHub repo. Its data
// API lists a repo's full file tree with no auth and no meaningful rate
// limit (this is almost certainly what your earlier bot used - it's the
// standard way to pull files from a GitHub repo "infinitely" without
// running into api.github.com's 60 req/hour unauthenticated cap). Actual
// image bytes are then served from cdn.jsdelivr.net, a real CDN, not the
// GitHub API at all.
//
// Trade-off vs the GitHub API directly: jsDelivr caches branch content for
// a while (roughly half a day), so brand-new images you just pushed may
// take a bit to show up here. If you need them instantly, hit the purge
// endpoint after pushing:
//   https://purge.jsdelivr.net/gh/OWNER/REPO@BRANCH/PATH
// ------------------------------------------------------------
async function fetchFromGithub() {
  const listUrl = `https://data.jsdelivr.com/v1/package/gh/${GITHUB_OWNER}/${GITHUB_REPO}@${GITHUB_BRANCH}`;
  
  const res = await fetch(listUrl, {
    headers: {
      'User-Agent': 'WhatsApp-Bot-Client'
    }
  });

  if (!res.ok) {
    throw new Error(`jsDelivr metadata fetch failed: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();

  const findFilesRecursive = (node, currentPath = '') => {
    let files = [];
    if (!node.files) return files;
    for (const f of node.files) {
      const fullPath = currentPath ? `${currentPath}/${f.name}` : f.name;
      if (f.type === 'file' && IMAGE_EXT_RE.test(f.name) && fullPath.startsWith(GITHUB_PATH)) {
        files.push(f.name);
      } else if (f.type === 'directory') {
        files = files.concat(findFilesRecursive(f, fullPath));
      }
    }
    return files;
  };

  const filenames = findFilesRecursive(data);

  return filenames.map(filename => {
    const rawUrl = `https://cdn.jsdelivr.net/gh/${GITHUB_OWNER}/${GITHUB_REPO}@${GITHUB_BRANCH}/${GITHUB_PATH}/${encodeURIComponent(filename)}`;
    const answer = filenameToAnswer(filename);
    return {
      name: filename,
      answer,
      answerNormalized: normalizeText(answer),
      url: rawUrl
    };
  });
}

// Cached accessor - the hot path. Almost always resolves from memory; only
// hits the network once per LIST_CACHE_MS window, and concurrent callers
// share a single in-flight request instead of stampeding GitHub.
async function getImageList() {
  const now = Date.now();
  if (cachedList && now - cachedAt < LIST_CACHE_MS) return cachedList;
  if (inFlightFetch) return inFlightFetch;

  inFlightFetch = fetchFromGithub()
    .then(list => {
      cachedList = list;
      cachedAt = Date.now();
      saveDiskCache();
      return list;
    })
    .catch(err => {
      console.error('Error fetching image list from GitHub:', err);
      // Back off instead of retrying GitHub on every single command call -
      // that just burns through the rate limit faster once you're already
      // rate-limited. Use the shorter FAILURE_BACKOFF_MS window (not the
      // full LIST_CACHE_MS) so it recovers on its own reasonably fast once
      // the rate limit resets.
      cachedAt = Date.now() - LIST_CACHE_MS + FAILURE_BACKOFF_MS;
      return cachedList || []; // stale data beats a dead game
    })
    .finally(() => {
      inFlightFetch = null;
    });

  return inFlightFetch;
}

// ------------------------------------------------------------
// Image bytes cache. Once a picture has been sent once (in ANY chat), the
// raw buffer stays in memory so every later send of that same picture is
// instant instead of re-downloading from raw.githubusercontent.com.
// ------------------------------------------------------------
const bufferCache = new Map(); // url -> Buffer
const MAX_CACHED_IMAGES = 500; // simple cap so this can't grow unbounded

async function getImageBuffer(url) {
  const cached = bufferCache.get(url);
  if (cached) return cached;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Image download failed: ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());

  if (bufferCache.size >= MAX_CACHED_IMAGES) {
    const oldestKey = bufferCache.keys().next().value; // Map keeps insertion order
    bufferCache.delete(oldestKey);
  }
  bufferCache.set(url, buf);
  return buf;
}

// Fire-and-forget warm-up. Call right after picking the NEXT round's image
// (while the "you won" message for the current round is still going out)
// so the buffer is already cached by the time it's actually needed.
function prefetchImage(url) {
  getImageBuffer(url).catch(() => {}); // real errors surface on the actual send
}

// ------------------------------------------------------------
// Partial Fisher-Yates pick - same technique kat.js uses for word rounds:
// O(count) instead of sorting the whole list, and actually uniform (unlike
// `.sort(() => Math.random() - 0.5)`, which is biased). `exclude` optionally
// drops one item so you don't get the same picture twice in a row.
// ------------------------------------------------------------
function pickRandom(list, count, exclude) {
  const pool = exclude ? list.filter(item => item.url !== exclude.url) : list.slice();
  const m = pool.length;
  if (!m) return [];
  const take = Math.min(count, m);
  const result = new Array(take);
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(Math.random() * (m - i));
    result[i] = pool[j];
    pool[j] = pool[i];
  }
  return result;
}

// ============================================================
// Game engine — direct port of kat.js's architecture:
//  - ONE messages.upsert listener per socket (registered once, guarded by
//    a WeakSet) instead of a new listener per game, so every incoming
//    message does a single O(1) store lookup no matter how many chats
//    have games running.
//  - Per-chat state carries a `queue` promise chain so messages landing in
//    the same tick are still processed in strict order with zero loss.
//  - The next round's picture is picked + prefetched before the "you won"
//    message finishes sending, so there's no dead time between rounds.
// ============================================================

const registeredSocks = new WeakSet();

function ensureGlobalListener(ctx) {
  if (registeredSocks.has(ctx.sock)) return;
  registeredSocks.add(ctx.sock);

  ctx.sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify' && type !== 'append') return;

    const store = ctx.store.namespace('picGame');

    for (const m of messages) {
      if (!m.message || m.key.fromMe) continue;

      const chatId = m.key.remoteJid;
      const state = store.get(chatId);
      if (!state) continue; // no active game here - cheap skip

      state.queue = state.queue
        .then(() => processMessage(ctx, chatId, state, m))
        .catch(err => console.error('صورة game processing error:', err));
    }
  });
}

async function processMessage(ctx, chatId, state, m) {
  const store = ctx.store.namespace('picGame');
  if (store.get(chatId) !== state) return; // game was stopped/replaced while queued

  const text =
    m.message?.conversation ||
    m.message?.extendedTextMessage?.text ||
    m.message?.imageMessage?.caption ||
    m.message?.videoMessage?.caption ||
    '';
  if (!text) return;

  // Split into Arabic-letter tokens (same approach as kat.js) so extra
  // chatter around the name ("بس هيك؟ كينق") still matches, and slide the
  // answer's word-window across the tokens so multi-word answers can land
  // as a unit even mid-sentence.
  const incomingWords = normalizeText(text).split(/[^\u0621-\u064A]+/).filter(Boolean);
  if (!incomingWords.length) return;

  const answerWords = state.answerNormalized.split(' ').filter(Boolean);
  const winLen = answerWords.length;
  if (!winLen) return;

  let hit = false;
  for (let i = 0; i + winLen <= incomingWords.length; i++) {
    let ok = true;
    for (let k = 0; k < winLen; k++) {
      if (incomingWords[i + k] !== answerWords[k]) { ok = false; break; }
    }
    if (ok) { hit = true; break; }
  }
  if (!hit) return;

  const timeTaken = ((Date.now() - state.startTime) / 1000).toFixed(3);
  const winnerJid = m.key.participant || m.key.remoteJid;
  const winnerMention = `@${winnerJid.split('@')[0]}`;
  state.scores[winnerJid] = (state.scores[winnerJid] || 0) + 1;

  const list = await getImageList();
  const [nextItem] = pickRandom(list, 1, state.currentItem);
  if (!nextItem) {
    await ctx.sock.sendMessage(chatId, { text: '⚠️ لا توجد صور متاحة حالياً في مصدر GitHub.' }).catch(() => {});
    return;
  }
  state.currentItem = nextItem;
  state.answerNormalized = nextItem.answerNormalized;
  prefetchImage(nextItem.url);

  try {
    const buf = await getImageBuffer(nextItem.url);
    await ctx.sock.sendMessage(
      chatId,
      {
        image: buf,
        caption: `+1 ${winnerMention} (${timeTaken}s)`,
        mentions: [winnerJid]
      },
      { quoted: m }
    );
    // clock for the NEXT round starts once this image has actually gone out
    state.startTime = Date.now();
  } catch (err) {
    console.error('صورة game send error:', err);
  }
}

export default {
  name: 'مص',
  aliases: ['سص', 'ص'],
  description: 'لعبة تخمين الصور: .مص يبدأ، سص يوقف، ص يرسل صورة عشوائية بدون نقاط',
  cooldown: 0,

  async execute(ctx) {
    const commandUsed = ctx.command.toLowerCase();
    const store = ctx.store.namespace('picGame');

    // ---- RANDOM, NO-SCORE COMMAND (ص) ----
    if (commandUsed === 'ص') {
      const list = await getImageList();
      if (!list.length) {
        await ctx.reply('خطأ: لم يتم العثور على صور في مصدر GitHub.');
        return;
      }
      const [item] = pickRandom(list, 1);
      try {
        const buf = await getImageBuffer(item.url);
        await ctx.sock.sendMessage(ctx.chatId, { image: buf });
        // warm the cache for the next .ص while nobody's waiting on it
        const [warm] = pickRandom(list, 1, item);
        if (warm) prefetchImage(warm.url);
      } catch (err) {
        console.error('random pic send error:', err);
        await ctx.reply('صار خطأ بجلب الصورة، جرب مرة ثانية.');
      }
      return;
    }

    ensureGlobalListener(ctx);

    // ---- STOP COMMAND (سص) ----
    if (commandUsed === 'سص') {
      if (!store.has(ctx.chatId)) {
        await ctx.reply('لا توجد لعبة صور شغالة حالياً.');
        return;
      }
      const oldState = store.get(ctx.chatId);
      store.delete(ctx.chatId);

      const leaderboard = Object.entries(oldState.scores || {}).sort((a, b) => b[1] - a[1]);
      if (!leaderboard.length) {
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

    // ---- START COMMAND (مص) ----
    ctx.store.namespace('katGame').delete(ctx.chatId);
    ctx.store.namespace('ta3Game').delete(ctx.chatId);

    const list = await getImageList();
    if (!list.length) {
      await ctx.reply('خطأ: لم يتم العثور على صور في مصدر GitHub.');
      return;
    }

    const [firstItem] = pickRandom(list, 1);
    const state = {
      currentItem: firstItem,
      answerNormalized: firstItem.answerNormalized,
      startTime: Date.now(), // placeholder, set for real right after the send below
      scores: {},
      queue: Promise.resolve()
    };

    // Replace any existing active game in this chat
    store.set(ctx.chatId, state);

    const buf = await getImageBuffer(firstItem.url);
    await ctx.sock.sendMessage(ctx.chatId, { image: buf });
    state.startTime = Date.now();
  }
};