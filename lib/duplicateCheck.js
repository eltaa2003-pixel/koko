export function findExactDuplicate(candidateText, existingList, extractText, normalizeFn) {
  const key = normalizeFn(candidateText);
  return existingList.find(item => normalizeFn(extractText(item)) === key) || null;
}

export function findAnswerCollisions(newAnswers, pool, normalizeFn) {
  const collisions = [];
  for (const ans of newAnswers) {
    const key = normalizeFn(ans);
    const owner = pool.find(q =>
      (Array.isArray(q.answers) ? q.answers.flat() : [q.answers]).some(a => normalizeFn(a) === key)
    );
    if (owner) collisions.push({ answer: ans, existingQuestion: owner.question });
  }
  return collisions;
}
