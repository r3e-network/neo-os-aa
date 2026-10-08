import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAuditReport } from '../../scripts/lib/frontend-audit-policy.mjs';

const advisory = () => ({
  name: 'elliptic', dependency: 'elliptic', severity: 'low',
  url: 'https://github.com/advisories/GHSA-848j-6mx2-7j84',
});
const entry = (name, via) => ({ name, severity: 'low', via });
function report() {
  return {
    auditReportVersion: 2,
    vulnerabilities: {
      elliptic: entry('elliptic', [advisory()]),
      '@web3auth/modal': entry('@web3auth/modal', ['elliptic']),
    },
    metadata: { vulnerabilities: { info: 0, low: 2, moderate: 0, high: 0, critical: 0, total: 2 } },
  };
}

test('accepts only the reviewed advisory and resolves propagated dependency findings', () => {
  assert.deepEqual(validateAuditReport(report()).advisories, ['GHSA-848j-6mx2-7j84']);
});

test('a new advisory on the same accepted package fails', () => {
  const value = report();
  value.vulnerabilities.elliptic.via.push({ ...advisory(), url: 'https://github.com/advisories/GHSA-2222-3333-4444' });
  assert.throws(() => validateAuditReport(value), /unreviewed advisory/);
});

test('the reviewed ID cannot authorize an unrelated package', () => {
  const value = report();
  value.vulnerabilities.elliptic.via[0].dependency = 'unrelated';
  assert.throws(() => validateAuditReport(value), /package identity/);
});

test('missing or unknown severity fails for packages and advisory leaves', () => {
  for (const severity of [undefined, null, '', 'unknown']) {
    for (const leaf of [false, true]) {
      const value = report();
      (leaf ? value.vulnerabilities.elliptic.via[0] : value.vulnerabilities.elliptic).severity = severity;
      assert.throws(() => validateAuditReport(value), /severity/);
    }
  }
});

test('any severity above low fails even on the reviewed advisory', () => {
  for (const severity of ['moderate', 'high', 'critical']) {
    const value = report();
    value.vulnerabilities.elliptic.via[0].severity = severity;
    assert.throws(() => validateAuditReport(value), /severity/);
  }
});

test('malformed and registry error reports fail instead of reporting clean', () => {
  for (const value of [null, [], {}, { error: { code: 'EAI_AGAIN' } },
    { ...report(), error: {} }, { ...report(), auditReportVersion: 1 },
    { ...report(), vulnerabilities: [] }, { ...report(), metadata: {} }]) {
    assert.throws(() => validateAuditReport(value));
  }
});

test('missing, cyclic, empty and malformed advisory paths fail closed', () => {
  for (const via of [[], ['absent'], ['@web3auth/modal'], [null], [{}], 'elliptic']) {
    const value = report();
    value.vulnerabilities.elliptic.via = via;
    assert.throws(() => validateAuditReport(value));
  }
});

test('inconsistent counts and missing count severities fail', () => {
  for (const mutate of [
    (value) => { value.metadata.vulnerabilities.total = 0; },
    (value) => { delete value.metadata.vulnerabilities.high; },
    (value) => { value.metadata.vulnerabilities.low = '2'; },
    (value) => { value.metadata.vulnerabilities.critical = -1; },
    (value) => { value.vulnerabilities.elliptic.name = 'other'; },
  ]) {
    const value = report(); mutate(value);
    assert.throws(() => validateAuditReport(value));
  }
});

test('only a complete empty report is clean', () => {
  const value = report();
  value.vulnerabilities = {};
  value.metadata.vulnerabilities.low = 0;
  value.metadata.vulnerabilities.total = 0;
  assert.equal(validateAuditReport(value).packageCount, 0);
});
