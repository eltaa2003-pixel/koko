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

export async function recordWin({ jid, game, timeTaken, label, answeredCount = 1 }) {
  const doc = await PlayerStats.findOneAndUpdate(
    { jid, game },
    { $inc: { wins: 1, totalTime: timeTaken, totalAnswered: answeredCount } },
    { upsert: true, new: true }
  );

  if (doc.bestTime === null || timeTaken < doc.bestTime) {
    doc.bestTime = timeTaken;
    doc.bestTimeLabel = label;
    await doc.save();
  }
}

export async function getLeaderboardText(game, gameDisplayName) {
  const top = await PlayerStats.find({ game }).sort({ wins: -1 }).limit(3);
  if (!top.length) return null;

  const lines = top.map((p, i) => {
    const rank = i + 1;
    const mention = `@${p.jid.split('@')[0]}`;
    const avg = (p.totalTime / p.wins).toFixed(3);
    const best = p.bestTime !== null ? `${p.bestTime.toFixed(3)}s (${p.bestTimeLabel})` : '—';
    return `${rank}. ${mention}\n   🏅 فوز: ${p.wins} | إجابات: ${p.totalAnswered}\n   ⚡ الأسرع: ${best}\n   📊 المعدل: ${avg}s`;
  });

  return {
    text: `🏆 *متصدرو ${gameDisplayName}*\n\n${lines.join('\n\n')}`,
    mentions: top.map(p => p.jid)
  };
}