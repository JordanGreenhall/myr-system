'use strict';

const { describe, it } = require('node:test');
const assert = require('assert/strict');
const { DomainCoordinator } = require('../lib/coordinator');

// ── Helpers ─────────────────────────────────────────────────────────────────

function fakePeerKey(index) {
  // Deterministic 64-char hex string (simulates ed25519 public key)
  return index.toString(16).padStart(64, '0');
}

function generateDomains(count) {
  const domains = [];
  for (let i = 0; i < count; i++) {
    domains.push(`domain-${i}`);
  }
  return domains;
}

function registerPeersAcrossDomains(coord, peerCount, domainCount) {
  const domains = generateDomains(domainCount);
  for (let i = 0; i < peerCount; i++) {
    // Each peer registers for 3-5 domains (round-robin selection)
    const peerDomains = [];
    const domainsPerPeer = 3 + (i % 3); // 3, 4, or 5
    for (let d = 0; d < domainsPerPeer; d++) {
      peerDomains.push(domains[(i + d) % domainCount]);
    }
    coord.register(fakePeerKey(i), peerDomains, {
      operatorName: `operator-${i}`,
      peerUrl: `ws://peer-${i}.example.com`,
    });
  }
  return domains;
}

function measureTime(fn) {
  const start = process.hrtime.bigint();
  const result = fn();
  const elapsed = Number(process.hrtime.bigint() - start) / 1e6; // ms
  return { result, elapsed };
}

