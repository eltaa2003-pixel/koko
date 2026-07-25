import mongoose from 'mongoose';

const playerStatsSchema = new mongoose.Schema({
  jid: { type: String, required: true },
  game: { type: String, required: true },
  wins: { type: Number, default: 0 },
  totalAnswered: { type: Number, default: 0 },
  totalTime: { type: Number, default: 0 },
  bestTime: { type: Number, default: null },
  bestTimeLabel: { type: String, default: null }
});

playerStatsSchema.index({ jid: 1, game: 1 }, { unique: true });

export const PlayerStats = mongoose.models.PlayerStats || mongoose.model('PlayerStats', playerStatsSchema);

const JID_RE = /^\d+@\S+$/;

export async function recordWin({ jid, game, timeTaken, label, answeredCount = 1 }) {
  if (!JID_RE.test(jid)) throw new TypeError('invalid jid');

  await PlayerStats.updateOne(
    { jid, game },
    [
      {
        $set: {
          wins: { $add: [{ $ifNull: ['$wins', 0] }, 1] },
          totalTime: { $add: [{ $ifNull: ['$totalTime', 0] }, timeTaken] },
          totalAnswered: { $add: [{ $ifNull: ['$totalAnswered', 0] }, answeredCount] },
          bestTime: {
            $cond: [
              { $or: [{ $eq: [{ $ifNull: ['$bestTime', null] }, null] }, { $lt: [timeTaken, '$bestTime'] }] },
              timeTaken,
              '$bestTime'
            ]
          },
          bestTimeLabel: {
            $cond: [
              { $or: [{ $eq: [{ $ifNull: ['$bestTime', null] }, null] }, { $lt: [timeTaken, '$bestTime'] }] },
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
  // wpm: answers extrapolated to a 1-minute rate (higher is better)
  const withStats = players.map(p => ({
    p,
    avgReaction: p.totalTime / p.totalAnswered,
    wpm: (p.totalAnswered / p.totalTime) * 60
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