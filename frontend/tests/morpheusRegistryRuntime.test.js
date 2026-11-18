import test from 'node:test';
import assert from 'node:assert/strict';

import { MORPHEUS_PUBLIC_REGISTRY } from '../src/config/generatedMorpheusRegistry.js';
import { MORPHEUS_PUBLIC_RUNTIME_CATALOG } from '../src/config/generatedMorpheusRuntimeCatalog.js';
import { getRuntimeConfig } from '../src/config/runtimeConfig.js';

function stripHexPrefix(value) {
  const normalized = String(value || '');
  return normalized.slice(0, 2).toLowerCase() === '0x' ? normalized.slice(2) : normalized;
}

test('runtime defaults are derived from the generated Morpheus public registry and runtime topology catalog', () => {
  const mainnet = getRuntimeConfig({});
  const testnet = getRuntimeConfig({ VITE_SA_NETWORK: 'testnet' });
  const automationUpkeep = MORPHEUS_PUBLIC_RUNTIME_CATALOG.workflows.find((item) => item.id === 'automation.upkeep');

  assert.equal(mainnet.smartAccountHash, stripHexPrefix(MORPHEUS_PUBLIC_REGISTRY.mainnet.contracts.saCore));
  assert.equal(mainnet.smartAccountDomain, MORPHEUS_PUBLIC_REGISTRY.mainnet.domains.sa);
  assert.equal(mainnet.rpcUrl, MORPHEUS_PUBLIC_REGISTRY.mainnet.rpcUrl);
  assert.equal(mainnet.neoDidDomain, MORPHEUS_PUBLIC_REGISTRY.mainnet.domains.neodid);
  assert.equal(mainnet.morpheusApiBaseUrl, MORPHEUS_PUBLIC_REGISTRY.mainnet.morpheus.publicApiUrl);
  assert.equal(mainnet.morpheusOracleCvmId, MORPHEUS_PUBLIC_REGISTRY.mainnet.morpheus.oracleCvmId);
  assert.deepEqual(mainnet.morpheusTopology, {
    ingressPlane: 'edge_gateway',
    orchestrationPlane: 'control_plane',
    schedulerPlane: 'control_plane',
    executionPlane: 'tee_runtime',
    riskPlane: 'independent_observer',
  });
  assert.deepEqual(mainnet.morpheusAutomationTriggerKinds, ['interval', 'threshold']);

  assert.equal(testnet.smartAccountHash, stripHexPrefix(MORPHEUS_PUBLIC_REGISTRY.testnet.contracts.saCore));
  assert.equal(testnet.rpcUrl, MORPHEUS_PUBLIC_REGISTRY.testnet.rpcUrl);
  assert.equal(testnet.morpheusApiBaseUrl, MORPHEUS_PUBLIC_REGISTRY.testnet.morpheus.publicApiUrl);
  assert.equal(testnet.morpheusDatafeedCvmId, MORPHEUS_PUBLIC_REGISTRY.testnet.morpheus.datafeedCvmId);
  assert.equal(automationUpkeep.execution.teeRequired, true);
  assert.equal(automationUpkeep.execution.riskPlane, 'independent_observer');
});
