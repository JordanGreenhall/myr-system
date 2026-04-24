# MYR v1.3.0 Final Release Authority Notes

**Date:** April 24, 2026
**Type:** Release-truth closure for Gate A/B/C readiness wave
**Package version:** 1.3.0
**Authoritative source tag:** v1.3.0

---

## Why v1.3.0 Exists

`v1.3.0` is the first publishable release that includes:

- Gate A production gossip transport closure (IHAVE/IWANT + bloom anti-entropy endpoints, gossip capability detection, mixed-mode interop, explicit N=1000 O(N*F) evidence)
- Gate B governance/abuse resistance
- Gate C observability/support operations

This release closes publishability drift after `v1.2.3` without rewriting prior tags.

## Authority Mapping (Operator Truth)

- npm package artifact: `myr-system-1.3.0.tgz`
- package metadata version: `1.3.0`
- source-level release truth tag: `v1.3.0`

## Practical Guidance

When preparing or auditing release operations:

1. Use package metadata and tarball naming for npm publish mechanics (`1.3.0`).
2. Use tag `v1.3.0` as the canonical source reference for this release-truth state.
