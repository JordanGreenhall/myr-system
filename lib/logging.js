'use strict';

const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function normalizeLevel(level) {
  const value = String(level || '').toLowerCase();
  return Object.prototype.hasOwnProperty.call(LEVELS, value) ? value : 'info';
}

function createLogger(options = {}) {
  const minLevel = normalizeLevel(options.level || process.env.MYR_LOG_LEVEL || 'info');
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const base = options.base || {};

  function shouldLog(level) {
    return LEVELS[level] >= LEVELS[minLevel];
  }

  function write(level, message, metadata = {}) {
    if (!shouldLog(level)) return;
    const record = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...base,
      ...(metadata && typeof metadata === 'object' ? metadata : { metadata }),
    };
    const line = JSON.stringify(record);
    const stream = level === 'warn' || level === 'error' ? stderr : stdout;
    stream.write(`${line}\n`);
  }

  return {
    level: minLevel,
    debug: (message, metadata) => write('debug', message, metadata),
    info: (message, metadata) => write('info', message, metadata),
    warn: (message, metadata) => write('warn', message, metadata),
    error: (message, metadata) => write('error', message, metadata),
    child: (metadata = {}) =>
      createLogger({ level: minLevel, stdout, stderr, base: { ...base, ...metadata } }),
  };
}

const logger = createLogger();

module.exports = {
  LEVELS,
  normalizeLevel,
  createLogger,
  ...logger,
};
