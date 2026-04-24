# MYR v1.2.1 Source Correction Notes

**Date:** April 24, 2026
**Type:** Non-destructive source correction release
**Package version:** 1.2.0
**Authoritative source tag:** v1.2.1

---

## Why v1.2.1 Exists

`v1.2.1` is a source/documentation correction tag created after `v1.2.0` so release operators can anchor to the final release-truth documentation commit without rewriting any existing pushed tags.

No runtime code delta is introduced by this correction note itself.

## Authority Mapping (Operator Truth)

- npm package artifact: `myr-system-1.2.0.tgz`
- package metadata version: `1.2.0`
- source-level correction/final release-doc truth tag: `v1.2.1`

## Documentation Corrections Captured

- Removed stale wording that framed weekly exchange as the normal operating cadence.
- Clarified that normal operation is invite-link onboarding plus live/background sync.
- Preserved manual export/import exchange as advanced/offline fallback.

## Practical Guidance

When preparing or auditing release operations:

1. Use package metadata and tarball naming for npm publish mechanics (`1.2.0`).
2. Use tag `v1.2.1` as the canonical source reference for final release-documentation truth.
