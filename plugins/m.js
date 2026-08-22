import { downloadMediaMessage } from 'baileys';
import { execFile } from 'child_process';
import { promises as fsp, writeFileSync, readFileSync, unlinkSync, existsSync } from 'fs';
import { randomBytes } from 'crypto';
import util from 'util';
import path from 'node:path';
import os from 'node:os';
import ffmpegPath from 'ffmpeg-static';
import webpmuxPkg from 'node-webpmux';
const { Image } = webpmuxPkg;

const execFilePromise = util.promisify(execFile);

// FFmpeg's own webp demuxer can't read the ANIM/ANMF chunks that make up an
// animated webp — it only handles single-frame webp. node-webpmux actually
// understands the animation container, so we use its own demux() to pull
// each frame out as a proper standalone webp buffer, then hand FFmpeg a
// plain image sequence.
//
// NOTE: img.frames[i] holds the raw internal frame record (offsets, dispose/
// blend flags, etc.) — there's no `.data`/`.imgData`/`.imageData` on it with
// a ready-to-use image buffer. To get an actual decodable webp per frame you
// have to go through img.demux({ buffers: true }), which reassembles each
// frame into a standalone webp buffer for you.
async function animatedWebpToMp4(buffer, outPath) {
  const img = new Image();
  await img.load(buffer);

  if (!img.frames || img.frames.length === 0) {
    throw new Error('no frames found in animated webp');
  }

  const frameBuffers = await img.demux({ buffers: true });
  if (!frameBuffers || frameBuffers.length === 0) {
    throw new Error('demux produced no frame buffers');
  }

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wa-frames-'));

  try {
    const avgDelayMs = img.frames.reduce((sum, f) => sum + (f.delay || 100), 0) / img.frames.length;
    const fps = Math.max(1, Math.round(1000 / avgDelayMs));

    for (let i = 0; i < frameBuffers.length; i++) {
      const framePath = path.join(tmpDir, `frame_${String(i).padStart(4, '0')}.webp`);
      await fsp.writeFile(framePath, frameBuffers[i]);
    }

    await execFilePromise(ffmpegPath, [
      '-y',
      '-framerate', String(fps),
      '-i', path.join(tmpDir, 'frame_%04d.webp'),
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-pix_fmt', 'yuv420p',
      '-movflags', 'faststart',
      outPath
    ]);
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

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

     await sock.sendMessage(chatId, { react: { text: '⏳', key: msg.key } }).catch(() => {});

     let webpPath, outPath;

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
       webpPath = `./temp_${tempId}.webp`;
       writeFileSync(webpPath, mediaBuffer);

       let isAnimated = stickerMessage.isAnimated || false;
       if (!isAnimated) {
         try {
           const img = new Image();
           await img.load(mediaBuffer);
           if (img.frames && img.frames.length > 1) {
             isAnimated = true;
           }
         } catch {}
       }

       outPath = `./temp_${tempId}.${isAnimated ? 'mp4' : 'png'}`;

       if (isAnimated) {
         await animatedWebpToMp4(mediaBuffer, outPath);
         const videoBuffer = readFileSync(outPath);
         await sock.sendMessage(chatId, { video: videoBuffer, caption: 'تم الدهس' }, { quoted: msg });
       } else {
         await execFilePromise(ffmpegPath, ['-i', webpPath, outPath]);
         const imageBuffer = readFileSync(outPath);
         await sock.sendMessage(chatId, { image: imageBuffer, caption: 'تم الدهس' }, { quoted: msg });
       }

      if (existsSync(webpPath)) unlinkSync(webpPath);
      if (existsSync(outPath)) unlinkSync(outPath);

      await sock.sendMessage(chatId, { react: { text: '', key: msg.key } }).catch(() => {});

    } catch (err) {
      console.error('Media extraction error:', err);
      await reply('حدث خطأ أثناء الاستخراج. تأكد من أن ملف الملصق سليم.');
      try { if (webpPath && existsSync(webpPath)) unlinkSync(webpPath); } catch {}
      try { if (outPath && existsSync(outPath)) unlinkSync(outPath); } catch {}
    }
  }
};