function measureMemoryDelta(fn) {
  global.gc && global.gc(); // hint only — won't run unless --expose-gc
  const before = process.memoryUsage().heapUsed;
  fn();
  const after = process.memoryUsage().heapUsed;
  return after - before;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('DomainCoordinator — Load Validation', () => {
  describe('Registration throughput', () => {
    it('registers 1,000 peers across 100 domains under 500ms', () => {
      const coord = new DomainCoordinator();
      const { elapsed } = measureTime(() => {
        registerPeersAcrossDomains(coord, 1000, 100);
      });

      const stats = coord.getStats();
      assert.equal(stats.peerCount, 1000);
      assert.ok(stats.domainCount <= 100);
      assert.ok(elapsed < 500, `Registration took ${elapsed.toFixed(1)}ms, expected < 500ms`);
    });

    it('registers 10,000 peers across 200 domains under 5000ms', () => {
      const coord = new DomainCoordinator();
      const { elapsed } = measureTime(() => {
        registerPeersAcrossDomains(coord, 10000, 200);
      });

      const stats = coord.getStats();
      assert.equal(stats.peerCount, 10000);
      assert.ok(elapsed < 5000, `Registration took ${elapsed.toFixed(1)}ms, expected < 5000ms`);
    });
  });

  describe('route() latency at scale', () => {
    it('route() < 10ms at 1,000 registrations', () => {
      const coord = new DomainCoordinator();
      const domains = registerPeersAcrossDomains(coord, 1000, 100);

      // Warm up
      coord.route(domains[0]);

      // Measure 100 route() calls
      const { elapsed } = measureTime(() => {
        for (let i = 0; i < 100; i++) {
          coord.route(domains[i % domains.length]);
        }
      });

      const avgMs = elapsed / 100;
      assert.ok(avgMs < 10, `route() avg ${avgMs.toFixed(3)}ms, expected < 10ms`);
    });

    it('route() < 10ms at 10,000 registrations', () => {
      const coord = new DomainCoordinator();
      const domains = registerPeersAcrossDomains(coord, 10000, 200);

      // Warm up
      coord.route(domains[0]);

      // Measure 200 route() calls
      const { elapsed } = measureTime(() => {
        for (let i = 0; i < 200; i++) {
          coord.route(domains[i % domains.length]);
        }
      });

      const avgMs = elapsed / 200;
      assert.ok(avgMs < 10, `route() avg ${avgMs.toFixed(3)}ms at 10k peers, expected < 10ms`);
    });
  });

  describe('routeMultiple() latency at scale', () => {
    it('routeMultiple() < 50ms for 10-domain query at 1,000 registrations', () => {
      const coord = new DomainCoordinator();
      const domains = registerPeersAcrossDomains(coord, 1000, 100);

      // Query 10 domains at a time
      const queryDomains = domains.slice(0, 10);

      // Warm up
      coord.routeMultiple(queryDomains);

      const { elapsed } = measureTime(() => {
        for (let i = 0; i < 50; i++) {
          const offset = i % (domains.length - 10);
          coord.routeMultiple(domains.slice(offset, offset + 10));
        }
      });

      const avgMs = elapsed / 50;
      assert.ok(avgMs < 50, `routeMultiple() avg ${avgMs.toFixed(3)}ms, expected < 50ms`);
    });

    it('routeMultiple() < 50ms for 10-domain query at 10,000 registrations', () => {
      const coord = new DomainCoordinator();
      const domains = registerPeersAcrossDomains(coord, 10000, 200);

      const queryDomains = domains.slice(0, 10);

      // Warm up
      coord.routeMultiple(queryDomains);

      const { elapsed } = measureTime(() => {
        for (let i = 0; i < 50; i++) {
          const offset = i % (domains.length - 10);
          coord.routeMultiple(domains.slice(offset, offset + 10));
        }
      });

      const avgMs = elapsed / 50;
      assert.ok(avgMs < 50, `routeMultiple() avg ${avgMs.toFixed(3)}ms at 10k peers, expected < 50ms`);
    });
  });

  describe('Memory footprint at scale', () => {
    it('measures memory at 1,000 / 5,000 / 10,000 registrations', () => {
      const tiers = [1000, 5000, 10000];
      const results = [];

      for (const count of tiers) {
        const coord = new DomainCoordinator();
        const memDelta = measureMemoryDelta(() => {
          registerPeersAcrossDomains(coord, count, Math.min(count / 5, 200));
        });

        const stats = coord.getStats();
        const bytesPerPeer = memDelta / count;

        results.push({
          peers: count,
          domains: stats.domainCount,
          totalRegistrations: stats.totalRegistrations,
          heapDeltaBytes: memDelta,
          bytesPerPeer: Math.round(bytesPerPeer),
        });
      }

      // Log for the economics artifact
      for (const r of results) {
        const mb = (r.heapDeltaBytes / (1024 * 1024)).toFixed(2);
        console.log(
          `  ${r.peers} peers, ${r.domains} domains: ~${mb} MB heap (${r.bytesPerPeer} bytes/peer)`
        );
      }

      // Sanity: 10,000 peers should use less than 200 MB
      const last = results[results.length - 1];
      assert.ok(
        last.heapDeltaBytes < 200 * 1024 * 1024,
        `10k peers used ${(last.heapDeltaBytes / (1024 * 1024)).toFixed(1)} MB, expected < 200 MB`
      );
    });
  });

  describe('selectPeersForReport at scale', () => {
    it('selectPeersForReport returns correct results at 10,000 peers', () => {
      const coord = new DomainCoordinator();
      registerPeersAcrossDomains(coord, 10000, 200);

      const { result, elapsed } = measureTime(() => {
        return coord.selectPeersForReport(['domain-0', 'domain-1']);
      });

      assert.ok(Array.isArray(result));
      assert.ok(result.length > 0, 'should find peers for common domains');
      assert.ok(elapsed < 50, `selectPeersForReport took ${elapsed.toFixed(1)}ms, expected < 50ms`);
    });
  });

  describe('getStats at scale', () => {
    it('getStats is accurate at 10,000 peers', () => {
      const coord = new DomainCoordinator();
      registerPeersAcrossDomains(coord, 10000, 200);

      const stats = coord.getStats();
      assert.equal(stats.peerCount, 10000);
      assert.ok(stats.domainCount > 0 && stats.domainCount <= 200);
      assert.ok(stats.totalRegistrations >= 10000); // each peer has 3-5 domains
      assert.ok(stats.totalRegistrations <= 50000);
    });
  });
});
