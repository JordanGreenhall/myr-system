# Release Readiness Checklist

Date: 2026-04-24

## Scope

This checklist is the repo-level release truth for MYR.

## Release Authority Mapping

- npm package version and tarball naming remain `1.2.0` (`myr-system-1.2.0.tgz`).
- Source-level correction tag is `v1.2.1` and is authoritative for finalized release-documentation truth.
- This split is intentional and non-destructive: no existing pushed tag is rewritten.

## Gates

- `npm test` (default regression truth)
- `npm run test:release` (publish truth = default regression + onboarding acceptance truth)

## Commands Run

```bash
npm run test:release
```

Observed result:

- `npm test`: `tests 423`, `pass 423`, `fail 0`
- `npm run test:onboarding-truth`: `tests 3`, `pass 3`, `fail 0`, gate status `PASS`

## Pass/Fail Matrix

| Gate | Status | Evidence |
|---|---|---|
| `npm test` | PASS | 423 tests, 122 suites, 0 failures |
| `npm run test:release` | PASS | default suite PASS + onboarding truth suite PASS |

## Included In Release Truth

- Default suite in `test/*.test.js` via `npm test`.
- Onboarding acceptance truth via `test/onboarding-truth-test.js` in `npm run test:release`.

Decision:
`npm test` remains day-to-day developer truth. `npm run test:release` is the explicit release gate so onboarding truth is mandatory at publish time.

## Files Touched For STA-171

- `.gitignore`
- `package.json`
- `README.md`
- `docs/NODE-ONBOARDING.md`
- `CHANGELOG.md`
- `test/cli.test.js`
- `docs/RELEASE-READINESS-CHECKLIST.md`
- `docs/RELEASE-NOTES-v1.2.0.md`
- `docs/RELEASE-NOTES-v1.2.1.md`
- `docs/OPERATOR-GUIDE.md`

## Prototype Residue / Non-Release Artifacts

- Local/generated key files under `keys/*.public.pem` and `keys/*.private.pem`.
- Runtime logs under `logs/`.
- Local runtime data under `db/*.db`, `exports/`, `imports/`, `node_modules/`.

These are excluded from release commits via `.gitignore`.
