import { downloadMediaMessage } from 'baileys';
import { Sticker, StickerTypes } from 'wa-sticker-formatter';
import { spawn } from 'child_process';
import { readFile, unlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

// ---------- shared helpers ----------

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args);
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr}`));
    });
  });
}

// unwrap view-once wrappers so image/video/sticker detection works on those too
function unwrap(message) {
  const viewOnce =
    message?.viewOnceMessage?.message ||
    message?.viewOnceMessageV2?.message ||
    message?.viewOnceMessageV2Extension?.message;
  return viewOnce || message;
}

function getTargetMsg(msg) {
  const msgType = Object.keys(msg.message || {})[0];
  const isQuoted =
    msgType === 'extendedTextMessage' &&
    msg.message.extendedTextMessage.contextInfo?.quotedMessage;

  return isQuoted
    ? { message: unwrap(msg.message.extendedTextMessage.contextInfo.quotedMessage) }
    : { message: unwrap(msg.message) };
}

// the fix for "media does not exist": always pass reuploadRequest
async function downloadTarget(targetMsg, sock) {
  return downloadMediaMessage(
    targetMsg,
    'buffer',
    {},
    { logger: sock.logger, reuploadRequest: sock.updateMediaMessage }
  );
}

async function cleanup(...paths) {
  await Promise.all(paths.map((p) => unlink(p).catch(() => {})));
}

// ---------- .w : media -> sticker ----------

const wCommand = {
  name: 'w',
  aliases: ['sticker', 'ملصق'],
  description: 'يصنع ملصق من صورة أو فيديو. الاستخدام: .w [اسم الملصق]',
  cooldown: 5,

  async execute(ctx) {
    const { msg, args, reply, sock, chatId } = ctx;

    const targetMsg = getTargetMsg(msg);
    const targetType = Object.keys(targetMsg.message || {}).find(
      (k) => k === 'imageMessage' || k === 'videoMessage'
    );

    if (!targetType) {
      return reply('الرجاء إرسال أو الرد على صورة أو فيديو مع الأمر (مثال: .w اسم الملصق)');
    }

    const isVideo = targetType === 'videoMessage';

    if (isVideo) {
      const seconds = targetMsg.message.videoMessage.seconds || 0;
      if (seconds > 10) {
        return reply('الفيديو طويل جداً! الرجاء استخدام فيديو مدته 10 ثوانٍ أو أقل.');
      }
    }

    await sock.sendMessage(chatId, { react: { text: '⏳', key: msg.key } }).catch(() => {});

    const id = randomUUID();
    const rawPath = join(tmpdir(), `${id}-raw.${isVideo ? 'mp4' : 'jpg'}`);
    const preprocessedPath = join(tmpdir(), `${id}-pre.mp4`);

    try {
      const mediaBuffer = await downloadTarget(targetMsg, sock);
      const customPackName = args.length > 0 ? args.join(' ') : 'Elta Stickers';

      let stickerInput = mediaBuffer;

      if (isVideo) {
        // pre-shrink BEFORE handing off to wa-sticker-formatter — this is what
        // was making animated stickers slow. Cap resolution, fps, and length here
        // instead of letting the library encode the full-res source.
        await writeFile(rawPath, mediaBuffer);
        await runFfmpeg([
          '-y',
          '-i', rawPath,
          '-t', '7',
          '-vf', "fps=15,scale='min(512,iw)':'min(512,ih)':force_original_aspect_ratio=decrease",
          '-an',
          preprocessedPath
        ]);
        stickerInput = await readFile(preprocessedPath);
      }

      const sticker = new Sticker(stickerInput, {
        pack: customPackName,
        author: 'Elta',
        type: StickerTypes.FULL,
        quality: 70, // 100 encodes noticeably slower for little visible gain on stickers
        background: 'transparent'
      });

      const finalStickerBuffer = await sticker.toBuffer();

      await sock.sendMessage(chatId, { sticker: finalStickerBuffer }, { quoted: msg });
      await sock.sendMessage(chatId, { react: { text: '', key: msg.key } }).catch(() => {});
    } catch (err) {
      console.error('Sticker generation error:', err);
      await reply('حدث خطأ أثناء تحويل الوسائط إلى ملصق. تأكد من أن الملف سليم وأن ffmpeg مثبت.');
    } finally {
      await cleanup(rawPath, preprocessedPath);
    }
  }
};

// ---------- .m : sticker -> media ----------

const mCommand = {
  name: 'm',
  aliases: ['toimg', 'tovideo', 'tomedia'],
  description: 'يحول الملصق إلى صورته أو فيديوه الأصلي. الاستخدام: رد على ملصق بـ .m',
  cooldown: 5,

  async execute(ctx) {
    const { msg, reply, sock, chatId } = ctx;

    const targetMsg = getTargetMsg(msg);
    const stickerMsg = targetMsg.message?.stickerMessage;

    if (!stickerMsg) {
      return reply('الرجاء الرد على ملصق مع الأمر .m');
    }

    await sock.sendMessage(chatId, { react: { text: '⏳', key: msg.key } }).catch(() => {});

    const id = randomUUID();
    const inputPath = join(tmpdir(), `${id}.webp`);
    const isAnimated = !!stickerMsg.isAnimated;
    const outputPath = join(tmpdir(), isAnimated ? `${id}.mp4` : `${id}.png`);

    try {
      const stickerBuffer = await downloadTarget(targetMsg, sock);
      await writeFile(inputPath, stickerBuffer);

      if (isAnimated) {
        await runFfmpeg([
          '-y',
          '-i', inputPath,
          '-movflags', 'faststart',
          '-pix_fmt', 'yuv420p',
          '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
          outputPath
        ]);
        await sock.sendMessage(
          chatId,
          { video: await readFile(outputPath), gifPlayback: false },
          { quoted: msg }
        );
      } else {
        await runFfmpeg(['-y', '-i', inputPath, outputPath]);
        await sock.sendMessage(chatId, { image: await readFile(outputPath) }, { quoted: msg });
      }

      await sock.sendMessage(chatId, { react: { text: '', key: msg.key } }).catch(() => {});
    } catch (err) {
      console.error('Sticker-to-media error:', err);
      await reply('حدث خطأ أثناء تحويل الملصق. تأكد من أن ffmpeg مثبت.');
    } finally {
      await cleanup(inputPath, outputPath);
    }
  }
};

export default [wCommand, mCommand];