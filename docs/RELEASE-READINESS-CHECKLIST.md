# Release Readiness Checklist

Date: 2026-04-24

## Scope

This checklist is the repo-level release truth for MYR.

## Gates

- `npm test` (default regression truth)
- `npm run test:release` (publish truth = default regression + onboarding acceptance truth)

## Commands Run

```bash
npm run test:release
```

Observed result:

- `npm test`: `tests 389`, `pass 389`, `fail 0`, `duration_ms 76135.985291`
- `npm run test:onboarding-truth`: `tests 3`, `pass 3`, `fail 0`, gate status `PASS`

## Pass/Fail Matrix

| Gate | Status | Evidence |
|---|---|---|
| `npm test` | PASS | 389 tests, 111 suites, 0 failures |
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

## Prototype Residue / Non-Release Artifacts

- Local/generated key files under `keys/*.public.pem` and `keys/*.private.pem`.
- Runtime logs under `logs/`.
- Local runtime data under `db/*.db`, `exports/`, `imports/`, `node_modules/`.

These are excluded from release commits via `.gitignore`.
