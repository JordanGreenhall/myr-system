'use strict';

/**
 * RFC 8785 JSON Canonicalization Scheme (JCS).
 *
 * Produces a deterministic JSON string with:
 *   - Alphabetically sorted keys at every nesting level
 *   - No whitespace
 *   - UTF-8 encoding
 *   - ES2015+ Number serialization for numeric values
 */

function canonicalize(value) {
  if (value === null || value === undefined) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';

    case 'number':
      if (!isFinite(value)) return 'null';
      return JSON.stringify(value);

    case 'string':
      return JSON.stringify(value);

    case 'object':
      if (Array.isArray(value)) {
        const items = value.map((item) => canonicalize(item));
        return '[' + items.join(',') + ']';
      }

      const keys = Object.keys(value).sort();
      const pairs = [];
      for (const key of keys) {
        if (value[key] === undefined) continue;
        pairs.push(JSON.stringify(key) + ':' + canonicalize(value[key]));
      }
      return '{' + pairs.join(',') + '}';

    default:
      return undefined;
  }
}

module.exports = { canonicalize };
