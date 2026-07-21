import fs from 'node:fs';
import path from 'node:path';

// مسار ملف البيانات لجلب أسئلة وأجوبة الـ تع (تم الحفاظ على مسارك المحدث)
const GAME_DATA_PATH = path.resolve('plugins/game-data.json');

function loadGameData() {
  try {
    const raw = fs.readFileSync(GAME_DATA_PATH, 'utf-8');
    const data = JSON.parse(raw);
    return data['تع'] || []; // الاعتماد على قسم "تع" كمصدر رئيسي
  } catch (err) {
    console.error('Error loading game-data.json:', err);
    return [];
  }
}

const TA3_POOL = loadGameData();

// دالة تنظيف وتوحيد النصوص العربية الفائقة لسرعة المطابقة
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

// اختيار سؤال عشوائي من فئة الـ تع
export function getRandomQuestion() {
  if (!TA3_POOL.length) return null;
  const randomIndex = Math.floor(Math.random() * TA3_POOL.length);
  return TA3_POOL[randomIndex];
}

// بناء خريطة الأجوبة المتاحة للسؤال الحالي لمنع التكرار
export function buildAnswersMap(answersArray) {
  const map = new Map();
  for (const ans of answersArray) {
    map.set(normalizeText(ans), true);
  }
  return map;
}

const registeredSocks = new WeakSet();

// نظام الاستماع الموحد للـ Bot بالكامل (أداء خفيف فائق وسريع جداً)
function ensureGlobalListener(ctx) {
  if (registeredSocks.has(ctx.sock)) return;
  registeredSocks.add(ctx.sock);

  ctx.sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify' && type !== 'append') return;

    const store = ctx.store.namespace('ta3Game');

    for (const m of messages) {
      if (!m.message || m.key.fromMe) continue;

      const chatId = m.key.remoteJid;
      const state = store.get(chatId);
      if (!state) continue; 

      // طابور معالجة متوالي يضمن عدم سقوط أي رسالة عند الكتاب السريعين جداً
      state.queue = state.queue
        .then(() => processMessage(ctx, chatId, state, m))
        .catch(err => console.error('تع game processing error:', err));
    }
  });
}

// معالجة الرسائل والتحقق من الـ 3 أسماء المطلوبة عبر التجميع المستمر لكل لاعب
async function processMessage(ctx, chatId, state, m) {
  const store = ctx.store.namespace('ta3Game');
  if (store.get(chatId) !== state) return;

  const text =
    m.message?.conversation ||
    m.message?.extendedTextMessage?.text ||
    '';

  if (!text) return;

  const normInput = normalizeText(text);
  // الفصل بناءً على أي مسافات أو رموز لضمان التقاط الأسماء بشكل منفصل
  const incomingWords = normInput.split(/[^\u0621-\u064A]+/).filter(Boolean);

  const senderJid = m.key.participant || m.key.remoteJid;

  // إنشاء سجل إجابات تراكمي خاص بهذا اللاعب إذا لم يكن موجوداً في هذا السؤال
  if (!state.playerProgress[senderJid]) {
    state.playerProgress[senderJid] = new Set();
  }

  const playerFoundSet = state.playerProgress[senderJid];

  // فحص الكلمات المرسلة لمطابقتها مع الأجوبة المتاحة وغير المكتشفة سابقاً بواسطة هذا اللاعب
  for (let i = 0; i < incomingWords.length; i++) {
    // فحص الاسم الثنائي أولاً
    if (i < incomingWords.length - 1) {
      const duoCandidate = `${incomingWords[i]} ${incomingWords[i+1]}`;
      if (state.answersMap.has(duoCandidate) && !playerFoundSet.has(duoCandidate)) {
        playerFoundSet.add(duoCandidate);
        i++; // قفز المقطع التالي لأنه تم استهلاكه
        continue;
      }
    }
    // فحص الاسم الأحادي
    const monoCandidate = incomingWords[i];
    if (state.answersMap.has(monoCandidate) && !playerFoundSet.has(monoCandidate)) {
      playerFoundSet.add(monoCandidate);
    }
  }

  // إذا وصل مجموع الأسماء الفرعية الصحيحة المجمعة بواسطة هذا اللاعب إلى 3
  if (playerFoundSet.size >= 3) {
    if (state.isTransitioning) return;
    state.isTransitioning = true;

    const timeTaken = ((Date.now() - state.startTime) / 1000).toFixed(3);
    const winnerMention = `@${senderJid.split('@')[0]}`;

    // احتساب النقطة في نظام الترتيب والـ Leaderboard الخاص بـ kat
    state.scores[senderJid] = (state.scores[senderJid] || 0) + 1;

    // جلب سؤال تع جديد للراند التالي فوراً
    const nextQ = getRandomQuestion();
    if (!nextQ) {
      store.delete(chatId);
      ctx.sock.sendMessage(chatId, { text: 'خطأ: لم يتم العثور على أسئلة في فئة تع.' }).catch(() => {});
      state.isTransitioning = false;
      return;
    }

    // تحديث بيانات الجولة القادمة وتصفير تقدم اللاعبين المؤقت فوراً
    state.currentQuestion = nextQ.question;
    state.answersMap = buildAnswersMap(nextQ.answers);
    state.answers = nextQ.answers;
    state.playerProgress = {};
    state.startTime = Date.now();

    // صياغة نص الإرسال المطلوب: تع/3 + النقطة + التايم + السؤال الجديد
    const replyText = `+1 ${winnerMention} (${timeTaken}s)\n\n*تع/3 ${nextQ.question}*`;

    ctx.sock.sendMessage(
      chatId,
      {
        text: replyText,
        mentions: [senderJid]
      },
      { quoted: m }
    ).then(() => {
      state.startTime = Date.now();
      state.isTransitioning = false;
    }).catch(err => {
      console.error('تع game send error:', err);
      state.isTransitioning = false;
    });
  }
  // إذا كانت المدخلات ناقصة أو بها أخطاء، يسجل البوت الكلمات الصحيحة فقط وينتظر الباقي بصمت تام دون قفل المحاولة
}

