import mongoose from 'mongoose';
import { getLatencyBaseline } from './latency.js';

const playerStatsSchema = new mongoose.Schema({
  jid: { type: String, required: true },
  game: { type: String, required: true },
  wins: { type: Number, default: 0 },
  totalAnswered: { type: Number, default: 0 },
  totalTime: { type: Number, default: 0 },
  bestTime: { type: Number, default: null },
  bestTimeLabel: { type: String, default: null },
  totalChars: { type: Number, default: 0 }
});

playerStatsSchema.index({ jid: 1, game: 1 }, { unique: true });

export const PlayerStats = mongoose.models.PlayerStats || mongoose.model('PlayerStats', playerStatsSchema);

const JID_RE = /^\d+@\S+$/;

export async function recordWin({ jid, game, timeTaken, label, answeredCount = 1 }) {
  if (!JID_RE.test(jid)) throw new TypeError('invalid jid');

  const baseline = await getLatencyBaseline(jid);
  const adjustedTime = Math.max(0.05, timeTaken - Math.min(timeTaken, baseline));

  const perAnswerTime = adjustedTime / answeredCount;
  const charCount = label.length;

  await PlayerStats.updateOne(
    { jid, game },
    [
      {
        $set: {
          wins: { $add: [{ $ifNull: ['$wins', 0] }, 1] },
          totalTime: { $add: [{ $ifNull: ['$totalTime', 0] }, perAnswerTime] },
          totalAnswered: { $add: [{ $ifNull: ['$totalAnswered', 0] }, answeredCount] },
          totalChars: { $add: [{ $ifNull: ['$totalChars', 0] }, charCount] },
          bestTime: {
            $cond: [
              { $or: [{ $eq: [{ $ifNull: ['$bestTime', null] }, null] }, { $lt: [perAnswerTime, '$bestTime'] }] },
              perAnswerTime,
              '$bestTime'
            ]
          },
          bestTimeLabel: {
            $cond: [
              { $or: [{ $eq: [{ $ifNull: ['$bestTime', null] }, null] }, { $lt: [perAnswerTime, '$bestTime'] }] },
              label,
              '$bestTimeLabel'
            ]
          }
        }
      }
    ],
    { upsert: true }
  );
}

export async function getSpeedLeaderboardText(game, gameDisplayName) {
  const top = await PlayerStats.find({ game, bestTime: { $ne: null } }).sort({ bestTime: 1 }).limit(3);
  if (!top.length) return null;

  const lines = top.map((p, i) => {
    const mention = `@${p.jid.split('@')[0]}`;
    return `${i + 1}. ${mention}\n   ⚡ ${p.bestTime.toFixed(3)}s — ${p.bestTimeLabel}`;
  });

  return {
    text: `🏎️ *أسرع 3 في ${gameDisplayName}*\n\n${lines.join('\n\n')}`,
    mentions: top.map(p => p.jid)
  };
}

export async function getOverallLeaderboardText(game, gameDisplayName) {
  const players = await PlayerStats.find({
    game,
    totalAnswered: { $gt: 0 },
    totalTime: { $gt: 0 }
  });
  if (!players.length) return null;

  // avgReaction: seconds per question/word answered (lower is better)
  // wpm: standard typing-test words-per-minute (1 word = 5 chars, higher is better)
  const withStats = players.map(p => ({
    p,
    avgReaction: p.totalTime / p.totalAnswered,
    wpm: (p.totalChars / p.totalTime) * 12
  }));

  withStats.sort((a, b) => b.wpm - a.wpm);
  const top3 = withStats.slice(0, 3);
  if (!top3.length) return null;

  const lines = top3.map(({ p, avgReaction, wpm }, i) => {
    const mention = `@${p.jid.split('@')[0]}`;
    return `${i + 1}. ${mention}\n   ⏱️ متوسط وقت الرد: ${avgReaction.toFixed(2)}s\n   📊 إجابات: ${p.totalAnswered}\n   🚀 ${wpm.toFixed(1)} كلمة/دقيقة`;
  });

  return {
    text: `👑 *الأفضل في ${gameDisplayName}*\n\n${lines.join('\n\n')}`,
    mentions: top3.map(({ p }) => p.jid)
  };
}
