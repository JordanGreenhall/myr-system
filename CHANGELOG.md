# Changelog

## [Unreleased]

### Changed

- Default test suite (`npm test`) now has a corrected trust expectation for peer introduction auto-approval (`trusted` vs stale `introduced` expectation).
- Added explicit release truth gate: `npm run test:release` now runs both default regression tests and onboarding acceptance truth (`test/onboarding-truth-test.js`).
- Documentation now explicitly distinguishes default developer test truth vs release publish truth.
- Clarified release authority split: npm package remains `1.2.0` while `v1.2.1` is the source-level correction tag for final release-documentation truth.
- Removed stale release language that framed weekly exchange cadence as the normal path; normal path is invite-link onboarding plus live/background sync.

## [1.2.0] — 2026-03-29

### Added

- **In-band fingerprint verification** (`POST /myr/peers/announce`): 3-way verification checks that the announced fingerprint matches the public key, that the peer's discovery document is reachable, and that the discovery document fingerprint is consistent. Peers passing all checks move to `verified-pending-approval`.
- **`auto_approve_verified_peers`** config option: when enabled, peers that pass 3-way verification are automatically trusted without manual approval. Reciprocal announce is sent automatically on auto-approve.
- **`lib/verify.js`**: consolidated 3-way fingerprint verification module (from `lib/crypto.js` and `lib/liveness.js`).
- **`db/schema.sql`**: canonical schema file for the MYR database.
- **Migration 004**: adds `node_uuid`, `verification_evidence`, and `auto_approved` columns to `myr_peers`.
- **`node_uuid`** field in discovery document (`/.well-known/myr-node`) and peer announce flow.
- **`myr node verify`** CLI command and `verifyNode()` library function for remote node identity + liveness verification.
- **Signed health check** (`liveness_proof` block on `/myr/health`) with Ed25519 signatures over timestamp + nonce.
- **DHT peer discovery** via Hyperswarm (`myr peer discover`) with optional `--auto-introduce`.
- **Relay fallback** for nodes behind NAT or firewalls.
- **Integration tests** for two-node onboarding flow (v1.2.0 path).

### Changed

- Protocol version bumped to `1.2.0` in discovery document.
- Announce handler now stores `verification_evidence` JSON for audit trail.
- `package.json` version bumped from `1.0.0` to `1.2.0`.

## [1.1.0] — 2026-03-15

### Added

- HTTP server for live peer-to-peer synchronization.
- Peer management CLI (`myr peer add/approve/list`).
- Auto-sync agent (15-minute cycle for trusted peers).
- Node registry with signed discovery for zero-coordination onboarding.
- Auto-approve trusted peers on re-announce.
- launchd service support for macOS.

## [1.0.0] — 2026-02-27

### Added

- Initial release: MYR capture, search, verify, sign, export, import, synthesize.
- Ed25519 identity module with keypair generation and signing.
- SQLite storage with FTS5 full-text search.
- Operator verification and rating system.
- Weekly digest generation.
- Cross-node synthesis.
