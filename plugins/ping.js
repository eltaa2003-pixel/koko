export default {
  name: 'ping',
  aliases: ['p'],
  description: 'Check that the bot is alive',
  cooldown: 2,

  async execute(ctx) {
    const start = Date.now();
    await ctx.reply(`pong (${Date.now() - start}ms)`);
  }
};
