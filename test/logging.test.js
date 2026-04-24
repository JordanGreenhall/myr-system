'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createLogger, normalizeLevel } = require('../lib/logging');

function createBufferStream() {
  const lines = [];
  return {
    lines,
    write(value) {
      lines.push(String(value));
    },
  };
}

describe('lib/logging', () => {
  it('normalizes invalid levels to info', () => {
    assert.equal(normalizeLevel('verbose'), 'info');
    assert.equal(normalizeLevel('WARN'), 'warn');
  });

  it('emits valid JSON records with expected fields', () => {
    const stdout = createBufferStream();
    const stderr = createBufferStream();
    const logger = createLogger({ level: 'info', stdout, stderr, base: { component: 'test' } });

    logger.info('hello', { foo: 'bar' });

    assert.equal(stdout.lines.length, 1);
    const parsed = JSON.parse(stdout.lines[0]);
    assert.equal(parsed.level, 'info');
    assert.equal(parsed.message, 'hello');
    assert.equal(parsed.component, 'test');
    assert.equal(parsed.foo, 'bar');
    assert.ok(typeof parsed.timestamp === 'string');
  });

  it('filters below configured level', () => {
    const stdout = createBufferStream();
    const stderr = createBufferStream();
    const logger = createLogger({ level: 'warn', stdout, stderr });

    logger.info('skip');
    logger.warn('keep');

    assert.equal(stdout.lines.length, 0);
    assert.equal(stderr.lines.length, 1);
    const parsed = JSON.parse(stderr.lines[0]);
    assert.equal(parsed.level, 'warn');
    assert.equal(parsed.message, 'keep');
  });
});
