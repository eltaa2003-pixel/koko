import mongoose from 'mongoose';

const latencyStatsSchema = new mongoose.Schema({
  jid: { type: String, required: true, unique: true },
  baseline: { type: Number, default: null },
  samples: { type: Number, default: 0 }
});

export const LatencyStats =
  mongoose.models.LatencyStats || mongoose.model('LatencyStats', latencyStatsSchema);

const ALPHA = 0.15;
const MIN_SAMPLES = 10;

export async function updateLatencyBaseline(jid, measuredLatency) {
  if (measuredLatency == null) return;
  const doc = await LatencyStats.findOne({ jid });
  const prevBaseline = doc?.baseline ?? measuredLatency;
  const nextBaseline = prevBaseline + ALPHA * (measuredLatency - prevBaseline);

  await LatencyStats.updateOne(
    { jid },
    { $set: { baseline: nextBaseline }, $inc: { samples: 1 } },
    { upsert: true }
  );
}

export async function getLatencyBaseline(jid) {
  const doc = await LatencyStats.findOne({ jid });
  if (!doc || doc.samples < MIN_SAMPLES) return 0;
  return doc.baseline ?? 0;
}

export function measureDeliveryLatency(sock, messageKey, participantJid, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const startedAt = process.hrtime.bigint();
    let timer;

    const handler = ({ key, receipt }) => {
      if (!key || key.id !== messageKey.id) return;
      if (receipt?.userJid && receipt.userJid !== participantJid) return;
      cleanup();
      resolve(Number(process.hrtime.bigint() - startedAt) / 1e9);
    };

    function cleanup() {
      sock.ev.off('messages.receipt.update', handler);
      clearTimeout(timer);
    }

    timer = setTimeout(() => { cleanup(); resolve(null); }, timeoutMs);
    sock.ev.on('messages.receipt.update', handler);
  });
}