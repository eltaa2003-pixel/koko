import { getRandomQuestion, buildAnswersMap } from './ta3.js';

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
        await ctx.reply(`⏩ *تم التخطي*\n\nالإجابة الصحيحة كانت:\n✨ ${answersList} ✨\n\nخطأ: لم يتم العثور على أسئلة جديدة.`);
        state.isTransitioning = false;
        return;
      }

      state.currentQuestion = nextQ.question;
      state.answersMap = buildAnswersMap(nextQ.answers);
      state.answers = nextQ.answers;
      state.playerProgress = {};
      state.startTime = Date.now();

      await ctx.reply(`⏩ *تم التخطي*\n\nالإجابة الصحيحة كانت:\n✨ ${answersList} ✨\n\n*تع/3 ${nextQ.question}*`);

      state.isTransitioning = false;
      return;
    }

    const katStore = ctx.store.namespace('katGame');
    if (katStore.has(chatId)) {
      const state = katStore.get(chatId);
      const correctAnswers = state.targetWords.join(' - ');

      state.playerProgress = {};
      
      await ctx.reply(`⏩ *تم التخطي*\n\nالإجابة الصحيحة كانت:\n✨ *${correctAnswers}* ✨`);
      
      if (typeof state.nextRound === 'function') {
        await state.nextRound();
      }
      return;
    }

    await ctx.reply('لا توجد لعبة نشطة حالياً لتخطيها! 🏁');
  }
};