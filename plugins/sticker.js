import { downloadMediaMessage } from 'baileys';
import { execFile } from 'child_process';
import { promises as fsp, existsSync } from 'fs';
import { randomBytes } from 'crypto';
import util from 'util';
import path from 'node:path';
import os from 'node:os';
import ffmpegPath from 'ffmpeg-static';
import webpmuxPkg from 'node-webpmux';

const { Image } = webpmuxPkg;
const execFilePromise = util.promisify(execFile);

// Swap the sticker-pack/author metadata on an existing (already valid) webp
// without re-encoding it — cheap, lossless, and works on both static and
// animated stickers since we're not touching the image data at all.
async function addStickerExif(webpBuffer, packname, author) {
  const img = new Image();
  await img.load(webpBuffer);

  const json = {
    'sticker-pack-id': randomBytes(16).toString('hex'),
    'sticker-pack-name': packname,
    'sticker-pack-publisher': author,
    emojis: ['🤖']
  };

  const exifAttr = Buffer.from([
    0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57,
    0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00
  ]);
  const jsonBuffer = Buffer.from(JSON.stringify(json), 'utf-8');
  const exif = Buffer.concat([exifAttr, jsonBuffer]);
  exif.writeUIntLE(jsonBuffer.length, 14, 4);

  img.exif = exif;
  return img.save(null);
}

const SCALE_PAD = "scale='min(512,iw)':'min(512,ih)':force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000";
const SCALE_ONLY = "scale='min(512,iw)':'min(512,ih)':force_original_aspect_ratio=decrease";

async function imageToWebp(inputPath, outputPath) {
  await execFilePromise(ffmpegPath, [
    '-y', '-i', inputPath,
    '-vf', SCALE_PAD,
    '-vcodec', 'libwebp',
    '-lossless', '0',
    '-q:v', '60',
    outputPath
  ]);
}

async function videoToAnimatedWebp(inputPath, outputPath) {
  await execFilePromise(ffmpegPath, [
    '-y', '-i', inputPath,
    // fps=15 with lanczos scaling + palette generation gives cleaner motion
    // and more accurate colors for anime/character content than the old fps=10
    // libwebp-default quant path. The two-pass palette step is the main reason
    // this no longer looks muddy, and removing -vsync 0 stops ffmpeg from
    // inserting duplicate frames when it tries to reconcile VFR input with
    // the fps filter.
    '-vf', `scale='min(512,iw)':'min(512,ih)':force_original_aspect_ratio=decrease:flags=lanczos,fps=15,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=white@0.0,split [a][b]; [a] palettegen=reserve_transparent=on:transparency_color=ffffff [p]; [b][p] paletteuse`,
    '-vcodec', 'libwebp',
    '-loop', '0',
    '-preset', 'drawing',
    '-an',
    '-q:v', '50',
    '-compression_level', '6',
    outputPath
  ]);
}

export default {
  name: 'w',
  aliases: ['sticker', 'ملصق'],
  description: 'يصنع ملصق من صورة/فيديو، أو يعيد تسمية ملصق موجود باسمك (رد على ملصق مع .w اسم).',
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

    const targetType = Object.keys(targetMsg.message || {}).find(
      k => k === 'imageMessage' || k === 'videoMessage' || k === 'stickerMessage'
    );

    if (!targetType) {
      return reply('الرجاء إرسال أو الرد على صورة أو فيديو أو ملصق مع الأمر (مثال: .w اسم الملصق)');
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
      const separator = rawInput.includes('|') ? '|'
                       : rawInput.includes(',') ? ','
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
    const tempId = randomBytes(4).toString('hex');
    let inputPath, outputPath;

    try {
      const mediaBuffer = await downloadMediaMessage(targetMsg, 'buffer', {}, { logger: sock.logger });
      let finalStickerBuffer;

      if (targetType === 'stickerMessage') {
        // Rebrand mode: reply to any sticker with .w [name] to relabel it as
        // your own pack, no re-encoding involved.
        finalStickerBuffer = await addStickerExif(mediaBuffer, customPackName, customAuthor);
      } else if (targetType === 'imageMessage') {
        inputPath = path.join(os.tmpdir(), `sticker_in_${tempId}.jpg`);
        outputPath = path.join(os.tmpdir(), `sticker_out_${tempId}.webp`);
        await fsp.writeFile(inputPath, mediaBuffer);
        await imageToWebp(inputPath, outputPath);
        const rawWebp = await fsp.readFile(outputPath);
        finalStickerBuffer = await addStickerExif(rawWebp, customPackName, customAuthor);
      } else {
        // videoMessage
        inputPath = path.join(os.tmpdir(), `sticker_in_${tempId}.mp4`);
        outputPath = path.join(os.tmpdir(), `sticker_out_${tempId}.webp`);
        await fsp.writeFile(inputPath, mediaBuffer);
        await videoToAnimatedWebp(inputPath, outputPath);
        const rawWebp = await fsp.readFile(outputPath);

        console.log(`[sticker] animated webp size: ${(rawWebp.length / 1024).toFixed(1)} KB`);
        if (rawWebp.length > 1_000_000) {
          console.warn('[sticker] still over ~1MB — WhatsApp may show this as a plain attachment instead of a sticker. Consider a shorter clip or lower fps/quality.');
        }

        finalStickerBuffer = await addStickerExif(rawWebp, customPackName, customAuthor);
      }

      await sock.sendMessage(chatId, { sticker: finalStickerBuffer }, { quoted: msg });
      await sock.sendMessage(chatId, { react: { text: '', key: msg.key } }).catch(() => {});

    } catch (err) {
      console.error('Sticker generation error:', err);
      await reply('حدث خطأ أثناء تحويل الوسائط إلى ملصق. تأكد من أن الملف سليم وأن ffmpeg مثبت.');
    } finally {
      if (inputPath && existsSync(inputPath)) await fsp.unlink(inputPath).catch(() => {});
      if (outputPath && existsSync(outputPath)) await fsp.unlink(outputPath).catch(() => {});
    }
  }
};
