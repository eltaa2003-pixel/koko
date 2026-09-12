import { downloadMediaMessage } from 'baileys';
import { createSticker, Exif, StickerTypes } from 'wa-sticker-formatter';
import { randomBytes } from 'crypto';

export default {
  name: 'w',
  aliases: ['sticker', 'ملصق'],
  description: 'يصنع ملصق من صورة/فيديو، أو يعيد تسمية ملصق موجود باسمك (رد على ملصق مع .w اسم).',
  cooldown: 5,

  async execute(ctx) {
    const { msg, args, reply, sock, chatId } = ctx;

    const msgType = Object.keys(msg.message || {})[0];
    const isQuoted =
      msgType === 'extendedTextMessage' &&
      msg.message.extendedTextMessage.contextInfo?.quotedMessage;

    const targetMsg = isQuoted
      ? {
          key: {
            remoteJid: msg.key.remoteJid,
            id: msg.message.extendedTextMessage.contextInfo.stanzaId,
            participant: msg.message.extendedTextMessage.contextInfo.participant,
          },
          message: msg.message.extendedTextMessage.contextInfo.quotedMessage,
        }
      : msg;

    const targetType = Object.keys(targetMsg.message || {}).find(
      (k) => k === 'imageMessage' || k === 'videoMessage' || k === 'stickerMessage'
    );

    if (!targetType) {
      return reply(
        'الرجاء إرسال أو الرد على صورة أو فيديو أو ملصق مع الأمر (مثال: .w اسم الملصق)'
      );
    }

    if (targetType === 'videoMessage') {
      const seconds = targetMsg.message.videoMessage.seconds || 0;
      if (seconds > 10) {
        return reply('الفيديو طويل جداً! الرجاء استخدام فيديو مدته 10 ثوانٍ أو أقل.');
      }
    }

    await sock.sendMessage(chatId, { react: { text: '⏳', key: msg.key } }).catch(() => {});

    const rawInput = args.join(' ').trim();

    let customPackName = 'Elta Stickers';
    let customAuthor = 'Elta';

    if (rawInput.length > 0) {
      const separator = rawInput.includes('|')
        ? '|'
        : rawInput.includes(',')
          ? ','
          : null;

      if (separator) {
        const splitIndex = rawInput.indexOf(separator);
        const namePart = rawInput.slice(0, splitIndex).trim();
        const authorPart = rawInput.slice(splitIndex + 1).trim();

        customPackName = namePart || 'Elta Stickers';
        customAuthor = authorPart || 'Elta';
      } else {
        customPackName = rawInput;
      }
    }

    try {
      const mediaBuffer = await downloadMediaMessage(
        targetMsg,
        'buffer',
        {},
        { logger: sock.logger }
      );

      let finalStickerBuffer;

      if (targetType === 'stickerMessage') {
        finalStickerBuffer = await new Exif({
          pack: customPackName,
          author: customAuthor,
        }).add(mediaBuffer);
      } else {
        finalStickerBuffer = await createSticker(mediaBuffer, {
          pack: customPackName,
          author: customAuthor,
          type: StickerTypes.FULL,
          quality: targetType === 'videoMessage' ? 60 : 100,
        });
      }

      await sock.sendMessage(chatId, { sticker: finalStickerBuffer }, { quoted: msg });
      await sock
        .sendMessage(chatId, { react: { text: '', key: msg.key } })
        .catch(() => {});
    } catch (err) {
      console.error('Sticker generation error:', err);
      await reply(
        'حدث خطأ أثناء تحويل الوسائط إلى ملصق. تأكد من أن الملف سليم.'
      );
    }
  },
};
