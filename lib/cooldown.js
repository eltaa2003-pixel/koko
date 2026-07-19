const lastUsed = new Map();

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
  return false;
}
