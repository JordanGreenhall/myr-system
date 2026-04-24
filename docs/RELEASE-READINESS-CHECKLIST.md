# Release Readiness Checklist

Date: 2026-04-24

## Scope

This checklist is the repo-level release truth for MYR.

## Release Authority Mapping

- npm package version and tarball naming are `1.3.0` (`myr-system-1.3.0.tgz`).
- Source-level release tag is `v1.3.0` and is authoritative for finalized release-documentation truth.
- This is non-destructive: no existing pushed tags are rewritten.

## Gates

- `npm test` (default regression truth)
- `npm run test:release` (publish truth = default regression + onboarding acceptance truth)

## Commands Run

```bash
npm run test:release
```

Observed result:

- `npm test`: `tests 436`, `pass 436`, `fail 0`
- `npm run test:onboarding-truth`: `tests 3`, `pass 3`, `fail 0`, gate status `PASS`

## Pass/Fail Matrix

| Gate | Status | Evidence |
|---|---|---|
| `npm test` | PASS | 436 tests, 126 suites, 0 failures |
| `npm run test:release` | PASS | default suite PASS + onboarding truth suite PASS |

## Included In Release Truth

- Default suite in `test/*.test.js` via `npm test`.
- Onboarding acceptance truth via `test/onboarding-truth-test.js` in `npm run test:release`.

Decision:
`npm test` remains day-to-day developer truth. `npm run test:release` is the explicit release gate so onboarding truth is mandatory at publish time.

## Files Touched For STA-214

- `lib/sync.js`
- `server/index.js`
- `test/gossip-scale.test.js`
- `test/server.test.js`
- `test/gossip-interop.test.js`
- `package.json`
- `package-lock.json`
- `README.md`
- `CHANGELOG.md`
- `docs/RELEASE-READINESS-CHECKLIST.md`
- `docs/RELEASE-NOTES-v1.3.0.md`
- `docs/OPERATOR-GUIDE.md`

## Prototype Residue / Non-Release Artifacts

- Local/generated key files under `keys/*.public.pem` and `keys/*.private.pem`.
- Runtime logs under `logs/`.
- Local runtime data under `db/*.db`, `exports/`, `imports/`, `node_modules/`.

These are excluded from release commits via `.gitignore`.
