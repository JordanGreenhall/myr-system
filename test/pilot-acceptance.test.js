'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

describe('pilot-acceptance', () => {
  const pilotPacketDir = path.join(ROOT, 'docs', 'pilot-packet');
  const pilotScriptsDir = path.join(ROOT, 'scripts', 'pilot');

  const requiredDocs = [
    'README.md',
    'checklist-operator-setup.md',
    'checklist-cohort-onboarding.md',
    'incident-response-card.md',
    'measurement-loop.md',
    'support-roles.md',
  ];

  const requiredScripts = [
    'verify-node-health.sh',
    'verify-cohort-status.sh',
    'onboard-new-peer.sh',
  ];

  describe('pilot-packet docs exist and are non-empty', () => {
    for (const doc of requiredDocs) {
      it(`docs/pilot-packet/${doc} exists and is non-empty`, () => {
        const filePath = path.join(pilotPacketDir, doc);
        assert.ok(fs.existsSync(filePath), `${doc} does not exist`);
        const stat = fs.statSync(filePath);
        assert.ok(stat.size > 100, `${doc} is too small (${stat.size} bytes)`);
      });
    }
  });

  describe('automation scripts exist and are executable', () => {
    for (const script of requiredScripts) {
      it(`scripts/pilot/${script} exists and is executable`, () => {
        const filePath = path.join(pilotScriptsDir, script);
        assert.ok(fs.existsSync(filePath), `${script} does not exist`);
        const stat = fs.statSync(filePath);
        assert.ok(stat.size > 100, `${script} is too small (${stat.size} bytes)`);
        // Check executable bit (owner execute = 0o100)
        const mode = stat.mode;
        assert.ok((mode & 0o111) !== 0, `${script} is not executable (mode: ${mode.toString(8)})`);
      });
    }
  });

  describe('checklist references valid endpoints', () => {
    const serverPath = path.join(ROOT, 'server', 'index.js');
    let serverSource;

    it('server/index.js exists', () => {
      assert.ok(fs.existsSync(serverPath), 'server/index.js not found');
      serverSource = fs.readFileSync(serverPath, 'utf8');
    });

    const endpointsReferencedInChecklists = [
      '/myr/health',
      '/myr/health/node',
      '/myr/health/network',
      '/myr/metrics',
      '/.well-known/myr-node',
      '/myr/peer/introduce',
      '/myr/governance/audit',
      '/myr/governance/revoke',
      '/myr/governance/quarantine',
      '/myr/governance/key-rotate',
      '/myr/participation/evaluate',
      '/myr/subscriptions',
      '/myr/contradictions',
    ];

    for (const endpoint of endpointsReferencedInChecklists) {
      it(`endpoint ${endpoint} exists in server`, () => {
        assert.ok(serverSource, 'server source not loaded');
        // Normalize: the server registers routes with quotes
        const routePattern = endpoint.replace(/\//g, '/');
        assert.ok(
          serverSource.includes(routePattern),
          `endpoint ${endpoint} not found in server/index.js`
        );
      });
    }
  });

  describe('checklist references valid scripts', () => {
    const scriptsReferencedInChecklists = [
      'scripts/myr-keygen.js',
      'scripts/myr-store.js',
      'scripts/myr-search.js',
      'scripts/myr-verify.js',
      'scripts/myr-export.js',
      'scripts/slo-check.js',
    ];

    for (const script of scriptsReferencedInChecklists) {
      it(`${script} exists`, () => {
        const filePath = path.join(ROOT, script);
        assert.ok(fs.existsSync(filePath), `${script} not found`);
      });
    }
  });

  describe('checklist references valid CLI commands', () => {
    const cliPath = path.join(ROOT, 'bin', 'myr.js');
    let cliSource;

    it('bin/myr.js exists', () => {
      assert.ok(fs.existsSync(cliPath), 'bin/myr.js not found');
      cliSource = fs.readFileSync(cliPath, 'utf8');
    });

    const cliCommandsReferenced = [
      'peer',
      'sync',
      'start',
      'setup',
      'join',
      'invite',
    ];

    for (const cmd of cliCommandsReferenced) {
      it(`CLI command '${cmd}' is registered`, () => {
        assert.ok(cliSource, 'CLI source not loaded');
        assert.ok(
          cliSource.includes(cmd),
          `CLI command '${cmd}' not found in bin/myr.js`
        );
      });
    }
  });
});
