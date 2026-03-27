'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

const {
  TOPIC_NAME,
  topicKey,
  createAnnouncement,
  verifyAnnouncement,
  discoverPeers,
  announceOnDHT,
  startBackgroundAnnounce,
} = require('../lib/dht');
const { generateKeypair, fingerprint: computeFingerprint } = require('../lib/crypto');

// ── Mock Hyperswarm ──────────────────────────────────────────────────────────

class MockSwarm extends EventEmitter {
  constructor() {
    super();
    this._destroyed = false;
    this._joins = [];
  }

  join(topic, opts) {
    const entry = { topic, opts };
    this._joins.push(entry);
    return {
      flushed: () => Promise.resolve(),
      destroy: () => Promise.resolve(),
    };
  }

  destroy() {
    this._destroyed = true;
    return Promise.resolve();
  }

  // Test helper: simulate an incoming connection that sends data then ends
  simulateConnection(data) {
    const conn = new PassThrough();
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(
      typeof data === 'string' ? data : JSON.stringify(data)
    );
    process.nextTick(() => {
      this.emit('connection', conn);
      process.nextTick(() => {
        conn.write(raw);
        conn.end();
      });
    });
    return conn;
  }
}

function MockHyperswarm() {
  return new MockSwarm();
}

// ── Keypair helpers ──────────────────────────────────────────────────────────

function makeKeys() {
  return generateKeypair();
}

function makeIdentityDoc(keys, url = 'https://test.example.com') {
  return {
    protocol_version: '1.0.0',
    node_url: url,
    operator_name: 'test-operator',
    public_key: keys.publicKey,
    fingerprint: computeFingerprint(keys.publicKey),
    capabilities: ['report-sync'],
  };
}

// ── topicKey ─────────────────────────────────────────────────────────────────

describe('topicKey', () => {
  it('returns a 32-byte Buffer', () => {
    const key = topicKey();
    assert.ok(Buffer.isBuffer(key));
    assert.equal(key.length, 32);
  });

  it('is deterministic', () => {
    assert.deepEqual(topicKey(), topicKey());
  });

  it('is derived from TOPIC_NAME', () => {
    const nodeCrypto = require('crypto');
    const expected = nodeCrypto.createHash('sha256').update(TOPIC_NAME).digest();
    assert.deepEqual(topicKey(), expected);
  });
});

// ── createAnnouncement ───────────────────────────────────────────────────────

describe('createAnnouncement', () => {
  it('creates a payload with announced_at timestamp', () => {
    const keys = makeKeys();
    const identity = makeIdentityDoc(keys);
    const { payload } = createAnnouncement(identity, keys.privateKey);
    assert.ok(payload.announced_at);
    assert.ok(new Date(payload.announced_at).getTime() > 0);
  });

  it('includes the original identity fields', () => {
    const keys = makeKeys();
    const identity = makeIdentityDoc(keys);
    const { payload } = createAnnouncement(identity, keys.privateKey);
    assert.equal(payload.operator_name, identity.operator_name);
    assert.equal(payload.public_key, identity.public_key);
    assert.equal(payload.node_url, identity.node_url);
  });

  it('produces a hex signature', () => {
    const keys = makeKeys();
    const identity = makeIdentityDoc(keys);
    const { signature } = createAnnouncement(identity, keys.privateKey);
    assert.ok(typeof signature === 'string');
    assert.ok(signature.length > 0);
    assert.ok(/^[0-9a-f]+$/.test(signature));
  });
});

// ── verifyAnnouncement ───────────────────────────────────────────────────────

describe('verifyAnnouncement', () => {
  it('returns true for a valid announcement', () => {
    const keys = makeKeys();
    const identity = makeIdentityDoc(keys);
    const ann = createAnnouncement(identity, keys.privateKey);
    assert.equal(verifyAnnouncement(ann), true);
  });

  it('returns false for tampered payload (changed operator_name)', () => {
    const keys = makeKeys();
    const identity = makeIdentityDoc(keys);
    const ann = createAnnouncement(identity, keys.privateKey);
    const tampered = { ...ann, payload: { ...ann.payload, operator_name: 'evil' } };
    assert.equal(verifyAnnouncement(tampered), false);
  });

  it('returns false for wrong signature', () => {
    const keys = makeKeys();
    const other = makeKeys();
    const identity = makeIdentityDoc(keys);
    const ann = createAnnouncement(identity, keys.privateKey);
    // Replace signature with one from a different key
    const otherAnn = createAnnouncement(identity, other.privateKey);
    const wrongSig = { ...ann, signature: otherAnn.signature };
    assert.equal(verifyAnnouncement(wrongSig), false);
  });

  it('returns false when signature is missing', () => {
    const keys = makeKeys();
    const identity = makeIdentityDoc(keys);
    const ann = createAnnouncement(identity, keys.privateKey);
    assert.equal(verifyAnnouncement({ payload: ann.payload }), false);
  });

  it('returns false when payload is missing', () => {
    const keys = makeKeys();
    const identity = makeIdentityDoc(keys);
    const ann = createAnnouncement(identity, keys.privateKey);
    assert.equal(verifyAnnouncement({ signature: ann.signature }), false);
  });

  it('returns false when public_key is missing from payload', () => {
    const keys = makeKeys();
    const identity = makeIdentityDoc(keys);
    const ann = createAnnouncement(identity, keys.privateKey);
    const noPk = { ...ann, payload: { ...ann.payload } };
    delete noPk.payload.public_key;
    assert.equal(verifyAnnouncement(noPk), false);
  });

  it('returns false for completely invalid data', () => {
    assert.equal(verifyAnnouncement({}), false);
    assert.equal(verifyAnnouncement({ payload: null, signature: 'abc' }), false);
    assert.equal(verifyAnnouncement(), false);
  });
});

