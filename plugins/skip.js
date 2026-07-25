import { getRandomQuestion, buildAnswersMap, pushHistory as pushTa3History, recentTracker as ta3Tracker } from './ta3.js';
import { getLocalImageList, pickRandom } from './pic.js';
import { getRandomQuestion as getRandomSSQuestion, buildAnswerData as buildSSAnswerData, getDisplayAnswers as getSSDisplayAnswers, pushHistory as pushSSHistory, recentTracker as ssTracker } from './ss.js';
import { getRandomWords, buildNormToOriginal, recentTracker as katTracker } from './kat.js';
import { normalizeStrict, normalizeLenient } from '../lib/normalizeArabic.js';
import { buildLetterSeqs, recentTracker as tafkikTracker } from './tafkik.js';

export default {
  name: 'سكب',
  aliases: ['skip', 'تخطي'],
  description: 'تخطي السؤال الحالي في المسابقة',
  cooldown: 2,

  async execute(ctx) {
    const chatId = ctx.chatId;

    const ta3Store = ctx.store.namespace('ta3Game');
    if (ta3Store.has(chatId)) {
      const state = ta3Store.get(chatId);
      if (state.isTransitioning) return;
      state.isTransitioning = true;

      const answersList = (state.answers || []).join(' ， ');
      const nextQ = getRandomQuestion(ta3Tracker.getExcluded(chatId));

      if (!nextQ) {
        ta3Store.delete(chatId);
        await ctx.reply(`*تم التخطي*\n\nالإجابة الصحيحة كانت:\n${answersList}\n\nخطأ: لم يتم العثور على أسئلة جديدة.`);
        state.isTransitioning = false;
        return;
      }

      ta3Tracker.record(chatId, [normalizeStrict(nextQ.question)]);

      state.currentQuestion = nextQ.question;
      state.answersMap = buildAnswersMap(nextQ.answers);
      state.answers = nextQ.answers;
      state.playerProgress = {};
      state.startTime = process.hrtime.bigint();

      pushTa3History(ctx, chatId, { question: nextQ.question, answers: nextQ.answers });

      await ctx.reply(`*تم التخطي*\n\nالإجابة الصحيحة كانت:\n${answersList}`);
      await ctx.reply(`*تع/3 ${nextQ.question}*`);

      state.isTransitioning = false;
      return;
    }

    const katStore = ctx.store.namespace('katGame');
    if (katStore.has(chatId)) {
      const state = katStore.get(chatId);
      const correctAnswers = state.targetWords.join(' - ');

      const nextWords = getRandomWords(state.targetCount, katTracker.getExcluded(chatId));

      if (!nextWords.length) {
        await ctx.reply(`*تم التخطي*\n\nالإجابة الصحيحة كانت:\n*${correctAnswers}*\n\nخطأ: لم يتم العثور على كلمات جديدة.`);
        return;
      }

      const nextNormalized = nextWords.map(normalizeLenient);
      katTracker.record(chatId, nextNormalized);

      state.targetWords = nextWords;
      state.targetNormalized = nextNormalized;
      state.targetTotal = nextNormalized.length;
      state.normToOriginal = buildNormToOriginal(nextWords, nextNormalized);
      state.players = {};
      state.startTime = process.hrtime.bigint();

      await ctx.reply(`*تم التخطي*\n\nالإجابة الصحيحة كانت:\n*${correctAnswers}*\n\n*${nextWords.join(' ')}*`);
      return;
    }

    const tafkikStore = ctx.store.namespace('tafkikGame');
    if (tafkikStore.has(chatId)) {
      const state = tafkikStore.get(chatId);
      const correctAnswers = state.targetWords.join(' - ');

      const nextWords = getRandomWords(state.targetCount, tafkikTracker.getExcluded(chatId));

      if (!nextWords.length) {
        await ctx.reply(`*تم التخطي*\n\nالإجابة الصحيحة كانت:\n*${correctAnswers}*\n\nخطأ: لم يتم العثور على كلمات جديدة.`);
        return;
      }

      const nextNormalized = nextWords.map(normalizeLenient);
      tafkikTracker.record(chatId, nextNormalized);

      state.targetWords = nextWords;
      state.targetNormalized = nextNormalized;
      state.targetLetterSeqs = buildLetterSeqs(nextNormalized);
      state.targetTotal = nextWords.length;
      state.players = {};
      state.startTime = process.hrtime.bigint();

      await ctx.reply(`*تم التخطي*\n\nالإجابة الصحيحة كانت:\n*${correctAnswers}*\n\n*${nextWords.join(' ')}*`);
      return;
    }

    const picStore = ctx.store.namespace('picGame');
    if (picStore.has(chatId)) {
      const state = picStore.get(chatId);
      const correctAnswer = state.currentItem?.answer || '';

      const list = getLocalImageList();
      const [nextItem] = pickRandom(list, 1, state.currentItem);

      if (!nextItem) {
        await ctx.reply(`*تم التخطي*\n\nالإجابة الصحيحة كانت:\n${correctAnswer}\n\nلا توجد صور أخرى متاحة.`);
        return;
      }

      state.currentItem = nextItem;
      state.answerVariants = nextItem.answerVariants;

      await ctx.reply(`*تم التخطي*\n\nالإجابة الصحيحة كانت:\n${correctAnswer}`);

      try {
        await ctx.sock.sendMessage(chatId, {
          image: { url: nextItem.path },
          jpegThumbnail: null
        });
        state.startTime = process.hrtime.bigint();
      } catch (err) {
        console.error('صورة game skip send error:', err);
      }
      return;
    }

    const ssStore = ctx.store.namespace('ssGame');
    if (ssStore.has(chatId)) {
      const state = ssStore.get(chatId);
      if (state.isTransitioning) return;
      state.isTransitioning = true;

      const answersList = getSSDisplayAnswers(state.answersRaw);
      const nextQ = getRandomSSQuestion(ssTracker.getExcluded(chatId));

      if (!nextQ) {
        ssStore.delete(chatId);
        await ctx.reply(`*تم التخطي*\n\nالإجابة الصحيحة كانت:\n${answersList}\n\nخطأ: لم يتم العثور على أسئلة جديدة.`);
        state.isTransitioning = false;
        return;
      }

      ssTracker.record(chatId, [normalizeStrict(nextQ.question)]);

      state.currentQuestion = nextQ.question;
      state.answersRaw = nextQ.answers;
      state.answerData = buildSSAnswerData(nextQ.answers);
      state.playerProgress = {};
      state.startTime = process.hrtime.bigint();

      pushSSHistory(ctx, chatId, { question: nextQ.question, answersRaw: nextQ.answers });

      await ctx.reply(`*تم التخطي*\n\nالإجابة الصحيحة كانت:\n${answersList}`);
      await ctx.reply(`*س/ ${nextQ.question}*`);

      state.isTransitioning = false;
      return;
    }

    await ctx.reply('لا توجد لعبة نشطة حالياً لتخطيها!');
  }
};
