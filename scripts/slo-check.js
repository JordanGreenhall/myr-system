'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const { httpFetch, makeSignedHeaders } = require('../lib/sync');

function parseArgs(argv) {
  const args = {
    url: 'http://localhost:3719',
    fanout: 5,
    auth: true,
    json: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--url') {
      args.url = argv[++i];
    } else if (token === '--fanout') {
      args.fanout = Number(argv[++i]);
    } else if (token === '--node-id') {
      args.nodeId = argv[++i];
    } else if (token === '--keys-path') {
      args.keysPath = argv[++i];
    } else if (token === '--public-key') {
      args.publicKey = argv[++i];
    } else if (token === '--private-key') {
      args.privateKey = argv[++i];
    } else if (token === '--no-auth') {
      args.auth = false;
    } else if (token === '--json') {
      args.json = true;
    } else if (token === '--help' || token === '-h') {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }

  return args;
}

function toKeyHexFromPemFile(pemPath, type) {
  const pem = fs.readFileSync(pemPath, 'utf8');
  if (type === 'public') {
    const der = crypto.createPublicKey(pem).export({ type: 'spki', format: 'der' });
    return der.slice(-32).toString('hex');
  }
  const der = crypto.createPrivateKey(pem).export({ type: 'pkcs8', format: 'der' });
  return der.slice(-32).toString('hex');
}

function resolveAuth(args) {
  if (!args.auth) return null;

  if (args.publicKey && args.privateKey) {
    return { publicKey: args.publicKey, privateKey: args.privateKey };
  }

  const nodeId = args.nodeId || config.node_id;
  const keysPath = path.resolve(args.keysPath || config.keys_path);

  if (!nodeId) {
    throw new Error('Cannot resolve auth keys: missing node id. Set --node-id or config.node_id, or pass --no-auth.');
  }

  const publicPem = path.join(keysPath, `${nodeId}.public.pem`);
  const privatePem = path.join(keysPath, `${nodeId}.private.pem`);

  if (!fs.existsSync(publicPem) || !fs.existsSync(privatePem)) {
    throw new Error(`Cannot resolve auth keys: missing ${publicPem} or ${privatePem}.`);
  }

  return {
    publicKey: toKeyHexFromPemFile(publicPem, 'public'),
    privateKey: toKeyHexFromPemFile(privatePem, 'private'),
  };
}

function evaluateSlo({ metrics, healthStatus, fanout }) {
  const now = new Date().toISOString();

  const syncLag = metrics?.sync?.sync_lag_seconds;
  const activeView = metrics?.gossip?.active_view_size;
  const fMinusOne = Math.max((Number.isFinite(fanout) ? fanout : 5) - 1, 0);
  const governanceP99 = metrics?.slo_governance_propagation_p99_seconds ?? metrics?.slo?.governance_propagation_p99_seconds;
  const onboardingCompliancePct = metrics?.onboarding?.compliant_pct;
  const uptimePct = metrics?.slo_uptime_pct ?? metrics?.slo?.uptime_pct;

  const results = [
    {
      id: 'sync_freshness',
      target: '95% checks have sync_lag_seconds <= 60',
      metric: 'sync.sync_lag_seconds',
      observed: syncLag,
      status: Number.isFinite(syncLag) ? (syncLag <= 60 ? 'pass' : 'fail') : 'not_evaluable',
      reason: Number.isFinite(syncLag)
        ? `Current lag=${syncLag}s`
        : 'Metric missing from /myr/metrics',
    },
    {
      id: 'gossip_health',
      target: '99% checks have active_view_size >= F-1',
      metric: 'gossip.active_view_size',
      observed: activeView,
      status: Number.isFinite(activeView) ? (activeView >= fMinusOne ? 'pass' : 'fail') : 'not_evaluable',
      reason: Number.isFinite(activeView)
        ? `Current active view=${activeView}, threshold=${fMinusOne}`
        : 'Metric missing from /myr/metrics',
    },
    {
      id: 'governance_propagation',
      target: '99th percentile revocation propagation <= 120s',
      metric: 'slo_governance_propagation_p99_seconds',
      observed: governanceP99,
      status: Number.isFinite(governanceP99) ? (governanceP99 <= 120 ? 'pass' : 'fail') : 'not_evaluable',
      reason: Number.isFinite(governanceP99)
        ? `Observed p99=${governanceP99}s`
        : 'No governance propagation sample yet',
    },
    {
      id: 'onboarding_success',
      target: '>=95% myr join attempts succeed within 60s',
      metric: 'onboarding.compliant_pct',
      observed: onboardingCompliancePct,
      status: Number.isFinite(onboardingCompliancePct) ? (onboardingCompliancePct >= 95 ? 'pass' : 'fail') : 'not_evaluable',
      reason: Number.isFinite(onboardingCompliancePct)
        ? `Observed compliant_pct=${onboardingCompliancePct}%`
        : 'No onboarding attempts recorded yet',
    },
    {
      id: 'uptime',
      target: '/myr/health returns 200 for >=99.5% checks',
      metric: 'slo_uptime_pct + /myr/health status',
      observed: uptimePct ?? healthStatus,
      status: Number.isFinite(uptimePct)
        ? (uptimePct >= 99.5 && healthStatus === 200 ? 'pass' : 'fail')
        : (healthStatus === 200 ? 'pass' : 'fail'),
      reason: Number.isFinite(uptimePct)
        ? `Current uptime=${uptimePct}%, /myr/health status=${healthStatus}`
        : `Current /myr/health status=${healthStatus}`,
    },
  ];

  const summary = {
    checked_at: now,
    pass: results.filter((r) => r.status === 'pass').length,
    fail: results.filter((r) => r.status === 'fail').length,
    not_evaluable: results.filter((r) => r.status === 'not_evaluable').length,
  };

  return { summary, results };
}

