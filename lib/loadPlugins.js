import { readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const PLUGINS_DIR = path.resolve('plugins');

/**
 * Plugin shape (default export of each file in plugins/):
 *   {
 *     name: 'ping',            // required, command name (case-insensitive)
 *     aliases: ['p'],          // optional
 *     description: '...',      // optional, shown in .help
 *     cooldown: 2,             // optional, seconds — defaults to DEFAULT_COOLDOWN
 *     execute: async (ctx) => {}  // required
 *   }
 *
 * One broken plugin file (bad syntax, missing import, whatever) is logged
 * and skipped rather than taking the whole bot down — this is the fix for
 * the "one bad file breaks every command" failure mode from Miku.
 */
export async function loadPlugins(logger) {
  const commands = new Map();
  const seen = [];

  let files;
  try {
    files = (await readdir(PLUGINS_DIR)).filter(f => f.endsWith('.js'));
  } catch (err) {
    logger.warn({ err }, 'no plugins/ directory found — starting with zero commands');
    return { commands, count: 0 };
  }

  for (const file of files) {
    const fileUrl = pathToFileURL(path.join(PLUGINS_DIR, file)).href;

    try {
      const mod = await import(fileUrl);
      const plugin = mod.default;

      if (!plugin || typeof plugin.name !== 'string' || typeof plugin.execute !== 'function') {
        logger.warn(`skipping ${file}: default export needs a string "name" and a function "execute"`);
        continue;
      }

      const key = plugin.name.trim().toLowerCase();
      commands.set(key, plugin);

      for (const alias of plugin.aliases ?? []) {
        commands.set(alias.trim().toLowerCase(), plugin);
      }

      seen.push(plugin.name);
    } catch (err) {
      logger.warn({ err }, `skipping ${file}: failed to load`);
    }
  }

  logger.info(`loaded ${seen.length} plugin(s): ${seen.join(', ')}`);
  return { commands, count: seen.length };
}
