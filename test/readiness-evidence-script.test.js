const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const scriptPath = path.join(repoRoot, 'scripts/readiness/collect-evidence.sh');

function scriptSource() {
  return fs.readFileSync(scriptPath, 'utf8');
}

test('readiness evidence git_clean ignores only its own generated report artifacts', () => {
  const source = scriptSource();

  assert.match(
    source,
    /EVIDENCE_REPORT_RELATIVE_PATHS=\(/,
    'collect-evidence.sh should declare its generated report paths explicitly',
  );
  assert.match(
    source,
    /git .*status --porcelain[\s\S]*grep -vFf/,
    'git_clean should filter generated evidence-report paths before counting dirty files',
  );
});

test('readiness evidence reports package release tag intent instead of stale latest tag', () => {
  const source = scriptSource();

  assert.doesNotMatch(
    source,
    /git -C "\$PROJECT_ROOT" describe --tags --abbrev=0/,
    'git_tag must not use latest reachable tag because release artifacts are generated before the final tag exists',
  );
  assert.match(
    source,
    /EXPECTED_TAG="v\$PKG_VERSION"/,
    'git_tag should be anchored to the package version tag intent',
  );
});

test('readiness evidence preserves committed reports when only collection timestamps change', () => {
  const source = scriptSource();

  assert.match(
    source,
    /write_report_if_semantically_changed\(\)/,
    'collect-evidence.sh should compare newly generated reports to existing committed reports before overwriting',
  );
  assert.match(
    source,
    /delete clone\.timestamp/,
    'JSON report comparison should ignore only the volatile collection timestamp',
  );
  assert.match(
    source,
    /replace\(\/\^\\\*\\\*Collected:/,
    'Markdown report comparison should ignore the volatile Collected line',
  );
});
