'use strict';

const { normalizeTags, listSubscriptions } = require('./subscriptions');

/**
 * DomainCoordinator — maintains a domain→peer routing table built from
 * subscription signals. Enables domain-aware selective routing so gossip
 * dissemination targets only peers interested in a given domain.
 *
 * Design (ADR-scale-architecture.md Phase 4):
 * - Nodes register domain interest via POST /myr/coordinator/register
 * - Coordinator aggregates subscriptions into a routing table
 * - Gossip dissemination queries the coordinator for targeted peer selection
 * - Backward-compatible: nodes without coordinator use subscription-filtered gossip
 */
class DomainCoordinator {
  constructor() {
    // domain (normalized tag) -> Map<publicKey, registration>
    this.routingTable = new Map();
    // publicKey -> Set<domain>
    this.peerDomains = new Map();
  }

  /**
   * Register a peer's interest in one or more domains.
   * Replaces any previous registration for this peer.
   */
  register(publicKey, domains, { operatorName = null, peerUrl = null } = {}) {
    if (!publicKey || typeof publicKey !== 'string') {
      throw new Error('publicKey is required');
    }

    const normalized = normalizeTags(domains);
    if (normalized.length === 0) {
      throw new Error('At least one domain tag is required');
    }

    // Remove old registrations for this peer
    this.unregister(publicKey);

    const registration = {
      publicKey,
      operatorName,
      peerUrl,
      registeredAt: new Date().toISOString(),
    };

    const domainSet = new Set();

    for (const domain of normalized) {
      if (!this.routingTable.has(domain)) {
        this.routingTable.set(domain, new Map());
      }
      this.routingTable.get(domain).set(publicKey, registration);
      domainSet.add(domain);
    }

    this.peerDomains.set(publicKey, domainSet);

    return {
      publicKey,
      domains: normalized,
      registeredAt: registration.registeredAt,
    };
  }

  /**
   * Remove all domain registrations for a peer.
   */
  unregister(publicKey) {
    const domains = this.peerDomains.get(publicKey);
    if (!domains) return false;

    for (const domain of domains) {
      const peers = this.routingTable.get(domain);
      if (peers) {
        peers.delete(publicKey);
        if (peers.size === 0) {
          this.routingTable.delete(domain);
        }
      }
    }
    this.peerDomains.delete(publicKey);
    return true;
  }

  /**
   * Query which peers are interested in a specific domain.
   * Returns an array of { publicKey, operatorName, peerUrl, registeredAt }.
   */
  route(domain) {
    const normalized = normalizeTags([domain]);
    if (normalized.length === 0) return [];

    const peers = this.routingTable.get(normalized[0]);
    if (!peers) return [];

    return [...peers.values()];
  }

  /**
   * Query peers interested in ANY of the given domains.
   * Deduplicates by publicKey.
   */
  routeMultiple(domains) {
    const normalized = normalizeTags(domains);
    if (normalized.length === 0) return [];

    const seen = new Map();
    for (const domain of normalized) {
      const peers = this.routingTable.get(domain);
      if (peers) {
        for (const [key, reg] of peers) {
          if (!seen.has(key)) {
            seen.set(key, { ...reg, matchedDomains: [domain] });
          } else {
            seen.get(key).matchedDomains.push(domain);
          }
        }
      }
    }

    return [...seen.values()];
  }

  /**
   * List all known domains and their peer counts.
   */
  listDomains() {
    const result = [];
    for (const [domain, peers] of this.routingTable) {
      result.push({
        domain,
        peerCount: peers.size,
        peers: [...peers.values()].map(r => ({
          publicKey: r.publicKey,
          operatorName: r.operatorName,
        })),
      });
    }
    return result.sort((a, b) => b.peerCount - a.peerCount);
  }

  /**
   * Get all domains a specific peer is registered for.
   */
  getDomainsForPeer(publicKey) {
    const domains = this.peerDomains.get(publicKey);
    return domains ? [...domains].sort() : [];
  }

  /**
   * Populate the routing table from the database subscription signals.
   * Called on startup or periodically to stay in sync with subscription state.
   */
  syncFromDatabase(db) {
    let subscriptions;
    try {
      subscriptions = listSubscriptions(db, { includeInactive: false });
    } catch {
      return { synced: 0 };
    }

    let synced = 0;
    for (const sub of subscriptions) {
      if (!sub.owner_public_key || !sub.tags || sub.tags.length === 0) continue;
      try {
        this.register(sub.owner_public_key, sub.tags, {
          operatorName: sub.owner_operator_name || null,
        });
        synced++;
      } catch {
        // Skip invalid subscriptions
      }
    }

    return { synced };
  }

  /**
   * Select peers for gossip dissemination of reports with given domain tags.
   * Returns peers from the routing table that match any of the report's domains.
   * If no matches found (or coordinator is empty), returns null to signal
   * fallback to default gossip peer selection.
   */
  selectPeersForReport(reportDomainTags) {
    const normalized = normalizeTags(reportDomainTags);
    if (normalized.length === 0 || this.routingTable.size === 0) {
      return null; // fallback to default
    }

    const matched = this.routeMultiple(normalized);
    if (matched.length === 0) {
      return null; // fallback to default
    }

    return matched.map(r => r.publicKey);
  }

  /**
   * Get coordinator stats.
   */
  getStats() {
    let totalRegistrations = 0;
    for (const peers of this.routingTable.values()) {
      totalRegistrations += peers.size;
    }
    return {
      domainCount: this.routingTable.size,
      peerCount: this.peerDomains.size,
      totalRegistrations,
    };
  }
}

module.exports = { DomainCoordinator };
