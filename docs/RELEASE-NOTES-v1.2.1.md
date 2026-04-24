# MYR v1.2.1 Source Correction Notes

**Date:** April 24, 2026
**Type:** Non-destructive source correction release
**Package version:** 1.2.0
**Status:** Superseded by v1.2.2
**Current authoritative source tag:** v1.2.2

---

## Why v1.2.1 Exists

`v1.2.1` was a source/documentation correction tag created after `v1.2.0`. A follow-up docs correction landed later, so final release authority moved to `v1.2.2` without rewriting any existing pushed tags.

No runtime code delta is introduced by this correction note itself.

## Authority Mapping (Operator Truth)

- npm package artifact: `myr-system-1.2.2.tgz`
- package metadata version: `1.2.2`
- source-level correction/final release-doc truth tag: `v1.2.2`

## Documentation Corrections Captured

- Removed stale wording that framed weekly exchange as the normal operating cadence.
- Clarified that normal operation is invite-link onboarding plus live/background sync.
- Preserved manual export/import exchange as advanced/offline fallback.

## Practical Guidance

When preparing or auditing release operations:

1. Use package metadata and tarball naming for npm publish mechanics (`1.2.2`).
2. Use tag `v1.2.2` as the canonical source reference for final release-documentation truth.
