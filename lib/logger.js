import pino from 'pino';

const coreLogger = pino({
  level: process.env.LOG_LEVEL || 'warn'
});

const originalStdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = function (chunk, encoding, cb) {
  const str = typeof chunk === 'string' ? chunk : chunk.toString();
  const pinoMatch = str.match(/^\{.*"level":(\d+)/);
  if (pinoMatch) {
    const level = parseInt(pinoMatch[1], 10);
    if (level < 30) return true;
  }
  return originalStdoutWrite(str, encoding, cb);
};

export function createSilentLogger() {
  return pino({
    level: 'warn',
    stream: { write: () => {} }
  }).child({ class: 'baileys' });
}

export default coreLogger;