export default {
  name: 'متع',
  aliases: ['ستع'],
  description: 'طور تع الثلاثي التراكمي الفردي فائق السرعة بنظام احتساب kat المستمر',
  cooldown: 0, 

  async execute(ctx) {
    ensureGlobalListener(ctx);

    const store = ctx.store.namespace('ta3Game');
    const commandUsed = ctx.command.toLowerCase();

    // 1. أمر إنهاء الفعالية (.ستع) وضخ لوحة الصدارة النهائية
    if (commandUsed === 'ستع') {
      if (!store.has(ctx.chatId)) {
        await ctx.reply('لا توجد فعالية تع شغال حالياً.');
        return;
      }
      const oldState = store.get(ctx.chatId);
      store.delete(ctx.chatId);

      const leaderboard = Object.entries(oldState.scores || {}).sort((a, b) => b[1] - a[1]);

      if (leaderboard.length === 0) {
        await ctx.reply('تم إيقاف الفعالية. لم يسجل أحد أي نقطة.');
        return;
      }

      const lines = leaderboard.map(([jid, pts], i) => `${i + 1}. @${jid.split('@')[0]} - ${pts}`);
      const mentions = leaderboard.map(([jid]) => jid);

      await ctx.sock.sendMessage(ctx.chatId, {
        text: `تم إيقاف الفعالية\n\nالنتائج النهائية:\n${lines.join('\n')}`,
        mentions
      });
      return;
    }

    // 2. أمر بدء الفعالية (.متع)
    ctx.store.namespace('katGame').delete(ctx.chatId);
    ctx.store.namespace('picGame').delete(ctx.chatId);
    ctx.store.namespace('ssGame').delete(ctx.chatId);

    if (!TA3_POOL.length) {
      await ctx.reply('علقت');
      return;
    }

    const firstQ = getRandomQuestion();
    if (!firstQ) return;

    // إنشاء الـ State وحقن كائن التجميع التراكمي الفردي playerProgress مع الـ Queue
    const state = {
      currentQuestion: firstQ.question,
      answersMap: buildAnswersMap(firstQ.answers),
      answers: firstQ.answers,
      playerProgress: {},
      startTime: Date.now(),
      scores: {}, 
      queue: Promise.resolve(),
      isTransitioning: false
    };

    store.set(ctx.chatId, state);

    // إرسال السؤال الأول بصيغة البداية المطلوبة: *تع/3 [اسم السؤال]*
    await ctx.reply(`*تع/3 ${firstQ.question}*`);
    state.startTime = Date.now();
  }
};