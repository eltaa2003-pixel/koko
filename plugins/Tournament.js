// بطولة — chains تفكيك, pic (صور), a mixed سس/تع section, and كت into
// one run. سس and تع questions inside the mixed section alternate one
// after another, both shown as "سع/" so no one can tell which of the two
// they're actually answering.
//
// .بدء  → fixed mode: each section ends once someone hits 5 points in it.
// .بدا  → random mode: each section's point target is a hidden random
//         number (2–6), re-rolled every section, so nobody knows how
//         close the switch is.
// .سبطولة → stop early and show final totals.
//
// Neither mode ever announces which section is coming next — the next
// question is just sent, and its shape (spaced letters / a picture /
// "سع/" question / single word) is the only hint.

import { getRandomWords as getKatWords, recentTracker as katRecentTracker } from './kat.js';
import { recentTracker as tafkikRecentTracker, buildLetterSeqs } from './tafkik.js';
import { getRandomQuestion as ssGetRandomQuestion, recentTracker as ssRecentTracker, buildAnswerData } from './ss.js';
import { getRandomQuestion as ta3GetRandomQuestion, recentTracker as ta3RecentTracker, buildAnswersMap } from './ta3.js';
import { getLocalImageList, pickRandom as pickRandomImage } from './pic.js';
import { normalizeLenient, normalizeStrict } from '../lib/normalizeArabic.js';
import { stopAllGamesWithReport } from '../lib/games.js';

const SECTION_ORDER = ['tafkik', 'pic', 'mixed', 'kat'];
const FIXED_TARGET = 5;

const SECTION_LABELS = {
  tafkik: 'تفكيك',
  pic: 'صور',
  mixed: 'سع',
  kat: 'كت'
};

function randomTarget() {
  return 2 + Math.floor(Math.random() * 5); // 2..6, hidden from players
}

