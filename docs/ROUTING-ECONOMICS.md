# Routing Economics Model

This document defines how MYR tracks routing cost at node level for operator control and governance review.

## Goals

- Track per-peer network usage by sync cycle.
- Track relay burden separately from direct sync.
- Provide simple operator knobs for limiting high-cost peers.

## Accounting Units

- `bytes_sent`: serialized response bytes sent to a peer.
- `bytes_received`: serialized request bytes received from a peer.
- `relay_bytes`: bytes proxied through `/myr/relay`.
- `relay_requests`: count of relay operations handled.

## Data Model

Two SQLite tables are used:

- `myr_routing_cycles`
  - `cycle_id`: unique cycle identifier.
  - `peer_public_key`: peer key.
  - `started_at`, `ended_at`
  - `bytes_sent`, `bytes_received`
- `myr_routing_relay_costs`
  - `id`, `peer_public_key`, `recorded_at`
  - `relay_bytes`, `relay_requests`, `metadata`

## Current Instrumentation

- `/myr/sync/pull` records per-peer bytes received (request body) and bytes sent (response body).
- `/myr/relay` records relay bytes and request count by sender fingerprint.

## Operator Controls

- Configure unauthenticated endpoint limits (`rate_limit.unauthenticated_requests_per_minute`).
- Configure authenticated peer limits (`rate_limit.requests_per_minute`).
- Use governance revocation for abusive peers once cost threshold is exceeded.

## Interpretation

- High `bytes_received` with low successful compounding can indicate spammy peers.
- High `relay_bytes` concentrated on a small peer set indicates routing centralization risk.
- A balanced healthy network has distributed relay cost and bounded per-peer sync deltas.
