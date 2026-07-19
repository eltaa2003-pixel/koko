import pino from 'pino';

// Baileys logs A LOT at 'debug'/'trace' — that's a real source of slowdown
// over a long-running session, not just noisy output. Keep it at 'warn' by
// default; set LOG_LEVEL=debug in the env when you actually need to see
// what's happening on the wire.
const logger = pino({
  level: process.env.LOG_LEVEL || 'warn'
});

export default logger;
