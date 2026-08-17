import mongoose from 'mongoose';

const gateSchema = new mongoose.Schema({
  _id: String, // chatId (e.g. "1203xxxx@g.us")
  status: { type: String, enum: ['open', 'closed'], default: 'open' }
});

const GateModel = mongoose.models.GroupGate || mongoose.model('GroupGate', gateSchema);

const cache = new Map();

export async function getGateStatus(chatId) {
  if (cache.has(chatId)) return cache.get(chatId);

  let status = 'open';
  try {
    const doc = await GateModel.findById(chatId);
    if (doc?.status) status = doc.status;
  } catch {
    status = 'open';
  }

  cache.set(chatId, status);
  return status;
}

export async function setGateStatus(chatId, status) {
  cache.set(chatId, status);
  await GateModel.findByIdAndUpdate(chatId, { status }, { upsert: true });
}