// ── discoverPeers ─────────────────────────────────────────────────────────────

describe('discoverPeers', () => {
  it('returns empty array when no peers found within timeout', async () => {
    const swarm = new MockSwarm();
    function MockH() { return swarm; }

    const discovered = await discoverPeers({ timeoutMs: 50, _Hyperswarm: MockH });
    assert.deepEqual(discovered, []);
    assert.equal(swarm._destroyed, true);
  });

  it('discovers valid announcements', async () => {
    const keys = makeKeys();
    const identity = makeIdentityDoc(keys);
    const ann = createAnnouncement(identity, keys.privateKey);

    let swarmInst;
    const MockH = function() {
      swarmInst = new MockSwarm();
      return swarmInst;
    };

    const peerCb = [];
    const discoverPromise = discoverPeers({
      timeoutMs: 200,
      onPeer: (p) => peerCb.push(p),
      _Hyperswarm: MockH,
    });

    // Give the discovery time to set up, then simulate a peer
    await new Promise(r => setTimeout(r, 20));
    swarmInst.simulateConnection(ann);

    const discovered = await discoverPromise;
    assert.equal(discovered.length, 1);
    assert.equal(discovered[0].operator_name, identity.operator_name);
    assert.equal(discovered[0].public_key, keys.publicKey);
    assert.equal(peerCb.length, 1);
  });

  it('discards unsigned announcements', async () => {
    let swarmInst;
    const MockH = function() {
      swarmInst = new MockSwarm();
      return swarmInst;
    };

    const invalid = [];
    const discoverPromise = discoverPeers({
      timeoutMs: 200,
      onInvalid: (msg) => invalid.push(msg),
      _Hyperswarm: MockH,
    });

    await new Promise(r => setTimeout(r, 20));
    // Send announcement without a signature
    swarmInst.simulateConnection({ payload: { public_key: 'abc', operator_name: 'evil' } });

    const discovered = await discoverPromise;
    assert.equal(discovered.length, 0);
    assert.equal(invalid.length, 1);
  });

  it('discards tampered announcements (invalid signature)', async () => {
    const keys = makeKeys();
    const identity = makeIdentityDoc(keys);
    const ann = createAnnouncement(identity, keys.privateKey);
    const tampered = { ...ann, payload: { ...ann.payload, operator_name: 'attacker' } };

    let swarmInst;
    const MockH = function() {
      swarmInst = new MockSwarm();
      return swarmInst;
    };

    const invalid = [];
    const discoverPromise = discoverPeers({
      timeoutMs: 200,
      onInvalid: (msg) => invalid.push(msg),
      _Hyperswarm: MockH,
    });

    await new Promise(r => setTimeout(r, 20));
    swarmInst.simulateConnection(tampered);

    const discovered = await discoverPromise;
    assert.equal(discovered.length, 0);
    assert.equal(invalid.length, 1);
  });

  it('discards malformed (non-JSON) data', async () => {
    let swarmInst;
    const MockH = function() {
      swarmInst = new MockSwarm();
      return swarmInst;
    };

    const discoverPromise = discoverPeers({ timeoutMs: 200, _Hyperswarm: MockH });

    await new Promise(r => setTimeout(r, 20));
    swarmInst.simulateConnection(Buffer.from('not-json-at-all!!'));

    const discovered = await discoverPromise;
    assert.equal(discovered.length, 0);
  });

  it('joins topic with client:true, server:false', async () => {
    let swarmInst;
    const MockH = function() {
      swarmInst = new MockSwarm();
      return swarmInst;
    };

    const discoverPromise = discoverPeers({ timeoutMs: 50, _Hyperswarm: MockH });
    await new Promise(r => setTimeout(r, 10));

    assert.equal(swarmInst._joins.length, 1);
    assert.equal(swarmInst._joins[0].opts.client, true);
    assert.equal(swarmInst._joins[0].opts.server, false);

    await discoverPromise;
  });

  it('calls onPeer for each valid discovery', async () => {
    const keys1 = makeKeys();
    const keys2 = makeKeys();

    let swarmInst;
    const MockH = function() {
      swarmInst = new MockSwarm();
      return swarmInst;
    };

    const found = [];
    const discoverPromise = discoverPeers({
      timeoutMs: 300,
      onPeer: (p) => found.push(p),
      _Hyperswarm: MockH,
    });

    await new Promise(r => setTimeout(r, 20));

    const ann1 = createAnnouncement(makeIdentityDoc(keys1, 'https://node1.example.com'), keys1.privateKey);
    const ann2 = createAnnouncement(makeIdentityDoc(keys2, 'https://node2.example.com'), keys2.privateKey);
    swarmInst.simulateConnection(ann1);

    await new Promise(r => setTimeout(r, 20));
    swarmInst.simulateConnection(ann2);

    const discovered = await discoverPromise;
    assert.equal(discovered.length, 2);
    assert.equal(found.length, 2);
  });
});

