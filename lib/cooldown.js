const lastUsed = new Map();
const MAX_ENTRIES = 10000;

/**
 * Returns false if `userId` is clear to run `command` right now (and records
 * this use). Returns the number of seconds left to wait if they're still on
 * cooldown.
 */
export function checkCooldown(userId, command, seconds) {
  const key = `${userId}:${command}`;
  const now = Date.now();
  const last = lastUsed.get(key);

  if (last && now - last < seconds * 1000) {
    return Math.ceil((seconds * 1000 - (now - last)) / 1000);
  }

  lastUsed.set(key, now);

  // Evict the single oldest entry (Maps iterate in insertion order, so the
  // first key is the oldest). This is O(1) per call. The previous version
  // did `Array.from(lastUsed.keys())` here — copying up to 10,000 keys into
  // a fresh array on *every single command call* once the map filled up
  // (which happens within hours on an active bot). That's why things got
  // slower the longer the bot stayed up: every cooldown check after the
  // first day was paying for a 10,000-element array allocation + scan.
  if (lastUsed.size > MAX_ENTRIES) {
    const oldestKey = lastUsed.keys().next().value;
    lastUsed.delete(oldestKey);
  }

  return false;
}
