import { downloadMediaMessage } from 'baileys';
import { Sticker, StickerTypes } from 'wa-sticker-formatter';

export default {
  name: 'w',
  aliases: ['sticker', 'ملصق'],
  description: 'يصنع ملصق من صورة أو فيديو. الاستخدام: .w [اسم الملصق]',
  cooldown: 5,

  async execute(ctx) {
    const { msg, args, reply, sock, chatId } = ctx;

    const msgType = Object.keys(msg.message || {})[0];
    const isQuoted = msgType === 'extendedTextMessage' && msg.message.extendedTextMessage.contextInfo?.quotedMessage;

    const targetMsg = isQuoted
      ? {
          key: {
            remoteJid: msg.key.remoteJid,
            id: msg.message.extendedTextMessage.contextInfo.stanzaId,
            participant: msg.message.extendedTextMessage.contextInfo.participant
          },
          message: msg.message.extendedTextMessage.contextInfo.quotedMessage
        }
      : msg;

    const targetType = Object.keys(targetMsg.message || {}).find(k => k === 'imageMessage' || k === 'videoMessage');

    if (!targetType) {
      return reply('الرجاء إرسال أو الرد على صورة أو فيديو مع الأمر (مثال: .w اسم الملصق)');
    }

    if (targetType === 'videoMessage') {
      const seconds = targetMsg.message.videoMessage.seconds || 0;
      if (seconds > 10) {
        return reply('الفيديو طويل جداً! الرجاء استخدام فيديو مدته 10 ثوانٍ أو أقل.');
      }
    }

    await sock.sendMessage(chatId, { react: { text: '⏳', key: msg.key } }).catch(() => {});

    try {
      const mediaBuffer = await downloadMediaMessage(
        targetMsg,
        'buffer',
        {},
        { logger: sock.logger }
      );

      const customPackName = args.length > 0 ? args.join(' ') : 'Elta Stickers';

      const sticker = new Sticker(mediaBuffer, {
        pack: customPackName,
        author: 'Elta',
        type: StickerTypes.DEFAULT, 
        quality: 40, 
        background: 'transparent'
      });

      const finalStickerBuffer = await sticker.toBuffer();

      await sock.sendMessage(
        chatId,
        { sticker: finalStickerBuffer },
        { quoted: msg }
      );

      await sock.sendMessage(chatId, { react: { text: '', key: msg.key } }).catch(() => {});

    } catch (err) {
      console.error('Sticker generation error:', err);
      await reply('حدث خطأ أثناء تحويل الوسائط إلى ملصق. تأكد من أن الملف سليم وأن ffmpeg مثبت.');
    }
  }
};
