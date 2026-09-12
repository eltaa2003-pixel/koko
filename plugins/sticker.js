import { downloadMediaMessage } from 'baileys';
import { createSticker, Exif, StickerTypes } from 'wa-sticker-formatter';

// ---------------------------------------------------------------------
// Robust download: WhatsApp sometimes hasn't fully propagated a video's
// encrypted media to the CDN edge the instant the message arrives, so the
// very first downloadMediaMessage() call can throw or return a truncated
// buffer. Retrying a couple of times with a short backoff fixes this
// transparently instead of forcing the user to resend the command.
// ---------------------------------------------------------------------
async function downloadWithRetry(targetMsg, sock, { retries = 3, delayMs = 1200 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const buffer = await downloadMediaMessage(targetMsg, 'buffer', {}, { logger: sock.logger });
      if (buffer && buffer.length > 0) return buffer;
      lastErr = new Error('Empty buffer returned from downloadMediaMessage');
    } catch (err) {
      lastErr = err;
    }
    if (attempt < retries) {
      await new Promise(res => setTimeout(res, delayMs * attempt));
    }
  }
  throw lastErr;
}

// Map a document's mimetype to how we should treat it, so files sent as
// "documentMessage" (e.g. a .webp/.mp4/.gif shared as a file instead of
// inline media) are supported just like native image/video/sticker sends.
function classifyDocument(doc) {
  const mime = (doc?.mimetype || '').toLowerCase();
  if (mime === 'image/webp') return 'stickerMessage';
  if (mime.startsWith('video/') || mime === 'image/gif') return 'videoMessage';
  if (mime.startsWith('image/')) return 'imageMessage';
  return null;
}

export default {
  name: 'w',
  aliases: ['sticker', 'ملصق'],
  description: 'يصنع ملصق من صورة/فيديو/ملف، أو يعيد تسمية ملصق موجود باسمك (رد على ملصق مع .w اسم).',
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

    const nativeType = Object.keys(targetMsg.message || {}).find(
      (k) => k === 'imageMessage' || k === 'videoMessage' || k === 'stickerMessage'
    );

    // Fall back to documentMessage (files shared as attachments) if no
    // native media type matched — this is what unlocks "every format".
    let targetType = nativeType;
    if (!targetType && targetMsg.message?.documentMessage) {
      targetType = classifyDocument(targetMsg.message.documentMessage);
    }

    if (!targetType) {
      return reply(
        'الرجاء إرسال أو الرد على صورة أو فيديو أو ملصق أو ملف وسائط مع الأمر (مثال: .w اسم الملصق)'
      );
    }

    const seconds =
      targetMsg.message?.videoMessage?.seconds ??
      targetMsg.message?.documentMessage?.seconds ??
      0;
    if (targetType === 'videoMessage' && seconds > 10) {
      return reply('الفيديو طويل جداً! الرجاء استخدام فيديو مدته 10 ثوانٍ أو أقل.');
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
      // Retrying downloader — this is what kills the "send the command
      // twice for videos/GIFs" bug caused by CDN propagation lag.
      const mediaBuffer = await downloadWithRetry(targetMsg, sock);

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
          // Forcing this explicitly (rather than relying on the library's
          // documented "defaults to transparent") is the fix for the black
          // padding: for GIF/video input, wa-sticker-formatter converts via
          // an internal ffmpeg call whose own default pad color is opaque
          // black, independent of this option's documented default. Passing
          // a fully-transparent RGBA hex8 value here forces it correctly for
          // both the image (sharp) path and the video/GIF (ffmpeg) path.
          background: '#00000000',
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