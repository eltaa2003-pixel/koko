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

      const answersList = Array.isArray(state.targetWords) 
        ? state.targetWords.join(' ، ') 
        : (state.currentAnswer || state.answer || '');

      const currentCategory = state.category || state.prompt || '';

      let nextQuestionText = '';
      if (typeof state.generateNextQuestion === 'function') {
        const next = state.generateNextQuestion(chatId);
        nextQuestionText = next ? next.promptText : '';
      }

      let message = `⏩ *تم التخطي*\n\n`;
      if (currentCategory) {
        message += `بعض الإجابات الصحيحة لـ (*${currentCategory}*) كانت:\n✨ ${answersList} ✨\n\n`;
      } else {
        message += `الإجابة الصحيحة كانت:\n✨ ${answersList} ✨\n\n`;
      }

      if (nextQuestionText) {
        message += `-------------------\n${nextQuestionText}`;
      }

      await ctx.reply(message);
      
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