'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { canonicalize } = require('../lib/canonicalize');

describe('canonicalize', () => {
  it('sorts keys alphabetically', () => {
    const result = canonicalize({ z: 1, a: 2, m: 3 });
    assert.equal(result, '{"a":2,"m":3,"z":1}');
  });

  it('sorts nested object keys recursively', () => {
    const result = canonicalize({
      outer_b: { inner_z: 1, inner_a: 2 },
      outer_a: 'first',
    });
    assert.equal(
      result,
      '{"outer_a":"first","outer_b":{"inner_a":2,"inner_z":1}}'
    );
  });

  it('handles deeply nested objects', () => {
    const result = canonicalize({
      c: { b: { a: { z: true, a: false } } },
    });
    assert.equal(result, '{"c":{"b":{"a":{"a":false,"z":true}}}}');
  });

  it('produces no whitespace', () => {
    const result = canonicalize({
      name: 'jordan',
      rating: 5,
      tags: ['myr', 'test'],
    });
    assert.ok(!result.includes(' '));
    assert.ok(!result.includes('\n'));
    assert.ok(!result.includes('\t'));
  });

  it('is reproducible — same input always produces same output', () => {
    const input = {
      operator_name: 'jordan',
      created_at: '2026-03-02T09:00:00Z',
      method_name: 'myr-system node handoff',
      observations: ['one', 'two'],
      metadata: { agent: 'polemarch', model: 'claude' },
    };
    const a = canonicalize(input);
    const b = canonicalize(input);
    const c = canonicalize(JSON.parse(JSON.stringify(input)));
    assert.equal(a, b);
    assert.equal(a, c);
  });

  it('matches the spec example', () => {
    const result = canonicalize({
      operator_name: 'jordan',
      created_at: '2026-03-02T09:00:00Z',
      method_name: 'test',
    });
    assert.equal(
      result,
      '{"created_at":"2026-03-02T09:00:00Z","method_name":"test","operator_name":"jordan"}'
    );
  });

  it('handles arrays preserving order', () => {
    const result = canonicalize({ items: [3, 1, 2] });
    assert.equal(result, '{"items":[3,1,2]}');
  });

  it('handles null and boolean values', () => {
    assert.equal(canonicalize(null), 'null');
    assert.equal(canonicalize(true), 'true');
    assert.equal(canonicalize(false), 'false');
  });

  it('handles strings with special characters', () => {
    const result = canonicalize({ msg: 'hello "world"\nnewline' });
    assert.equal(result, '{"msg":"hello \\"world\\"\\nnewline"}');
  });

  it('skips undefined values in objects', () => {
    const result = canonicalize({ a: 1, b: undefined, c: 3 });
    assert.equal(result, '{"a":1,"c":3}');
  });

  it('handles empty objects and arrays', () => {
    assert.equal(canonicalize({}), '{}');
    assert.equal(canonicalize([]), '[]');
    assert.equal(canonicalize({ a: {} }), '{"a":{}}');
  });
});
