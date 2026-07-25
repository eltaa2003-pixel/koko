import fs from 'node:fs';
import path from 'node:path';
import { recordWin } from '../lib/playerStats.js';
import { normalizeStrict } from '../lib/normalizeArabic.js';

const IMAGES_DIR = path.resolve('saved_images');
const IMAGE_EXT_RE = /\.(jpe?g|png|webp)$/i;

function filenameToAnswer(filename) {
  return filename
    .replace(IMAGE_EXT_RE, '')
    .trim();
}

// Strips a trailing "duplicate picture" number off a name, in whatever
// form it shows up: "رين2", "رين-2", "رين_2", "رين 2", "رين (2)" all
// become just "رين". Applied per variant (after splitting on , | ،) so it
// works even when a duplicate-numbered file also lists multiple accepted
// spellings, e.g. هاشفلد,هاشفيلد2.jpg -> "هاشفلد" and "هاشفيلد".
function stripDuplicateSuffix(name) {
  return name
    .replace(/\s*\(\d+\)\s*$/, '')
    .replace(/[-_\s]*\d+$/, '')
    .trim();
}

// Matching is intentionally strict: exact word match only. Any accepted
// alternate spelling (e.g. هاشفلد vs هاشفيلد) needs to be listed explicitly
// in the filename, separated by "|", "," or "،" — see getLocalImageList
// below. This avoids any risk of two different names being confused for
// each other.

let cachedImageList = null;

export function getLocalImageList() {
  if (cachedImageList) return cachedImageList;

  try {
    if (!fs.existsSync(IMAGES_DIR)) {
      fs.mkdirSync(IMAGES_DIR, { recursive: true });
      return [];
    }
    const files = fs.readdirSync(IMAGES_DIR).filter(file => IMAGE_EXT_RE.test(file));

    cachedImageList = files.map(filename => {
      const fullPath = path.join(IMAGES_DIR, filename);
      const rawAnswer = filenameToAnswer(filename);
      // Accept "|", "," and the Arabic "،" as ways to separate multiple
      // accepted spellings in a filename, e.g. هاشفلد,هاشفيلد.jpg or
      // هاشفلد|هاشفيلد.jpg both work and are treated as two variants.
      const variants = rawAnswer
        .split(/[|,،]/)
        .map(s => stripDuplicateSuffix(s.trim()))
        .filter(Boolean);
      const ext = path.extname(filename).toLowerCase();
      let mime = 'image/jpeg';
      if (ext === '.png') mime = 'image/png';
      if (ext === '.webp') mime = 'image/webp';

      return {
        name: filename,
        path: fullPath,
        answer: variants[0],
        answerVariants: variants.map(v => normalizeStrict(v)),
        mimeType: mime
      };
    });

    return cachedImageList;
  } catch (err) {
    console.error('Error reading local saved_images directory:', err);
    return [];
  }
}

export function pickRandom(list, count, exclude) {
  const pool = exclude ? list.filter(item => item.name !== exclude.name) : list.slice();
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
      if (!state) continue; 

      state.queue = state.queue
        .then(() => processMessage(ctx, chatId, state, m))
        .catch(err => console.error('صورة game processing error:', err));
    }
  });
}

async function processMessage(ctx, chatId, state, m) {
  const store = ctx.store.namespace('picGame');
  if (store.get(chatId) !== state) return; 

  const text =
    m.message?.conversation ||
    m.message?.extendedTextMessage?.text ||
    m.message?.imageMessage?.caption ||
    m.message?.videoMessage?.caption ||
    '';
  if (!text) return;

  const incomingWords = normalizeStrict(text).split(/[^\u0621-\u064A]+/).filter(Boolean);
  if (!incomingWords.length) return;

  const answerWords = state.answerVariants;
  const winLens = answerWords.map(v => v.split(' ').filter(Boolean).length).filter(len => len > 0);
  if (!winLens.length) return;

  let hit = false;
  for (const variant of state.answerVariants) {
    const answerWords = variant.split(' ').filter(Boolean);
    const winLen = answerWords.length;
    if (!winLen) continue;

    for (let i = 0; i + winLen <= incomingWords.length; i++) {
      let ok = true;
      for (let k = 0; k < winLen; k++) {
        if (incomingWords[i + k] !== answerWords[k]) { ok = false; break; }
      }
      if (ok) { hit = true; break; }
    }
    if (hit) break;
  }
  if (!hit) return;

  const timeTaken = Number(process.hrtime.bigint() - state.startTime) / 1e9;
  const winnerJid = m.key.participant || m.key.remoteJid;
  const winnerMention = `@${winnerJid.split('@')[0]}`;
  state.scores[winnerJid] = (state.scores[winnerJid] || 0) + 1;

  try {
    await recordWin({ jid: winnerJid, game: 'صور', timeTaken, label: state.currentItem.answer, answeredCount: 1 });
  } catch (err) {
    console.error('recordWin failed:', err);
  }

  const list = getLocalImageList();
  const [nextItem] = pickRandom(list, 1, state.currentItem);
  if (!nextItem) {
    await ctx.sock.sendMessage(chatId, { text: 'لا توجد صور متاحة في مجلد saved_images.' }).catch(() => {});
    return;
  }
  
  state.currentItem = nextItem;
  state.answerVariants = nextItem.answerVariants;

  try {
    await ctx.sock.sendMessage(
      chatId,
      {
        image: { url: nextItem.path },
        caption: `+1 ${winnerMention} (${timeTaken.toFixed(3)}s)`,
        mentions: [winnerJid],
        jpegThumbnail: null // Force Baileys to skip thumbnail generation
      },
      { quoted: m }
    );
    state.startTime = process.hrtime.bigint();
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

    const list = getLocalImageList();
    if (!list.length) {
      await ctx.reply('خطأ: مجلد saved_images فارغ أو غير موجود.');
      return;
    }

    if (commandUsed === 'ص') {
      const [item] = pickRandom(list, 1);
      try {
        await ctx.sock.sendMessage(ctx.chatId, { 
          image: { url: item.path },
          jpegThumbnail: null // Skip processing
        });
      } catch (err) {
        console.error('random pic send error:', err);
        await ctx.reply('صار خطأ بجلب الصورة، تأكد من وجود ملفات في المجلد.');
      }
      return;
    }

    ensureGlobalListener(ctx);

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
        text: `تم إيقاف اللعبة\n\nالنتائج النهائية:\n${lines.join('\n')}`,
        mentions
      });
      return;
    }

    ctx.store.namespace('katGame').delete(ctx.chatId);
    ctx.store.namespace('ta3Game').delete(ctx.chatId);
    ctx.store.namespace('ssGame').delete(ctx.chatId);
    ctx.store.namespace('tafkikGame').delete(ctx.chatId);

    const [firstItem] = pickRandom(list, 1);
    const state = {
      currentItem: firstItem,
      answerVariants: firstItem.answerVariants,
      startTime: process.hrtime.bigint(), 
      scores: {},
      queue: Promise.resolve()
    };

    store.set(ctx.chatId, state);

    try {
      await ctx.sock.sendMessage(ctx.chatId, { 
        image: { url: firstItem.path },
        jpegThumbnail: null // Skip processing
      });
      state.startTime = process.hrtime.bigint();
    } catch (err) {
      console.error('start pic game error:', err);
      await ctx.reply('تعذر تحميل الصورة الأولى.');
      store.delete(ctx.chatId);
    }
  }
};