// A package name is never a security exception. This one upstream advisory has
// no patched elliptic release; see docs/FRONTEND_DEPENDENCY_SECURITY.md.
const REVIEWED_ADVISORIES = new Map([
  ['GHSA-848j-6mx2-7j84', 'elliptic'],
]);
const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'];
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function requireLowSeverity(severity, context) {
  const rank = SEVERITIES.indexOf(severity);
  if (rank < 0 || rank > 1) throw new Error(`${context}: invalid or above-low severity ${String(severity)}`);
}

export function validateAuditReport(report) {
  if (!isRecord(report) || Object.hasOwn(report, 'error') || report.auditReportVersion !== 2 ||
      !isRecord(report.vulnerabilities) || !isRecord(report.metadata?.vulnerabilities)) {
    throw new Error('Malformed or unsuccessful npm audit report.');
  }
  const entries = report.vulnerabilities;
  const counts = report.metadata.vulnerabilities;
  const observedCounts = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0]));
  for (const [name, entry] of Object.entries(entries)) {
    if (!isRecord(entry) || entry.name !== name || !Array.isArray(entry.via) || !entry.via.length) {
      throw new Error(`${name}: malformed vulnerability entry or empty advisory path.`);
    }
    requireLowSeverity(entry.severity, name);
    observedCounts[entry.severity]++;
  }
  for (const severity of [...SEVERITIES, 'total']) {
    const expected = severity === 'total' ? Object.keys(entries).length : observedCounts[severity];
    if (!Number.isSafeInteger(counts[severity]) || counts[severity] < 0 || counts[severity] !== expected) {
      throw new Error(`Malformed or inconsistent npm audit ${severity} count.`);
    }
  }

  const visiting = new Set();
  const checked = new Set();
  const advisories = new Set();
  function visit(name) {
    if (checked.has(name)) return;
    if (!Object.hasOwn(entries, name) || visiting.has(name)) {
      throw new Error(`${name}: missing or cyclic advisory path.`);
    }
    visiting.add(name);
    for (const via of entries[name].via) {
      if (typeof via === 'string') {
        visit(via);
        continue;
      }
      if (!isRecord(via)) throw new Error(`${name}: malformed advisory.`);
      requireLowSeverity(via.severity, `${name} advisory`);
      const id = typeof via.url === 'string'
        ? /^https:\/\/github\.com\/advisories\/(GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})$/.exec(via.url)?.[1]
        : undefined;
      const expectedPackage = REVIEWED_ADVISORIES.get(id);
      if (!expectedPackage) throw new Error(`${name}: unreviewed advisory ${via.url ?? '(missing URL)'}.`);
      if (name !== expectedPackage || via.name !== name || via.dependency !== name) {
        throw new Error(`${name}: reviewed advisory package identity mismatch.`);
      }
      advisories.add(id);
    }
    visiting.delete(name);
    checked.add(name);
  }
  for (const name of Object.keys(entries)) visit(name);
  return { packageCount: Object.keys(entries).length, advisories: [...advisories].sort() };
}
