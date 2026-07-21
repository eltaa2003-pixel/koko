import { downloadMediaMessage } from 'baileys';
import { exec } from 'child_process';
import { writeFileSync, readFileSync, unlinkSync } from 'fs';
import { randomBytes } from 'crypto';
import util from 'util';

const execPromise = util.promisify(exec);

export default {
  name: 'm',
  aliases: ['media', 'extract'],
  description: 'يحول الملصق إلى صورة أو فيديو. الاستخدام: الرد على ملصق مع .m',
  cooldown: 5,

  async execute(ctx) {
    const { msg, reply, sock, chatId } = ctx;

    const msgType = Object.keys(msg.message || {})[0];
    const isQuoted = msgType === 'extendedTextMessage' && msg.message.extendedTextMessage.contextInfo?.quotedMessage;

    if (!isQuoted) return reply('الرجاء الرد على ملصق (Sticker).');

    const quotedMessage = msg.message.extendedTextMessage.contextInfo.quotedMessage;
    if (!quotedMessage.stickerMessage) return reply('الرجاء الرد على ملصق فقط.');

    const stickerMessage = quotedMessage.stickerMessage;
    const isAnimated = stickerMessage.isAnimated || false;

    await sock.sendMessage(chatId, { react: { text: '⏳', key: msg.key } }).catch(() => {});

    try {
      const targetMsg = {
        key: {
          remoteJid: msg.key.remoteJid,
          id: msg.message.extendedTextMessage.contextInfo.stanzaId,
          participant: msg.message.extendedTextMessage.contextInfo.participant
        },
        message: quotedMessage
      };

      const mediaBuffer = await downloadMediaMessage(targetMsg, 'buffer', {}, { logger: sock.logger });

      const tempId = randomBytes(4).toString('hex');
      const webpPath = `./temp_${tempId}.webp`;
      const outPath = `./temp_${tempId}.${isAnimated ? 'mp4' : 'png'}`;

      writeFileSync(webpPath, mediaBuffer);

      if (isAnimated) {
        await execPromise(`ffmpeg -i ${webpPath} -vcodec libx264 -pix_fmt yuv420p ${outPath}`);
        const videoBuffer = readFileSync(outPath);
        await sock.sendMessage(chatId, { video: videoBuffer, caption: 'تم التحويل ✅' }, { quoted: msg });
      } else {
        await execPromise(`ffmpeg -i ${webpPath} ${outPath}`);
        const imageBuffer = readFileSync(outPath);
        await sock.sendMessage(chatId, { image: imageBuffer, caption: 'تم التحويل ✅' }, { quoted: msg });
      }

      unlinkSync(webpPath);
      unlinkSync(outPath);
      
      await sock.sendMessage(chatId, { react: { text: '', key: msg.key } }).catch(() => {});

    } catch (err) {
      console.error('Media extraction error:', err);
      await reply('حدث خطأ أثناء الاستخراج. تأكد من تثبيت ffmpeg على السيرفر الخاص بك.');
    }
  }
};
