// Run this ONCE before deploying the Mongo-backed ss.js/ta3.js/addq.js,
// so your existing سس/تع questions aren't lost.
//
// Usage (from the project root, with MONGO_URL pointed at your real DB —
// either run it locally with the prod MONGO_URL in your .env, or from a
// Render Shell on the service):
//
//   node scripts/migrate-game-data.js
//
// Safe to run more than once: it skips any question that's already in
// the DB under the same category.

import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import mongoose from 'mongoose';
import { GameQuestion } from '../lib/gameData.js';

const GAME_DATA_PATH = path.resolve('plugins/game-data.json');

async function main() {
  if (!process.env.MONGO_URL) {
    console.error('MONGO_URL is not set — aborting.');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URL);
  console.log('connected to mongo');

  const raw = await readFile(GAME_DATA_PATH, 'utf-8');
  const data = JSON.parse(raw);

  for (const category of ['سس', 'تع']) {
    const entries = data[category] || [];
    let inserted = 0;
    let skipped = 0;

    for (const entry of entries) {
      const exists = await GameQuestion.exists({ category, question: entry.question });
      if (exists) {
        skipped++;
        continue;
      }
      await GameQuestion.create({ category, question: entry.question, answers: entry.answers });
      inserted++;
    }

    console.log(`${category}: inserted ${inserted}, skipped ${skipped} (already present)`);
  }

  await mongoose.disconnect();
  console.log('done');
}

main().catch(err => {
  console.error('migration failed:', err);
  process.exit(1);
});