// ── announceOnDHT ─────────────────────────────────────────────────────────────

describe('announceOnDHT', () => {
  it('creates a swarm and announces on the topic', async () => {
    const keys = makeKeys();
    const identity = makeIdentityDoc(keys);
    let swarmInst;
    const MockH = function() {
      swarmInst = new MockSwarm();
      return swarmInst;
    };

    const { swarm, announcement } = await announceOnDHT({
      identityDocument: identity,
      privateKey: keys.privateKey,
      _Hyperswarm: MockH,
    });

    assert.ok(swarm);
    assert.ok(announcement.payload);
    assert.ok(announcement.signature);
    assert.equal(swarmInst._joins.length, 1);
    assert.equal(swarmInst._joins[0].opts.server, true);
    assert.equal(swarmInst._joins[0].opts.client, false);

    await swarm.destroy();
  });

  it('sends identity document to connecting peers', async () => {
    const keys = makeKeys();
    const identity = makeIdentityDoc(keys);
    let swarmInst;
    const MockH = function() {
      swarmInst = new MockSwarm();
      return swarmInst;
    };

    await announceOnDHT({
      identityDocument: identity,
      privateKey: keys.privateKey,
      _Hyperswarm: MockH,
    });

    // Simulate a peer connecting to the announcer
    const received = [];
    const conn = new PassThrough();
    conn.on('data', chunk => received.push(chunk));
    conn.on('end', () => {
      const msg = JSON.parse(Buffer.concat(received).toString());
      assert.ok(msg.payload);
      assert.ok(msg.signature);
      assert.equal(msg.payload.public_key, keys.publicKey);
    });
    swarmInst.emit('connection', conn);

    // Give it time to write
    await new Promise(r => setTimeout(r, 20));
    await swarmInst.destroy();
  });
});

// ── startBackgroundAnnounce ───────────────────────────────────────────────────

describe('startBackgroundAnnounce', () => {
  it('starts and can be stopped', async () => {
    const keys = makeKeys();
    const identity = makeIdentityDoc(keys);
    let callCount = 0;
    const MockH = function() {
      callCount++;
      return new MockSwarm();
    };

    const handle = startBackgroundAnnounce({
      identityDocument: identity,
      privateKey: keys.privateKey,
      intervalMs: 50000, // long interval so only fires once
      _Hyperswarm: MockH,
    });

    // Wait for initial announce
    await new Promise(r => setTimeout(r, 50));
    assert.ok(callCount >= 1, 'Should have announced at least once');

    await handle.stop();
    const countAfterStop = callCount;

    // Should not fire after stop
    await new Promise(r => setTimeout(r, 100));
    assert.equal(callCount, countAfterStop, 'Should not announce after stop()');
  });

  it('re-announces at the configured interval', async () => {
    const keys = makeKeys();
    const identity = makeIdentityDoc(keys);
    let callCount = 0;
    const MockH = function() {
      callCount++;
      return new MockSwarm();
    };

    const handle = startBackgroundAnnounce({
      identityDocument: identity,
      privateKey: keys.privateKey,
      intervalMs: 60, // short interval for test
      _Hyperswarm: MockH,
    });

    await new Promise(r => setTimeout(r, 250));
    await handle.stop();

    // Should have fired multiple times (initial + at least 1 interval)
    assert.ok(callCount >= 2, `Expected >= 2 announces, got ${callCount}`);
  });

  it('calls onError when hyperswarm throws', async () => {
    const keys = makeKeys();
    const identity = makeIdentityDoc(keys);
    const errors = [];
    const MockH = function() {
      const s = new MockSwarm();
      s.join = () => ({ flushed: () => Promise.reject(new Error('DHT unavailable')) });
      return s;
    };

    const handle = startBackgroundAnnounce({
      identityDocument: identity,
      privateKey: keys.privateKey,
      intervalMs: 50000,
      onError: (err) => errors.push(err),
      _Hyperswarm: MockH,
    });

    await new Promise(r => setTimeout(r, 50));
    await handle.stop();

    assert.ok(errors.length >= 1);
    assert.ok(errors[0].message.includes('DHT unavailable'));
  });
});

// ── TOPIC_NAME constant ───────────────────────────────────────────────────────

describe('TOPIC_NAME', () => {
  it('equals myr-network-v1', () => {
    assert.equal(TOPIC_NAME, 'myr-network-v1');
  });
});
