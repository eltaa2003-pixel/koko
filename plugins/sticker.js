import { downloadMediaMessage } from 'baileys';
import { execFile } from 'child_process';
import { promises as fsp, existsSync } from 'fs';
import { randomBytes } from 'crypto';
import util from 'util';
import path from 'node:path';
import os from 'node:os';
import ffmpegPath from 'ffmpeg-static';
import webpmuxPkg from 'node-webpmux';
import fetch from 'node-fetch';
import { FormData, Blob } from 'formdata-node';
import { fileTypeFromBuffer } from 'file-type';

const { Image } = webpmuxPkg;
const execFilePromise = util.promisify(execFile);

// ---------------------------------------------------------------------
// Remote-first path: uploads the media to a public host (catbox.moe) then
// asks a third-party conversion API to build the animated webp, instead of
// doing it locally. NOTE: this means the media is briefly hosted at a
// public URL anyone could access — that's a deliberate, known tradeoff (see
// conversation), not an oversight. A short timeout + local ladder fallback
// means a dead/slow remote service degrades gracefully instead of hanging
// the whole command.
// ---------------------------------------------------------------------
const REMOTE_TIMEOUT_MS = 12_000;

async function uploadToCatbox(buffer) {
  const { ext, mime } = await fileTypeFromBuffer(buffer) || {};
  const form = new FormData();
  const blob = new Blob([buffer], { type: mime || 'application/octet-stream' });
  form.append('fileToUpload', blob, `tmp.${ext || 'bin'}`);
  form.append('reqtype', 'fileupload');
  const res = await fetch('https://catbox.moe/user/api.php', { method: 'POST', body: form });
  const result = await res.text();
  if (!result.startsWith('https://files.catbox.moe/')) throw new Error('catbox upload failed');
  return result.trim();
}

async function tryRemoteSticker(mediaBuffer, packname, author) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REMOTE_TIMEOUT_MS);
  try {
    const url = await uploadToCatbox(mediaBuffer);
    const qs = new URLSearchParams({ url, packname, author });
    const res = await fetch(`https://api.xteam.xyz/sticker/wm?${qs}`, { signal: controller.signal });
    if (!res.ok) throw new Error(`remote API status ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    // Sanity-check we actually got a webp back and not an HTML error page.
    const type = await fileTypeFromBuffer(buf);
    if (!type || type.ext !== 'webp') throw new Error('remote API did not return a webp');
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

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

// WhatsApp treats an animated sticker over ~500KB (hard cap ~1MB) as a
// plain file attachment instead of a sticker — that's the "shows a download
// bubble and won't play" symptom. A single fixed quality setting can't
// guarantee that across clips of different length/motion, so we encode at
// progressively cheaper settings (lower fps, lower quality, smaller frame)
// until the output actually fits, instead of hoping one setting is enough.
const ANIMATED_SIZE_LIMIT = 500 * 1024; // target under WhatsApp's real cutoff
// Holds fps close to 30 across every rung per your request — quality and
// canvas size absorb the size reduction instead. Note the tradeoff: at 30fps
// a 5s clip is 150 frames sharing the same ~500KB budget (vs. ~30 frames at
// 6fps), so there's a lot less data per frame to work with, and detail/text
// will degrade faster than it did when fps was the first thing to drop.
const ENCODE_LADDER = [
  { fps: 30, quality: 70, size: 512 },
  { fps: 30, quality: 55, size: 512 },
  { fps: 30, quality: 40, size: 448 },
  { fps: 30, quality: 30, size: 384 },
  { fps: 24, quality: 30, size: 384 },
  { fps: 24, quality: 25, size: 320 },
  { fps: 20, quality: 25, size: 320 },
  { fps: 20, quality: 20, size: 256 },
];

async function encodeAnimatedWebpAttempt(inputPath, outputPath, { fps, quality, size }) {
  await execFilePromise(ffmpegPath, [
    '-y', '-i', inputPath,
    // format=rgba before palettegen gives every pixel clean binary alpha
    // (no anti-aliased edge blend), matching transparency_color to the same
    // pad color used everywhere else, and alpha_threshold+dither=none in
    // paletteuse snaps any leftover edge pixel to fully transparent instead
    // of quantizing it to a random (often black) palette color. This is the
    // fix for the black rim on animated stickers.
    '-vf',
      `scale='min(${size},iw)':'min(${size},ih)':force_original_aspect_ratio=decrease:flags=lanczos,` +
      `fps=${fps},` +
      `pad=${size}:${size}:(ow-iw)/2:(oh-ih)/2:color=0x00000000,` +
      "format=rgba," +
      "split [a][b]; " +
      "[a] palettegen=reserve_transparent=on:transparency_color=000000 [p]; " +
      "[b][p] paletteuse=alpha_threshold=128:dither=none",
    '-vcodec', 'libwebp',
    '-loop', '0',
    '-preset', 'drawing',
    '-an',
    '-q:v', String(quality),
    '-compression_level', '6',
    outputPath
  ]);
}

async function videoToAnimatedWebp(inputPath, outputPath) {
  let lastSize = Infinity;
  for (let i = 0; i < ENCODE_LADDER.length; i++) {
    const settings = ENCODE_LADDER[i];
    await encodeAnimatedWebpAttempt(inputPath, outputPath, settings);
    const { size: bytes } = await fsp.stat(outputPath);
    lastSize = bytes;
    console.log(`[sticker] attempt ${i + 1} (fps=${settings.fps} q=${settings.quality} px=${settings.size}): ${(bytes / 1024).toFixed(1)} KB`);
    if (bytes <= ANIMATED_SIZE_LIMIT) return;
  }
  console.warn(`[sticker] exhausted encode ladder, still ${(lastSize / 1024).toFixed(1)} KB — WhatsApp may reject this as a plain attachment. Try a shorter clip.`);
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
        let rawWebp;
        try {
          console.log('[sticker] trying remote API first...');
          rawWebp = await tryRemoteSticker(mediaBuffer, customPackName, customAuthor);
          console.log(`[sticker] remote API succeeded: ${(rawWebp.length / 1024).toFixed(1)} KB`);
        } catch (remoteErr) {
          console.warn('[sticker] remote API failed, falling back to local encode:', remoteErr.message);
          inputPath = path.join(os.tmpdir(), `sticker_in_${tempId}.mp4`);
          outputPath = path.join(os.tmpdir(), `sticker_out_${tempId}.webp`);
          await fsp.writeFile(inputPath, mediaBuffer);
          await videoToAnimatedWebp(inputPath, outputPath);
          rawWebp = await fsp.readFile(outputPath);
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