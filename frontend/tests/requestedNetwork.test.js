import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesRequestedNetwork } from '../src/utils/requestedNetwork.js';

for (const network of ['mainnet', 'testnet']) {
  test(`${network}: absent or matching URL network uses the deployed network`, () => {
    assert.equal(matchesRequestedNetwork({}, network), true);
    assert.equal(matchesRequestedNetwork({ network }, network), true);
  });
  test(`${network}: wrong, ambiguous, and malformed URL networks are blocked`, () => {
    for (const requested of [network === 'mainnet' ? 'testnet' : 'mainnet', '', null, undefined, [], [network], [network, network], 'Mainnet', ' mainnet ', 'private', 1]) {
      assert.equal(matchesRequestedNetwork({ network: requested }, network), false);
    }
  });
}
test('unknown runtime network cannot authorize a workspace', () => {
  assert.equal(matchesRequestedNetwork({}, 'private'), false);
});