function printHuman(report) {
  console.log('');
  console.log('MYR SLO Compliance Check');
  console.log('========================');
  console.log(`Checked at: ${report.summary.checked_at}`);
  console.log('');
  for (const r of report.results) {
    console.log(`- ${r.id}: ${r.status.toUpperCase()}`);
    console.log(`  target: ${r.target}`);
    console.log(`  metric: ${r.metric}`);
    console.log(`  observed: ${r.observed === null ? 'n/a' : r.observed}`);
    console.log(`  reason: ${r.reason}`);
  }
  console.log('');
  console.log(
    `Summary: pass=${report.summary.pass}, fail=${report.summary.fail}, not_evaluable=${report.summary.not_evaluable}`
  );
  console.log('');
}

function printHelp() {
  console.log('Usage: node scripts/slo-check.js [options]');
  console.log('');
  console.log('Options:');
  console.log('  --url <base-url>          Base node URL (default: http://localhost:3719)');
  console.log('  --fanout <n>              Gossip fanout (default: 5; used for F-1 threshold)');
  console.log('  --node-id <id>            Node ID for key lookup');
  console.log('  --keys-path <path>        Keys directory for PEM lookup');
  console.log('  --public-key <hex>        Explicit Ed25519 public key (hex)');
  console.log('  --private-key <hex>       Explicit Ed25519 private key (hex)');
  console.log('  --no-auth                 Skip signed auth headers for /myr/metrics');
  console.log('  --json                    Print JSON output');
  console.log('  -h, --help                Show this help');
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }

  const baseUrl = args.url.replace(/\/+$/, '');
  const auth = resolveAuth(args);

  const metricsPath = '/myr/metrics';
  const metricsHeaders = auth
    ? makeSignedHeaders({
      method: 'GET',
      urlPath: metricsPath,
      body: null,
      privateKey: auth.privateKey,
      publicKey: auth.publicKey,
    })
    : {};

  const [metricsRes, healthRes] = await Promise.all([
    httpFetch(`${baseUrl}${metricsPath}`, { method: 'GET', headers: metricsHeaders }),
    httpFetch(`${baseUrl}/myr/health`, { method: 'GET' }),
  ]);

  if (metricsRes.status !== 200) {
    const reason = typeof metricsRes.body === 'string'
      ? metricsRes.body
      : JSON.stringify(metricsRes.body);
    throw new Error(`/myr/metrics returned HTTP ${metricsRes.status}: ${reason}`);
  }

  const report = evaluateSlo({
    metrics: metricsRes.body,
    healthStatus: healthRes.status,
    fanout: args.fanout,
  });

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHuman(report);
  }

  if (report.summary.fail > 0) {
    process.exitCode = 2;
  }
}

main().catch((err) => {
  const detail = err && err.message ? err.message : String(err);
  console.error(`slo-check failed: ${detail}`);
  process.exit(1);
});
