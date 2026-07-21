import { getRandomQuestion, buildAnswersMap } from './ta3.js';
import { getLocalImageList, pickRandom } from './pic.js';
import { getRandomQuestion as getRandomSSQuestion, buildAnswerData as buildSSAnswerData, getDisplayAnswers as getSSDisplayAnswers } from './ss.js';

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

      const answersList = (state.answers || []).join(' ، ');
      const nextQ = getRandomQuestion();

      if (!nextQ) {
        ta3Store.delete(chatId);
        await ctx.reply(`*تم التخطي*\n\nالإجابة الصحيحة كانت:\n${answersList}\n\nخطأ: لم يتم العثور على أسئلة جديدة.`);
        state.isTransitioning = false;
        return;
      }

      state.currentQuestion = nextQ.question;
      state.answersMap = buildAnswersMap(nextQ.answers);
      state.answers = nextQ.answers;
      state.playerProgress = {};
      state.startTime = Date.now();

      await ctx.reply(`*تم التخطي*\n\nالإجابة الصحيحة كانت:\n${answersList}`);
      await ctx.reply(`*تع/3 ${nextQ.question}*`);

      state.isTransitioning = false;
      return;
    }

    const katStore = ctx.store.namespace('katGame');
    if (katStore.has(chatId)) {
      const state = katStore.get(chatId);
      const correctAnswers = state.targetWords.join(' - ');

      state.playerProgress = {};
      
      await ctx.reply(`*تم التخطي*\n\nالإجابة الصحيحة كانت:\n*${correctAnswers}*`);
      
      if (typeof state.nextRound === 'function') {
        await state.nextRound();
      }
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
      state.answerNormalized = nextItem.answerNormalized;

      await ctx.reply(`*تم التخطي*\n\nالإجابة الصحيحة كانت:\n${correctAnswer}`);

      try {
        await ctx.sock.sendMessage(chatId, {
          image: { url: nextItem.path },
          jpegThumbnail: null
        });
        state.startTime = Date.now();
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
      const nextQ = getRandomSSQuestion();

      if (!nextQ) {
        ssStore.delete(chatId);
        await ctx.reply(`*تم التخطي*\n\nالإجابة الصحيحة كانت:\n${answersList}\n\nخطأ: لم يتم العثور على أسئلة جديدة.`);
        state.isTransitioning = false;
        return;
      }

      state.currentQuestion = nextQ.question;
      state.answersRaw = nextQ.answers;
      state.answerData = buildSSAnswerData(nextQ.answers);
      state.playerProgress = {};
      state.startTime = Date.now();

      await ctx.reply(`*تم التخطي*\n\nالإجابة الصحيحة كانت:\n${answersList}`);
      await ctx.reply(`*س/ ${nextQ.question}*`);

      state.isTransitioning = false;
      return;
    }

    await ctx.reply('لا توجد لعبة نشطة حالياً لتخطيها!');
  }
};