import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason
} from 'baileys';
import qrcode from 'qrcode-terminal';

import { PREFIX, AUTH_FOLDER, DEFAULT_COOLDOWN } from './config.js';
import logger from './lib/logger.js';
import store from './lib/store.js';
import { loadPlugins } from './lib/loadPlugins.js';
import { checkCooldown } from './lib/cooldown.js';
import { getMessageText } from './lib/messageText.js';

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const { version } = await fetchLatestBaileysVersion();
  const { commands, count } = await loadPlugins(logger);

  console.log(`${count} plugin(s) loaded`);

  const sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    // The two flags below are the biggest lever on startup weight: Baileys
    // defaults to pulling your entire chat history and marking you online
    // the moment it connects. A command bot needs neither.
    syncFullHistory: false,
    markOnlineOnConnect: false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrcode.generate(qr, { small: true });
      console.log('Scan the QR above with WhatsApp → Linked devices → Link a device');
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log('connection closed', { statusCode, shouldReconnect });

      if (shouldReconnect) {
        start();
      } else {
        console.log(`logged out — delete the ${AUTH_FOLDER}/ folder and restart to re-link`);
      }
    } else if (connection === 'open') {
      console.log('connected');
    }
  });

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      handleMessage(sock, msg, commands).catch(err => {
        logger.error({ err }, 'unhandled error in message handler');
      });
    }
  });
}

async function handleMessage(sock, msg, commands) {
  if (!msg.message || msg.key.fromMe) return;

  const chatId = msg.key.remoteJid;
  if (!chatId || chatId === 'status@broadcast') return;

  const text = getMessageText(msg);
  if (!text.startsWith(PREFIX)) return;

  const [commandRaw, ...args] = text.slice(PREFIX.length).trim().split(/\s+/);
  const command = commandRaw.toLowerCase();

  const plugin = commands.get(command);
  if (!plugin) return;

  const sender = msg.key.participant || msg.key.remoteJid;
  const reply = (replyText) => sock.sendMessage(chatId, { text: replyText }, { quoted: msg });

  const cooldownLeft = checkCooldown(sender, plugin.name, plugin.cooldown ?? DEFAULT_COOLDOWN);
  if (cooldownLeft) {
    await reply(`slow down — ${cooldownLeft}s left on ${PREFIX}${plugin.name}`);
    return;
  }

  const ctx = {
    sock,
    msg,
    chatId,
    sender,
    isGroup: chatId.endsWith('@g.us'),
    text,
    args,
    command,
    store,
    commands,
    reply
  };

  try {
    await plugin.execute(ctx);
  } catch (err) {
    logger.error({ err, plugin: plugin.name }, 'plugin threw');
    await reply(`"${plugin.name}" hit an error — check the logs`).catch(() => {});
  }
}

process.on('unhandledRejection', (err) => {
  logger.error({ err }, 'unhandled rejection');
});

start().catch(err => {
  console.error('fatal startup error:', err);
  process.exit(1);
});
