import mongoose from 'mongoose';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const GAME_DATA_PATH = path.resolve('plugins/game-data.json');

// One document per question. `answers` is a flat array of accepted spellings
// (تع, and single-answer سس) or an array of arrays — one inner array per
// required slot — for multi-answer سس questions (e.g. أبناء ناروتو).
const gameQuestionSchema = new mongoose.Schema({
  category: { type: String, required: true, index: true },
  question: { type: String, required: true },
  answers: { type: mongoose.Schema.Types.Mixed, required: true }
});

gameQuestionSchema.index({ category: 1, question: 1 });

export const GameQuestion = mongoose.models.GameQuestion || mongoose.model('GameQuestion', gameQuestionSchema);

// Loads every question in a category into plain, mutable objects (kept in
// memory by the plugin that calls this — same shape as the old
// game-data.json entries, plus `_id` so edits can be written back).
export async function loadCategory(category) {
  const docs = await GameQuestion.find({ category }).lean();
  return docs.map(d => ({ _id: d._id, question: d.question, answers: d.answers }));
}

export async function insertQuestion(category, question, answers) {
  const doc = await GameQuestion.create({ category, question, answers });
  return { _id: doc._id, question: doc.question, answers: doc.answers };
}

export async function saveAnswers(id, answers) {
  await GameQuestion.findByIdAndUpdate(id, { answers });
}

export async function seedFromFileIfNeeded() {
  let raw;
  try {
    raw = await readFile(GAME_DATA_PATH, 'utf-8');
  } catch (err) {
    console.warn('seedFromFileIfNeeded: could not read game-data.json, skipping seed', err);
    return;
  }

  const data = JSON.parse(raw);

  for (const category of ['سس', 'تع']) {
    const entries = data[category] || [];
    if (!entries.length) continue;

    const existingCount = await GameQuestion.countDocuments({ category });
    if (existingCount > 0) continue;

    const docs = entries.map(e => ({ category, question: e.question, answers: e.answers }));
    await GameQuestion.insertMany(docs);
    console.log(`seeded ${docs.length} "${category}" question(s) from game-data.json`);
  }
}
