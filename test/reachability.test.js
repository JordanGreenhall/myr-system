'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  inferNatStatus,
  resolveReachability,
  probeRelay,
  manualFallbackInstructions,
} = require('../lib/reachability');

describe('inferNatStatus', () => {
  it('marks missing node_url as NAT-likely', () => {
    const status = inferNatStatus(null);
    assert.equal(status.behindNatLikely, true);
    assert.equal(status.reason, 'no_public_node_url');
  });

  it('marks localhost node_url as NAT-likely', () => {
    const status = inferNatStatus('http://localhost:3719');
    assert.equal(status.behindNatLikely, true);
    assert.equal(status.reason, 'node_url_is_local_or_private');
  });

  it('marks public node_url as not NAT-likely', () => {
    const status = inferNatStatus('https://node.example.com');
    assert.equal(status.behindNatLikely, false);
    assert.equal(status.reason, 'node_url_public');
  });
});

describe('resolveReachability', () => {
  it('uses direct-public when node_url is public and relay is not configured', () => {
    const result = resolveReachability({
      nodeConfig: {
        node_url: 'https://node.example.com',
      },
      env: {},
    });

    assert.equal(result.method, 'direct-public');
    assert.equal(result.relay, null);
  });

  it('injects bootstrap relay when NAT-likely and no relay is configured', () => {
    const result = resolveReachability({
      nodeConfig: {
        node_url: 'http://localhost:3719',
      },
      env: {
        MYR_BOOTSTRAP_RELAY_URL: 'https://relay.example.test',
      },
    });

    assert.equal(result.method, 'relay');
    assert.equal(result.relay.url, 'https://relay.example.test');
    assert.equal(result.relay.source, 'bootstrap-default');
    assert.equal(result.relay.fallback_only, true);
  });

  it('keeps explicitly configured relay', () => {
    const result = resolveReachability({
      nodeConfig: {
        node_url: 'https://node.example.com',
        relay: {
          enabled: true,
          url: 'https://relay.configured.test',
          fallback_only: false,
        },
      },
      env: {},
    });

    assert.equal(result.method, 'relay');
    assert.equal(result.relay.url, 'https://relay.configured.test');
    assert.equal(result.relay.fallback_only, false);
    assert.equal(result.relay.source, 'configured');
  });
});

describe('probeRelay', () => {
  it('returns ok:true when health probe gets 2xx', async () => {
    const result = await probeRelay({
      relayUrl: 'https://relay.example.test',
      fetchFn: async () => ({ status: 200, body: { status: 'ok' } }),
      timeoutMs: 100,
    });
    assert.equal(result.ok, true);
  });

  it('returns ok:false when relay probe fails', async () => {
    const result = await probeRelay({
      relayUrl: 'https://relay.example.test',
      fetchFn: async () => {
        throw new Error('ECONNREFUSED');
      },
      timeoutMs: 100,
    });
    assert.equal(result.ok, false);
    assert.ok(result.reason.includes('ECONNREFUSED'));
  });
});

describe('manualFallbackInstructions', () => {
  it('includes clear manual steps', () => {
    const text = manualFallbackInstructions({ port: 3719 });
    assert.ok(text.includes('myr setup --public-url'));
    assert.ok(text.includes('3719'));
    assert.ok(text.includes('MYR_BOOTSTRAP_RELAY_URL'));
  });
});
