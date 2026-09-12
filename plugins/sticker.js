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

// ---------------------------------------------------------------------
// Robust download: WhatsApp sometimes hasn't fully propagated a video's
// encrypted media to the CDN edge the instant the message arrives, so the
// very first downloadMediaMessage() call can throw or return a truncated
// buffer. Retrying a couple of times with a short backoff fixes the
// "have to send the command twice" bug instead of just failing.
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

// Both filters pad with fully-transparent black (0x00000000) so the static
// and animated paths agree on what "empty" looks like.
const SCALE_PAD = "scale='min(512,iw)':'min(512,ih)':force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000";

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
    // format=rgba before palettegen gives every pixel clean binary alpha
    // (no anti-aliased edge blend), matching transparency_color to the same
    // pad color used everywhere else, and alpha_threshold+dither=none in
    // paletteuse snaps any leftover edge pixel to fully transparent instead
    // of quantizing it to a random (often black) palette color. This is the
    // fix for the black rim on animated stickers.
    '-vf',
      "scale='min(512,iw)':'min(512,ih)':force_original_aspect_ratio=decrease:flags=lanczos," +
      "fps=15," +
      "pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000," +
      "format=rgba," +
      "split [a][b]; " +
      "[a] palettegen=reserve_transparent=on:transparency_color=000000 [p]; " +
      "[b][p] paletteuse=alpha_threshold=128:dither=none",
    '-vcodec', 'libwebp',
    '-loop', '0',
    '-preset', 'drawing',
    '-an',
    '-q:v', '50',
    '-compression_level', '6',
    outputPath
  ]);
}

// Map a document's mimetype so files sent as attachments (.webp/.mp4/.gif
// shared as a file instead of inline media) are supported too.
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
  description: 'رد مع .w [اسم]',
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

    const nativeType = Object.keys(targetMsg.message || {}).find(
      k => k === 'imageMessage' || k === 'videoMessage' || k === 'stickerMessage'
    );

    let targetType = nativeType;
    if (!targetType && targetMsg.message?.documentMessage) {
      targetType = classifyDocument(targetMsg.message.documentMessage);
    }

    if (!targetType) {
      return reply('رد مع .w');
    }

    const seconds =
      targetMsg.message?.videoMessage?.seconds ??
      targetMsg.message?.documentMessage?.seconds ??
      0;
    if (targetType === 'videoMessage' && seconds > 10) {
      return reply('طويل جداً');
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
      // Retrying downloader — fixes the "send .w twice for video" issue.
      const mediaBuffer = await downloadWithRetry(targetMsg, sock);
      let finalStickerBuffer;

      if (targetType === 'stickerMessage') {
        // Rebrand mode: reply to any sticker (or a .webp sent as a file)
        // with .w [name] to relabel it as your own pack, no re-encoding.
        finalStickerBuffer = await addStickerExif(mediaBuffer, customPackName, customAuthor);
      } else if (targetType === 'imageMessage') {
        inputPath = path.join(os.tmpdir(), `sticker_in_${tempId}.jpg`);
        outputPath = path.join(os.tmpdir(), `sticker_out_${tempId}.webp`);
        await fsp.writeFile(inputPath, mediaBuffer);
        await imageToWebp(inputPath, outputPath);
        const rawWebp = await fsp.readFile(outputPath);
        finalStickerBuffer = await addStickerExif(rawWebp, customPackName, customAuthor);
      } else {
        // videoMessage (native video, GIF, or a document-wrapped video/gif)
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
      await reply('خطأ');
    } finally {
      if (inputPath && existsSync(inputPath)) await fsp.unlink(inputPath).catch(() => {});
      if (outputPath && existsSync(outputPath)) await fsp.unlink(outputPath).catch(() => {});
    }
  }
};