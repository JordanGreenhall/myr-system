# MYR v1.3.1 Final Release Authority Notes

**Date:** April 24, 2026
**Type:** Gate D publishability closure (operating-wave truth landed without rewriting prior tags)
**Package version:** 1.3.1
**Authoritative source tag:** v1.3.1

---

## Why v1.3.1 Exists

`v1.3.1` is the publishable release-truth state that carries Gate D completed work from post-`v1.3.0` execution into clean, tagged history:

- Gate D.2 operating model + pilot brief updates (`STA-218`)
- Gate D.3 scale acceptance tests (`STA-219`)
- Gate D.4 SLO definitions, dashboard templates, and executable SLO checker (`STA-220`)

This release closes dirty-tree publishability drift discovered by cron while preserving non-destructive release history.

## Authority Mapping (Operator Truth)

- npm package artifact: `myr-system-1.3.1.tgz`
- package metadata version: `1.3.1`
- source-level release truth tag: `v1.3.1`

## Important Scope Boundary

Coordinator/domain routing remains open critical-path work (`STA-217`). `v1.3.1` does not claim that coordinator implementation is complete; it only publishes accepted Gate D completed lanes and restores release-state integrity.

## Practical Guidance

When preparing or auditing release operations:

1. Use package metadata and tarball naming for npm publish mechanics (`1.3.1`).
2. Use tag `v1.3.1` as the canonical source reference for this release-truth state.