function containsSeq(arr, seq) {
  if (!seq.length) return false;
  for (let i = 0; i + seq.length <= arr.length; i++) {
    let ok = true;
    for (let k = 0; k < seq.length; k++) {
      if (arr[i + k] !== seq[k]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

// ---- per-game question pickers -------------------------------------

function pickKatQuestion(chatId, wordCount = 1) {
  const words = getKatWords(wordCount, katRecentTracker.getExcluded(chatId));
  const norms = words.map(w => normalizeLenient(w));
  katRecentTracker.record(chatId, norms);
  return {
    type: 'kat',
    tokens: norms.map(n => n.split(' ').filter(Boolean)),
    display: `*كت/ ${words.join(' - ')}*`
  };
}

function pickTafkikQuestion(chatId, wordCount = 1) {
  const words = getKatWords(wordCount, tafkikRecentTracker.getExcluded(chatId));
  const norms = words.map(w => normalizeLenient(w));
  tafkikRecentTracker.record(chatId, norms);
  return {
    type: 'tafkik',
    letterSeqs: buildLetterSeqs(norms),
    display: `*${words.join(' - ')}*`
  };
}

function pickMixedQuestion(chatId, subGame) {
  if (subGame === 'ss') {
    const q = ssGetRandomQuestion(ssRecentTracker.getExcluded(chatId));
    if (!q) return null;
    ssRecentTracker.record(chatId, [normalizeStrict(q.question)]);
    return { type: 'mixed', subGame: 'ss', answerData: buildAnswerData(q.answers), players: {}, display: `*سع/ ${q.question}*` };
  }
  const q = ta3GetRandomQuestion(ta3RecentTracker.getExcluded(chatId));
  if (!q) return null;
  ta3RecentTracker.record(chatId, [normalizeStrict(q.question)]);
  return { type: 'mixed', subGame: 'ta3', answersMap: buildAnswersMap(q.answers), players: {}, display: `*سع/3 ${q.question}*` };
}

function pickPicQuestion(excludeItem) {
  const list = getLocalImageList();
  const [item] = pickRandomImage(list, 1, excludeItem || undefined);
  if (!item) return null;
  return { type: 'pic', item, answerVariants: item.answerVariants };
}

// ---- section lifecycle -----------------------------------------------

function initSection(sectionType, chatId, wordCount) {
  if (sectionType === 'kat') return pickKatQuestion(chatId, wordCount);
  if (sectionType === 'tafkik') return pickTafkikQuestion(chatId, wordCount);
  if (sectionType === 'mixed') return pickMixedQuestion(chatId, 'ss'); // mixed section always opens on سس
  if (sectionType === 'pic') return pickPicQuestion(null);
  return null;
}

function nextQuestionSameSection(chatId, current, wordCount) {
  if (current.type === 'kat') return pickKatQuestion(chatId, wordCount);
  if (current.type === 'tafkik') return pickTafkikQuestion(chatId, wordCount);
  if (current.type === 'pic') return pickPicQuestion(current.item);
  // mixed — flip سس/تع every question
  const nextSub = current.subGame === 'ss' ? 'ta3' : 'ss';
  return pickMixedQuestion(chatId, nextSub);
}

function leaderboardText(scores) {
  return Object.entries(scores)
    .sort((a, b) => b[1] - a[1])
    .map(([jid, pts]) => `-@${jid.split('@')[0]} ${pts}`)
    .join('\n');
}

// Builds the actual sendMessage body for whatever section type is up next,
// with the running leaderboard folded in (as body text, or as an image
// caption for pic questions).
function buildSendContent(current, boardText, mentions) {
  if (current.type === 'pic') {
    const content = { image: { url: current.item.path } };
    if (boardText) {
      content.caption = boardText;
      content.mentions = mentions;
    }
    return content;
  }
  const text = boardText ? `${boardText}\n\n${current.display}` : current.display;
  return { text, mentions };
}

// ---- message handling --------------------------------------------------

const registeredSocks = new WeakSet();

function ensureGlobalListener(ctx) {
  if (registeredSocks.has(ctx.sock)) return;
  registeredSocks.add(ctx.sock);

  ctx.sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify' && type !== 'append') return;

    const store = ctx.store.namespace('tournamentGame');
    const pendingStore = ctx.store.namespace('tournamentPendingStart');

    for (const m of messages) {
      if (!m.message || m.key.fromMe) continue;

      const chatId = m.key.remoteJid;

      const pending = pendingStore.get(chatId);
      if (pending) {
        handlePendingStart(ctx, chatId, pending, m).catch(err => console.error('بطولة pending start error:', err));
        continue;
      }

      const state = store.get(chatId);
      if (!state) continue;

      state.queue = state.queue
        .then(() => processMessage(ctx, chatId, state, m))
        .catch(err => console.error('بطولة processing error:', err));
    }
  });
}

async function handlePendingStart(ctx, chatId, pending, m) {
  const pendingStore = ctx.store.namespace('tournamentPendingStart');

  if (process.hrtime.bigint() - pending.timestamp > 120000000000000n) {
    pendingStore.delete(chatId);
    await ctx.sock.sendMessage(chatId, { text: 'انتهت المهلة. أرسل .بدء أو .بدا مجدداً إذا أردت.' }, { quoted: m }).catch(() => {});
    return;
  }

  const text = m.message?.conversation || m.message?.extendedTextMessage?.text || '';
  if (!text) return;

  const value = parseInt(text.trim(), 10);
  if (!Number.isInteger(value) || value < 1) {
    await ctx.sock.sendMessage(chatId, { text: 'أرسل رقماً صحيحاً أكبر من 0.' }, { quoted: m }).catch(() => {});
    return;
  }

  if (pending.step === 'target') {
    pendingStore.set(chatId, {
      step: 'wordCount',
      mode: 'fixed',
      target: value,
      timestamp: process.hrtime.bigint()
    });
    await ctx.sock.sendMessage(chatId, { text: 'كم اسم بدك بقسم التفكيك والكت؟ أرسل رقماً.' }, { quoted: m }).catch(() => {});
    return;
  }

  // step === 'wordCount'
  pendingStore.delete(chatId);
  const wordCount = value;

  const sections = SECTION_ORDER.slice();
  const current = initSection(sections[0], chatId, wordCount);
  if (!current) {
    await ctx.sock.sendMessage(chatId, { text: 'فيه غلط' }).catch(() => {});
    return;
  }

  const state = {
    mode: pending.mode,
    sections,
    sectionIndex: 0,
    sectionTarget: pending.mode === 'random' ? randomTarget() : pending.target,
    wordCount,
    sectionScores: {},
    scores: {},
    current,
    queue: Promise.resolve(),
    isTransitioning: false
  };

  ctx.store.namespace('tournamentGame').set(chatId, state);

  await ctx.sock.sendMessage(chatId, { text: `القسم الأول: ${SECTION_LABELS[sections[0]]}` }).catch(() => {});
  const content = buildSendContent(current, '', []);
  await ctx.sock.sendMessage(chatId, content, { quoted: m }).catch(() => {});
}

async function processMessage(ctx, chatId, state, m) {
  const store = ctx.store.namespace('tournamentGame');
  if (store.get(chatId) !== state) return;
  if (state.isTransitioning) return;

  const text =
    m.message?.conversation ||
    m.message?.extendedTextMessage?.text ||
    m.message?.imageMessage?.caption ||
    m.message?.videoMessage?.caption ||
    '';
  if (!text) return;

  const senderJid = m.key.participant || m.key.remoteJid;
  const current = state.current;
  let won = false;

  if (current.type === 'kat') {
    const words = normalizeLenient(text).split(/[^\u0621-\u064A]+/).filter(Boolean);
    won = current.tokens.every(seq => containsSeq(words, seq));
  } else if (current.type === 'tafkik') {
    const letters = normalizeLenient(text).split(/[^\u0621-\u064A]+/).filter(Boolean);
    won = current.letterSeqs.every(seq => containsSeq(letters, seq));
  } else if (current.type === 'pic') {
    const words = normalizeStrict(text).split(/[^\u0621-\u064A]+/).filter(Boolean);
    won = current.answerVariants.some(variant => containsSeq(words, variant.split(' ').filter(Boolean)));
  } else if (current.type === 'mixed') {
    if (!current.players[senderJid]) current.players[senderJid] = new Set();
    const playerSet = current.players[senderJid];
    const incomingWords = normalizeStrict(text).split(/[^\u0621-\u064A]+/).filter(Boolean);

    if (current.subGame === 'ss') {
      const { lookup, maxWords, slotCount } = current.answerData;
      for (let i = 0; i < incomingWords.length; i++) {
        for (let len = 1; len <= maxWords && i + len <= incomingWords.length; len++) {
          const slotIndex = lookup.get(incomingWords.slice(i, i + len).join(' '));
          if (slotIndex !== undefined) playerSet.add(slotIndex);
        }
      }
      won = playerSet.size >= slotCount;
    } else {
      for (let i = 0; i < incomingWords.length; i++) {
        if (i < incomingWords.length - 1) {
          const duo = `${incomingWords[i]} ${incomingWords[i + 1]}`;
          if (current.answersMap.has(duo) && !playerSet.has(duo)) {
            playerSet.add(duo);
            i++;
            continue;
          }
        }
        const mono = incomingWords[i];
        if (current.answersMap.has(mono) && !playerSet.has(mono)) playerSet.add(mono);
      }
      won = playerSet.size >= 3;
    }
  }

  if (!won) return;
  state.isTransitioning = true;

  state.scores[senderJid] = (state.scores[senderJid] || 0) + 1;
  state.sectionScores[senderJid] = (state.sectionScores[senderJid] || 0) + 1;

  const sectionDone = state.sectionScores[senderJid] >= state.sectionTarget;
  let nextCurrent = null;

  if (sectionDone) {
    state.sectionIndex++;

    if (state.sectionIndex >= state.sections.length) {
      store.delete(chatId);
      const ranked = Object.entries(state.scores)
        .sort((a, b) => b[1] - a[1])
        .map(([jid, pts], i) => `${i + 1}. @${jid.split('@')[0]} - ${pts}`);
      const mentions = Object.keys(state.scores);
      await ctx.sock.sendMessage(chatId, {
        text: `انتهت البطولة 🏆\n\nالنتائج النهائية:\n${ranked.join('\n')}`,
        mentions
      }).catch(err => console.error('بطولة final send error:', err));
      return;
    }

    state.sectionScores = {};
    state.sectionTarget = state.mode === 'random' ? randomTarget() : FIXED_TARGET;
    await ctx.sock.sendMessage(chatId, { text: `القسم القادم: ${SECTION_LABELS[state.sections[state.sectionIndex]]}` }).catch(() => {});
    nextCurrent = initSection(state.sections[state.sectionIndex], chatId, state.wordCount);
  } else {
    nextCurrent = nextQuestionSameSection(chatId, current, state.wordCount);
  }

  if (!nextCurrent) {
    store.delete(chatId);
    await ctx.sock.sendMessage(chatId, { text: 'خطأ: تعذر تحضير السؤال التالي(شكرا جيبيتي) — تم إيقاف البطولة.' }).catch(() => {});
    return;
  }

  state.current = nextCurrent;

  const mentions = Object.keys(state.scores);
  const content = buildSendContent(nextCurrent, leaderboardText(state.scores), mentions);

  ctx.sock.sendMessage(chatId, content, { quoted: m })
    .then(() => { state.isTransitioning = false; })
    .catch(err => {
      console.error('بطولة send error:', err);
      state.isTransitioning = false;
    });
}

export default {
  name: 'بطولة',
  aliases: ['بدء', 'بدا', 'سبطولة'],
  description: 'المفروض اكتب شي هنا بس مهتم',
  cooldown: 0,

  async execute(ctx) {
    ensureGlobalListener(ctx);

    const store = ctx.store.namespace('tournamentGame');
    const commandUsed = ctx.command.toLowerCase();

    if (commandUsed === 'سبطولة') {
      if (!store.has(ctx.chatId)) {
        await ctx.reply('لا توجد بطولة شغالة حالياً.');
        return;
      }
      const state = store.get(ctx.chatId);
      store.delete(ctx.chatId);

      const leaderboard = Object.entries(state.scores || {}).sort((a, b) => b[1] - a[1]);
      if (!leaderboard.length) {
        await ctx.reply('تم إيقاف البطولة. لم يسجل أحد أي نقطة.');
        return;
      }

      const lines = leaderboard.map(([jid, pts], i) => `${i + 1}. @${jid.split('@')[0]} - ${pts}`);
      const mentions = leaderboard.map(([jid]) => jid);

      await ctx.sock.sendMessage(ctx.chatId, {
        text: `تم إيقاف البطولة\n\nالنتائج النهائية:\n${lines.join('\n')}`,
        mentions
      });
      return;
    }

    if (commandUsed !== 'بدء' && commandUsed !== 'بدا') {
      await ctx.reply('استخدم .بدء (نقاط ثابتة تحددها) أو .بدا (نقاط عشوائية مخفية) لبدء البطولة، أو .سبطولة لإيقافها.');
      return;
    }

    await stopAllGamesWithReport(ctx);

    if (commandUsed === 'بدء') {
      ctx.store.namespace('tournamentPendingStart').set(ctx.chatId, {
        step: 'target',
        timestamp: process.hrtime.bigint()
      });
      await ctx.reply('كم نقطة تريد أن تكون خط النهاية لكل قسم؟ أرسل رقماً.');
      return;
    }

    if (commandUsed === 'بدا') {
      ctx.store.namespace('tournamentPendingStart').set(ctx.chatId, {
        step: 'wordCount',
        mode: 'random',
        timestamp: process.hrtime.bigint()
      });
      await ctx.reply('كم اسم بدك بقسم التفكيك والكت؟ أرسل رقماً.');
      return;
    }
};