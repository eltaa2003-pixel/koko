import fs from 'node:fs';
import path from 'node:path';

const IMAGES_DIR = path.resolve('saved_images');
const IMAGE_EXT_RE = /\.(jpe?g|png|webp)$/i;

// --- MEMORY LOGGER ---
function logMemory(step) {
  const mem = process.memoryUsage();
  const format = (bytes) => (bytes / 1024 / 1024).toFixed(2) + ' MB';
  console.log(`[Memory - ${step}] RSS: ${format(mem.rss)} | Heap Total: ${format(mem.heapTotal)} | Heap Used: ${format(mem.heapUsed)}`);
}

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
    .replace(/[جقغ]/g, 'ق')                
    .replace(/\s+/g, ' ');
}

function filenameToAnswer(filename) {
  return filename
    .replace(IMAGE_EXT_RE, '')
    .replace(/\s*\(\d+\)\s*$/, '')
    .replace(/[-_]\d+$/, '')
    .trim();
}

function getLocalImageList() {
  try {
    if (!fs.existsSync(IMAGES_DIR)) {
      fs.mkdirSync(IMAGES_DIR, { recursive: true });
      return [];
    }
    const files = fs.readdirSync(IMAGES_DIR).filter(file => IMAGE_EXT_RE.test(file));
    
    return files.map(filename => {
      const fullPath = path.join(IMAGES_DIR, filename);
      const answer = filenameToAnswer(filename);
      return {
        name: filename,
        path: fullPath,
        answer,
        answerNormalized: normalizeText(answer)
      };
    });
  } catch (err) {
    console.error('Error reading local saved_images directory:', err);
    return [];
  }
}

function pickRandom(list, count, exclude) {
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

  const list = getLocalImageList();
  const [nextItem] = pickRandom(list, 1, state.currentItem);
  if (!nextItem) {
    await ctx.sock.sendMessage(chatId, { text: '⚠️ لا توجد صور متاحة في مجلد saved_images.' }).catch(() => {});
    return;
  }
  
  state.currentItem = nextItem;
  state.answerNormalized = nextItem.answerNormalized;

  try {
    logMemory(`Round Won - Before sending next image: ${nextItem.name}`);
    await ctx.sock.sendMessage(
      chatId,
      {
        image: { url: nextItem.path },
        caption: `+1 ${winnerMention} (${timeTaken}s)`,
        mentions: [winnerJid],
        jpegThumbnail: null // Force Baileys to skip thumbnail generation
      },
      { quoted: m }
    );
    logMemory(`Round Won - After sending next image`);
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

    logMemory(`Command Executed: ${commandUsed}`);

    const list = getLocalImageList();
    if (!list.length) {
      await ctx.reply('خطأ: مجلد saved_images فارغ أو غير موجود.');
      return;
    }

    if (commandUsed === 'ص') {
      const [item] = pickRandom(list, 1);
      try {
        logMemory(`[ص] Before sending random image: ${item.name}`);
        await ctx.sock.sendMessage(ctx.chatId, { 
          image: { url: item.path },
          jpegThumbnail: null // Skip processing
        });
        logMemory(`[ص] After sending random image`);
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
        text: `تم إيقاف اللعبة 🏁\n\nالنتائج النهائية:\n${lines.join('\n')}`,
        mentions
      });
      return;
    }

    ctx.store.namespace('katGame').delete(ctx.chatId);
    ctx.store.namespace('ta3Game').delete(ctx.chatId);

    const [firstItem] = pickRandom(list, 1);
    const state = {
      currentItem: firstItem,
      answerNormalized: firstItem.answerNormalized,
      startTime: Date.now(), 
      scores: {},
      queue: Promise.resolve()
    };

    store.set(ctx.chatId, state);

    try {
      logMemory(`[مص] Before sending FIRST image: ${firstItem.name}`);
      await ctx.sock.sendMessage(ctx.chatId, { 
        image: { url: firstItem.path },
        jpegThumbnail: null // Skip processing
      });
      logMemory(`[مص] After sending FIRST image`);
      state.startTime = Date.now();
    } catch (err) {
      console.error('start pic game error:', err);
      await ctx.reply('تعذر تحميل الصورة الأولى.');
      store.delete(ctx.chatId);
    }
  }
};