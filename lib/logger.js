import pino from 'pino';

const coreLogger = pino({
  level: process.env.LOG_LEVEL || 'warn'
});

export function createSilentLogger() {
  return pino({
    level: 'warn',
    stream: { write: () => {} }
  }).child({ class: 'baileys' });
}

export default coreLogger;
