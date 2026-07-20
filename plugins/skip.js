import fs from 'node:fs';
import path from 'node:path';

const GAME_DATA_PATH = path.resolve('plugins/game-data.json');
const PIC_CACHE_PATH = path.resolve('plugins/.pic-game-cache.json');

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

function getRandomItems(pool, count) {
  const n = pool.length;
  if (!n) return [];
  const take = Math.min(count, n);
  const copy = pool.slice();
  const result = new Array(take);
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(Math.random() * (n - i));
    result[i] = copy[j];
    copy[j] = copy[i];
  }
  return result;
}

function buildAnswersMap(answersArray) {
  const map = new Map();
  for (const ans of answersArray) {
    map.set(normalizeText(ans), true);
  }
  return map;
}

function loadKatData() {
  try {
    const raw = fs.readFileSync(GAME_DATA_PATH, 'utf-8');
    const data = JSON.parse(raw);
    return data['كت'] || [];
  } catch (e) {
    console.error('Skip Plugin - Error loading kat data:', e);
    return [];
  }
}

function loadTa3Data() {
  try {
    const raw = fs.readFileSync(GAME_DATA_PATH, 'utf-8');
    const data = JSON.parse(raw);
    return data['تع'] || [];
  } catch (e) {
    console.error('Skip Plugin - Error loading ta3 data:', e);
    return [];
  }
}

const KAT_POOL = loadKatData();
const TA3_POOL = loadTa3Data();

export default {
  name: 'سكب',
  aliases: ['تخطي', 'skip'],
  description: 'يتخطى السؤال الحالي لأي فعالية شغالة ويظهر الإجابة بدون احتساب نقاط',
  cooldown: 3,

  async execute(ctx) {
    const { sock, chatId, store, reply } = ctx;

    const katState = store.namespace('katGame').get(chatId);
    const ta3State = store.namespace('ta3Game').get(chatId);
    const picState = store.namespace('picGame').get(chatId);

    if (!katState && !ta3State && !picState) {
      return reply('لا توجد أي فعالية شغالة حالياً لتخطيها.');
    }

    if (katState) {
      const oldAnswers = katState.targetWords.join(' ');
      const nextWords = getRandomItems(KAT_POOL, katState.targetCount);
      if (!nextWords.length) return reply('حدث خطأ: لا توجد كلمات للتخطي.');

      const nextNormalized = nextWords.map(normalizeText);

      katState.targetWords = nextWords;
      katState.targetNormalized = nextNormalized;
      katState.targetTotal = nextNormalized.length;
      katState.players = {}; // Wipes the new individual player checklists clean
      katState.startTime = Date.now();

      await sock.sendMessage(chatId, {
        text: `تم التخطي ⏩\nالإجابة كانت: *${oldAnswers}*\n\nالسؤال التالي:\n*${nextWords.join(' ')}*`
      });
      return;
    }

    if (ta3State) {
      const oldQ = ta3State.currentQuestion;
      const oldValidAnswers = Array.from(ta3State.answersMap.keys()).join(' ، ');

      const nextQ = TA3_POOL[Math.floor(Math.random() * TA3_POOL.length)];
      if (!nextQ) return reply('حدث خطأ: لا توجد أسئلة للتخطي.');

      ta3State.currentQuestion = nextQ.question;
      ta3State.answersMap = buildAnswersMap(nextQ.answers);
      ta3State.playerProgress = {};
      ta3State.startTime = Date.now();

      await sock.sendMessage(chatId, {
        text: `تم التخطي ⏩\nبعض الإجابات الصحيحة لـ (${oldQ}) كانت: *${oldValidAnswers}*\n\n*تع/3 ${nextQ.question}*`
      });
      return;
    }

    if (picState) {
      const oldAnswer = picState.currentItem.answer;

      let list = [];
      try {
        const raw = fs.readFileSync(PIC_CACHE_PATH, 'utf-8');
        const saved = JSON.parse(raw);
        if (Array.isArray(saved.list)) list = saved.list;
      } catch (e) {
        console.error('Skip Plugin - Error loading pic cache:', e);
      }

      if (!list.length) {
        return reply('عذراً، لا يمكن جلب الصور حالياً للتخطي (الذاكرة المؤقتة فارغة).');
      }

      const poolList = list.filter(item => item.url !== picState.currentItem.url);
      const nextItem = poolList[Math.floor(Math.random() * poolList.length)];
      if (!nextItem) return reply('لا توجد صور أخرى للتخطي.');

      picState.currentItem = nextItem;
      picState.answerNormalized = nextItem.answerNormalized;

      await sock.sendMessage(chatId, { text: `تم التخطي ⏩\nالإجابة كانت: *${oldAnswer}*` });

      try {
        const res = await fetch(nextItem.url);
        if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        await sock.sendMessage(chatId, { image: buf });
        picState.startTime = Date.now();
      } catch (err) {
        console.error('Skip Plugin - Pic fetch error:', err);
        await sock.sendMessage(chatId, { text: 'حدث خطأ أثناء جلب الصورة التالية. أوقف اللعبة بـ .سص وابدأ من جديد.' });
      }
      return;
    }
  }
};
