import { PREFIX } from '../config.js';

export default {
  name: 'help',
  aliases: ['menu', 'commands'],
  description: 'List available commands',
  cooldown: 5,

  async execute(ctx) {
    // ctx.commands maps both names AND aliases to the same plugin object,
    // so dedupe on the plugin itself before printing.
    const unique = [...new Set(ctx.commands.values())];

    const lines = unique.map(p => {
      const aliases = p.aliases?.length ? ` (${p.aliases.join(', ')})` : '';
      return `${PREFIX}${p.name}${aliases} — ${p.description ?? 'no description'}`;
    });

    await ctx.reply(`*Commands*\n${lines.join('\n')}`);
  }
};
