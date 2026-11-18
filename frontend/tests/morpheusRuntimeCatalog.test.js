import test from 'node:test';
import assert from 'node:assert/strict';

import { getRuntimeConfig } from '../src/config/runtimeConfig.js';

test('sa runtime config exposes paymaster workflow metadata', () => {
  const config = getRuntimeConfig({});

  assert.ok(config.morpheusWorkflowIds.includes('paymaster.authorize'));
  assert.equal(config.morpheusEnvelopeVersion, '2026-04-tee-v1');
});
