'use strict';

const { httpFetch } = require('./sync');

const DEFAULT_BOOTSTRAP_RELAY_URL = 'https://bootstrap-relay.myr.network';

function isPrivateIpv4(host) {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  const nums = parts.map((p) => Number.parseInt(p, 10));
  if (nums.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return false;

  if (nums[0] === 10) return true;
  if (nums[0] === 127) return true;
  if (nums[0] === 192 && nums[1] === 168) return true;
  if (nums[0] === 172 && nums[1] >= 16 && nums[1] <= 31) return true;
  if (nums[0] === 169 && nums[1] === 254) return true;
  return false;
}

function isLocalHost(host) {
  if (!host) return true;
  const normalized = String(host).toLowerCase();
  if (normalized === 'localhost' || normalized === '::1' || normalized === '[::1]') return true;
  if (normalized.endsWith('.local') || normalized.endsWith('.internal')) return true;
  if (isPrivateIpv4(normalized)) return true;
  return false;
}

function inferNatStatus(nodeUrl) {
  if (!nodeUrl) {
    return {
      behindNatLikely: true,
      reason: 'no_public_node_url',
    };
  }

  try {
    const parsed = new URL(nodeUrl);
    if (isLocalHost(parsed.hostname)) {
      return {
        behindNatLikely: true,
        reason: 'node_url_is_local_or_private',
      };
    }
    return {
      behindNatLikely: false,
      reason: 'node_url_public',
    };
  } catch {
    return {
      behindNatLikely: true,
      reason: 'node_url_invalid',
    };
  }
}

function normalizeRelayConfig(relay) {
  if (!relay || relay.enabled === false || !relay.url) return null;
  return {
    enabled: true,
    url: relay.url,
    fallback_only: relay.fallback_only !== false,
  };
}

function resolveReachability({ nodeConfig, env = process.env }) {
  const nat = inferNatStatus(nodeConfig && nodeConfig.node_url);
  const configuredRelay = normalizeRelayConfig(nodeConfig && nodeConfig.relay);
  if (configuredRelay) {
    return {
      nat,
      method: 'relay',
      relay: { ...configuredRelay, source: 'configured' },
      fallbackChain: ['direct-address', 'bootstrap-relay', 'manual-config'],
    };
  }

  if (nat.behindNatLikely) {
    const bootstrapRelayUrl = env.MYR_BOOTSTRAP_RELAY_URL || DEFAULT_BOOTSTRAP_RELAY_URL;
    return {
      nat,
      method: 'relay',
      relay: {
        enabled: true,
        url: bootstrapRelayUrl,
        fallback_only: true,
        source: 'bootstrap-default',
      },
      fallbackChain: ['direct-address', 'bootstrap-relay', 'manual-config'],
    };
  }

  return {
    nat,
    method: 'direct-public',
    relay: null,
    fallbackChain: ['direct-address', 'bootstrap-relay', 'manual-config'],
  };
}

async function probeRelay({ relayUrl, fetchFn, timeoutMs = 2500 }) {
  const doFetch = fetchFn || httpFetch;
  const healthUrl = relayUrl.replace(/\/$/, '') + '/myr/health';
  let timeoutHandle;
  try {
    const result = await Promise.race([
      doFetch(healthUrl, { method: 'GET' }),
      new Promise((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error(`relay probe timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
      }),
    ]);

    clearTimeout(timeoutHandle);
    if (!result || result.status < 200 || result.status >= 300) {
      return { ok: false, reason: `HTTP ${result ? result.status : 'unknown'}` };
    }
    return { ok: true };
  } catch (err) {
    clearTimeout(timeoutHandle);
    return { ok: false, reason: err && err.message ? err.message : 'relay probe failed' };
  }
}

function manualFallbackInstructions({ port }) {
  return [
    'Relay fallback is unavailable. Manual reachability options:',
    `1. Re-run with a public URL: myr setup --public-url https://your-hostname.example --port ${port}`,
    `2. Or configure port forwarding to ${port} and update ~/.myr/config.json node_url.`,
    '3. Optional: set MYR_BOOTSTRAP_RELAY_URL to your own relay and re-run myr start.',
  ].join('\n');
}

module.exports = {
  DEFAULT_BOOTSTRAP_RELAY_URL,
  inferNatStatus,
  resolveReachability,
  probeRelay,
  manualFallbackInstructions,
};
