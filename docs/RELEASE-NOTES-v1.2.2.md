# MYR v1.2.2 Final Release Authority Notes

**Date:** April 24, 2026
**Type:** Non-destructive source/package authority correction
**Package version:** 1.2.2
**Authoritative source tag:** v1.2.2

---

## Why v1.2.2 Exists

`v1.2.2` resolves release-tag drift introduced after the `v1.2.1` correction commit sequence. This final authority ensures the source tag dereferences to the same final commit that contains the reconciled release documentation.

No existing pushed tags are rewritten.

## Authority Mapping (Operator Truth)

- npm package artifact: `myr-system-1.2.2.tgz`
- package metadata version: `1.2.2`
- source-level final release-doc truth tag: `v1.2.2`

## Practical Guidance

When preparing or auditing release operations:

1. Use package metadata and tarball naming for npm publish mechanics (`1.2.2`).
2. Use tag `v1.2.2` as the canonical source reference for final release-documentation truth.
