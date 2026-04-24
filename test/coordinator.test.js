'use strict';

const { describe, it } = require('node:test');
const assert = require('assert/strict');
const Database = require('better-sqlite3');
const { generateKeypair } = require('../lib/crypto');
const { ensureSubscriptionsSchema, createSignedSignal, upsertSubscriptionSignal } = require('../lib/subscriptions');
const { DomainCoordinator } = require('../lib/coordinator');

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeKeys() {
  return generateKeypair();
}

function makeDb() {
  const db = new Database(':memory:');
  ensureSubscriptionsSchema(db);
  return db;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('DomainCoordinator', () => {
  describe('register / route', () => {
    it('registers a peer for domains and routes correctly', () => {
      const coord = new DomainCoordinator();
      const keys = makeKeys();

      const result = coord.register(keys.publicKey, ['security', 'performance']);
      assert.equal(result.publicKey, keys.publicKey);
      assert.deepEqual(result.domains, ['performance', 'security']);
      assert.ok(result.registeredAt);

      const secPeers = coord.route('security');
      assert.equal(secPeers.length, 1);
      assert.equal(secPeers[0].publicKey, keys.publicKey);

      const perfPeers = coord.route('performance');
      assert.equal(perfPeers.length, 1);
      assert.equal(perfPeers[0].publicKey, keys.publicKey);
    });

    it('returns empty array for unknown domain', () => {
      const coord = new DomainCoordinator();
      const peers = coord.route('nonexistent');
      assert.deepEqual(peers, []);
    });

    it('normalizes domain tags (lowercase, trimmed, sorted)', () => {
      const coord = new DomainCoordinator();
      const keys = makeKeys();

      coord.register(keys.publicKey, ['  Security  ', 'PERFORMANCE']);

      const peers = coord.route('security');
      assert.equal(peers.length, 1);
    });

    it('replaces previous registrations for same peer', () => {
      const coord = new DomainCoordinator();
      const keys = makeKeys();

      coord.register(keys.publicKey, ['security']);
      coord.register(keys.publicKey, ['performance']);

      const secPeers = coord.route('security');
      assert.equal(secPeers.length, 0, 'old domain should be removed');

      const perfPeers = coord.route('performance');
      assert.equal(perfPeers.length, 1);
    });

    it('supports multiple peers for same domain', () => {
      const coord = new DomainCoordinator();
      const keys1 = makeKeys();
      const keys2 = makeKeys();
      const keys3 = makeKeys();

      coord.register(keys1.publicKey, ['security']);
      coord.register(keys2.publicKey, ['security']);
      coord.register(keys3.publicKey, ['security', 'performance']);

      const secPeers = coord.route('security');
      assert.equal(secPeers.length, 3);
    });

    it('throws on missing publicKey', () => {
      const coord = new DomainCoordinator();
      assert.throws(() => coord.register(null, ['security']), /publicKey is required/);
    });

    it('throws on empty domains', () => {
      const coord = new DomainCoordinator();
      const keys = makeKeys();
      assert.throws(() => coord.register(keys.publicKey, []), /At least one domain tag/);
    });
  });

  describe('unregister', () => {
    it('removes all domain registrations for a peer', () => {
      const coord = new DomainCoordinator();
      const keys = makeKeys();

      coord.register(keys.publicKey, ['security', 'performance']);
      const removed = coord.unregister(keys.publicKey);

      assert.equal(removed, true);
      assert.deepEqual(coord.route('security'), []);
      assert.deepEqual(coord.route('performance'), []);
    });

    it('returns false for unknown peer', () => {
      const coord = new DomainCoordinator();
      assert.equal(coord.unregister('nonexistent'), false);
    });

    it('cleans up empty domains from routing table', () => {
      const coord = new DomainCoordinator();
      const keys = makeKeys();

      coord.register(keys.publicKey, ['security']);
      coord.unregister(keys.publicKey);

      const domains = coord.listDomains();
      assert.equal(domains.length, 0);
    });
  });

  describe('routeMultiple', () => {
    it('returns deduplicated peers across multiple domains', () => {
      const coord = new DomainCoordinator();
      const keys1 = makeKeys();
      const keys2 = makeKeys();

      coord.register(keys1.publicKey, ['security', 'compliance']);
      coord.register(keys2.publicKey, ['security']);

      const result = coord.routeMultiple(['security', 'compliance']);
      assert.equal(result.length, 2);

      const k1Entry = result.find(r => r.publicKey === keys1.publicKey);
      assert.ok(k1Entry);
      assert.deepEqual(k1Entry.matchedDomains.sort(), ['compliance', 'security']);
    });

    it('returns empty for no matching domains', () => {
      const coord = new DomainCoordinator();
      const result = coord.routeMultiple(['unknown']);
      assert.deepEqual(result, []);
    });
  });

  describe('listDomains', () => {
    it('lists all domains sorted by peer count', () => {
      const coord = new DomainCoordinator();
      const keys1 = makeKeys();
      const keys2 = makeKeys();
      const keys3 = makeKeys();

      coord.register(keys1.publicKey, ['security']);
      coord.register(keys2.publicKey, ['security', 'performance']);
      coord.register(keys3.publicKey, ['performance']);

      const domains = coord.listDomains();
      assert.equal(domains.length, 2);
      // Both have 2 peers
      assert.equal(domains[0].peerCount, 2);
      assert.equal(domains[1].peerCount, 2);
    });
  });

  describe('getDomainsForPeer', () => {
    it('returns sorted domains for a peer', () => {
      const coord = new DomainCoordinator();
      const keys = makeKeys();

      coord.register(keys.publicKey, ['performance', 'security', 'compliance']);
      const domains = coord.getDomainsForPeer(keys.publicKey);
      assert.deepEqual(domains, ['compliance', 'performance', 'security']);
    });

    it('returns empty for unknown peer', () => {
      const coord = new DomainCoordinator();
      assert.deepEqual(coord.getDomainsForPeer('unknown'), []);
    });
  });

  describe('selectPeersForReport', () => {
    it('returns matching peer keys for report domains', () => {
      const coord = new DomainCoordinator();
      const keys1 = makeKeys();
      const keys2 = makeKeys();
      const keys3 = makeKeys();

      coord.register(keys1.publicKey, ['security']);
      coord.register(keys2.publicKey, ['performance']);
      coord.register(keys3.publicKey, ['security', 'compliance']);

      const selected = coord.selectPeersForReport(['security']);
      assert.ok(Array.isArray(selected));
      assert.equal(selected.length, 2);
      assert.ok(selected.includes(keys1.publicKey));
      assert.ok(selected.includes(keys3.publicKey));
    });

    it('returns null when no domains match (fallback signal)', () => {
      const coord = new DomainCoordinator();
      const keys = makeKeys();
      coord.register(keys.publicKey, ['security']);

      const selected = coord.selectPeersForReport(['unknown-domain']);
      assert.equal(selected, null);
    });

    it('returns null when coordinator is empty', () => {
      const coord = new DomainCoordinator();
      const selected = coord.selectPeersForReport(['security']);
      assert.equal(selected, null);
    });

    it('returns null for empty domain tags', () => {
      const coord = new DomainCoordinator();
      const keys = makeKeys();
      coord.register(keys.publicKey, ['security']);

      const selected = coord.selectPeersForReport([]);
      assert.equal(selected, null);
    });
  });

  describe('syncFromDatabase', () => {
    it('populates routing table from subscription signals in DB', () => {
      const coord = new DomainCoordinator();
      const db = makeDb();
      const keys = makeKeys();

      const signal = createSignedSignal({
        ownerPublicKey: keys.publicKey,
        ownerOperatorName: 'test-node',
        tags: ['security', 'performance'],
        intentDescription: 'Test subscription',
        privateKey: keys.privateKey,
      });

      upsertSubscriptionSignal(db, signal, { source: 'local' });

      const result = coord.syncFromDatabase(db);
      assert.equal(result.synced, 1);

      const secPeers = coord.route('security');
      assert.equal(secPeers.length, 1);
      assert.equal(secPeers[0].publicKey, keys.publicKey);
      assert.equal(secPeers[0].operatorName, 'test-node');
    });

    it('handles empty database gracefully', () => {
      const coord = new DomainCoordinator();
      const db = makeDb();

      const result = coord.syncFromDatabase(db);
      assert.equal(result.synced, 0);
    });
  });

  describe('getStats', () => {
    it('returns accurate stats', () => {
      const coord = new DomainCoordinator();
      const keys1 = makeKeys();
      const keys2 = makeKeys();

      coord.register(keys1.publicKey, ['security', 'performance']);
      coord.register(keys2.publicKey, ['security']);

      const stats = coord.getStats();
      assert.equal(stats.domainCount, 2);
      assert.equal(stats.peerCount, 2);
      assert.equal(stats.totalRegistrations, 3); // k1:sec, k1:perf, k2:sec
    });
  });
});
