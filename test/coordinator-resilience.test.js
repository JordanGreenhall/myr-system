'use strict';

const { describe, it } = require('node:test');
const assert = require('assert/strict');
const { DomainCoordinator } = require('../lib/coordinator');

// ── Helpers ─────────────────────────────────────────────────────────────────

function fakePeerKey(index) {
  return index.toString(16).padStart(64, '0');
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('DomainCoordinator — Resilience', () => {
  describe('Peer churn', () => {
    it('maintains routing table integrity through register/unregister cycles', () => {
      const coord = new DomainCoordinator();

      // Phase 1: Register 500 peers across 50 domains
      for (let i = 0; i < 500; i++) {
        const domains = [`domain-${i % 50}`, `domain-${(i + 1) % 50}`];
        coord.register(fakePeerKey(i), domains, { operatorName: `op-${i}` });
      }

      let stats = coord.getStats();
      assert.equal(stats.peerCount, 500);

      // Phase 2: Unregister 200 peers (indices 100-299)
      for (let i = 100; i < 300; i++) {
        const removed = coord.unregister(fakePeerKey(i));
        assert.equal(removed, true);
      }

      stats = coord.getStats();
      assert.equal(stats.peerCount, 300);

      // Phase 3: Register 300 new peers (indices 500-799)
      for (let i = 500; i < 800; i++) {
        const domains = [`domain-${i % 50}`, `domain-${(i + 2) % 50}`];
        coord.register(fakePeerKey(i), domains, { operatorName: `op-${i}` });
      }

      stats = coord.getStats();
      assert.equal(stats.peerCount, 600); // 300 original + 300 new

      // Verify routing integrity: every remaining peer should be routable
      for (let i = 0; i < 100; i++) {
        const domains = coord.getDomainsForPeer(fakePeerKey(i));
        assert.ok(domains.length > 0, `Peer ${i} should still have domains`);
      }
      for (let i = 300; i < 500; i++) {
        const domains = coord.getDomainsForPeer(fakePeerKey(i));
        assert.ok(domains.length > 0, `Peer ${i} should still have domains`);
      }
      for (let i = 500; i < 800; i++) {
        const domains = coord.getDomainsForPeer(fakePeerKey(i));
        assert.ok(domains.length > 0, `New peer ${i} should have domains`);
      }

      // Verify removed peers are truly gone
      for (let i = 100; i < 300; i++) {
        const domains = coord.getDomainsForPeer(fakePeerKey(i));
        assert.equal(domains.length, 0, `Removed peer ${i} should have no domains`);
      }
    });

    it('double-unregister is harmless', () => {
      const coord = new DomainCoordinator();
      coord.register(fakePeerKey(0), ['domain-a']);

      assert.equal(coord.unregister(fakePeerKey(0)), true);
      assert.equal(coord.unregister(fakePeerKey(0)), false); // already gone
      assert.equal(coord.getStats().peerCount, 0);
    });

    it('re-register replaces old domains cleanly', () => {
      const coord = new DomainCoordinator();
      const key = fakePeerKey(0);

      coord.register(key, ['alpha', 'beta', 'gamma']);
      assert.deepEqual(coord.getDomainsForPeer(key), ['alpha', 'beta', 'gamma']);

      coord.register(key, ['delta', 'epsilon']);
      assert.deepEqual(coord.getDomainsForPeer(key), ['delta', 'epsilon']);

      // Old domains should not contain this peer
      assert.equal(coord.route('alpha').length, 0);
      assert.equal(coord.route('beta').length, 0);
      assert.equal(coord.route('gamma').length, 0);

      // New domains should
      assert.equal(coord.route('delta').length, 1);
      assert.equal(coord.route('epsilon').length, 1);
    });
  });

  describe('Domain hot-spots', () => {
    it('handles 50% of peers registering for the same domain', () => {
      const coord = new DomainCoordinator();
      const hotDomain = 'hot-topic';
      const totalPeers = 1000;

      // 500 peers register for the hot domain + one unique domain each
      for (let i = 0; i < 500; i++) {
        coord.register(fakePeerKey(i), [hotDomain, `unique-${i}`]);
      }
      // 500 peers register for other domains only
      for (let i = 500; i < totalPeers; i++) {
        coord.register(fakePeerKey(i), [`other-${i % 50}`, `unique-${i}`]);
      }

      const stats = coord.getStats();
      assert.equal(stats.peerCount, totalPeers);

      // Route for hot domain returns exactly 500 peers
      const hotPeers = coord.route(hotDomain);
      assert.equal(hotPeers.length, 500);

      // Verify all hot peers are distinct
      const hotKeys = new Set(hotPeers.map(p => p.publicKey));
      assert.equal(hotKeys.size, 500);

      // routeMultiple still deduplicates correctly with hot domain
      const multi = coord.routeMultiple([hotDomain, 'unique-0']);
      const multiKeys = new Set(multi.map(p => p.publicKey));
      // Should include peer-0 (both domains) but not double-count
      assert.ok(multiKeys.has(fakePeerKey(0)));
      assert.equal(multi.filter(p => p.publicKey === fakePeerKey(0)).length, 1);
    });

    it('listDomains ranks hot domain first', () => {
      const coord = new DomainCoordinator();

      // 100 peers on "popular", 10 peers on "niche"
      for (let i = 0; i < 100; i++) {
        coord.register(fakePeerKey(i), ['popular']);
      }
      for (let i = 100; i < 110; i++) {
        coord.register(fakePeerKey(i), ['niche']);
      }

      const domains = coord.listDomains();
      assert.equal(domains[0].domain, 'popular');
      assert.equal(domains[0].peerCount, 100);
      assert.equal(domains[1].domain, 'niche');
      assert.equal(domains[1].peerCount, 10);
    });
  });

  describe('Stale registration cleanup', () => {
    it('unregister handles peers that disappeared without cleanup', () => {
      const coord = new DomainCoordinator();

      // Simulate 100 peers registering
      for (let i = 0; i < 100; i++) {
        coord.register(fakePeerKey(i), [`domain-${i % 10}`]);
      }
      assert.equal(coord.getStats().peerCount, 100);

      // Simulate operator "cleaning up" stale peers (e.g., peers that
      // stopped heartbeating — the coordinator would call unregister)
      const stalePeers = [];
      for (let i = 0; i < 30; i++) {
        stalePeers.push(fakePeerKey(i));
      }

      for (const key of stalePeers) {
        coord.unregister(key);
      }

      assert.equal(coord.getStats().peerCount, 70);

      // Verify stale peers are gone from all routes
      for (const key of stalePeers) {
        assert.deepEqual(coord.getDomainsForPeer(key), []);
      }

      // Verify remaining peers still route correctly
      for (let i = 30; i < 100; i++) {
        const domains = coord.getDomainsForPeer(fakePeerKey(i));
        assert.ok(domains.length > 0, `Peer ${i} should still have domains`);
      }
    });

    it('routing table has no orphaned domains after stale cleanup', () => {
      const coord = new DomainCoordinator();

      // Register 5 peers all on "ephemeral-domain"
      for (let i = 0; i < 5; i++) {
        coord.register(fakePeerKey(i), ['ephemeral-domain']);
      }
      assert.equal(coord.route('ephemeral-domain').length, 5);

      // All 5 go stale and are cleaned up
      for (let i = 0; i < 5; i++) {
        coord.unregister(fakePeerKey(i));
      }

      // Domain should be completely removed from routing table
      assert.deepEqual(coord.route('ephemeral-domain'), []);
      const domains = coord.listDomains();
      const orphan = domains.find(d => d.domain === 'ephemeral-domain');
      assert.equal(orphan, undefined, 'ephemeral-domain should not linger in routing table');
    });

    it('bulk cleanup does not corrupt other peers registrations', () => {
      const coord = new DomainCoordinator();

      // 50 peers share "shared-domain", 25 of them also have "exclusive-a"
      for (let i = 0; i < 50; i++) {
        const domains = ['shared-domain'];
        if (i < 25) domains.push('exclusive-a');
        coord.register(fakePeerKey(i), domains);
      }

      // Clean up peers 0-24 (the ones with exclusive-a)
      for (let i = 0; i < 25; i++) {
        coord.unregister(fakePeerKey(i));
      }

      // shared-domain should still have 25 peers
      assert.equal(coord.route('shared-domain').length, 25);
      // exclusive-a should be completely empty
      assert.equal(coord.route('exclusive-a').length, 0);
      // No orphaned domain entries
      const domainList = coord.listDomains();
      assert.equal(domainList.length, 1);
      assert.equal(domainList[0].domain, 'shared-domain');
    });
  });
});
