import test from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeHex as runtimeSanitizeHex } from '../src/config/runtimeConfig.js';
import { sanitizeHex as utilSanitizeHex } from '../src/utils/hex.js';

test('frontend modules reuse the same sanitizeHex implementation', () => {
  assert.equal(runtimeSanitizeHex('0xABCD'), 'abcd');
  assert.equal(utilSanitizeHex('0xABCD'), 'abcd');
  assert.strictEqual(runtimeSanitizeHex, utilSanitizeHex);
});
