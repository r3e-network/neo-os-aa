# Note: `market-deployment-results.json` is a historical scratch deploy

The sibling `market-deployment-results.json` is the recorded output of a
one-shot 2026-03 market phase-1/phase-2 validation run
(`scripts/deploy_market_and_list.js` + `scripts/deploy_market_phase2.js`,
deploy tag `market-mneku8bc`). It is kept for historical reference only:

- Its `aaCore` hash `0x2818ce328d6a7a92ff2c0200fe7cb2c76bee8870` is the
  **superseded** testnet AA core. The canonical testnet core is
  `0xdbf38e7b2117186bf7a5e17ead702322c0c5b6f2` (see the README anchor table).
- The 55 registered accounts and listings were created against that
  superseded core and are not meaningful for the current deployment.
- The JSON data itself is intentionally unmodified (it is the verbatim
  artifact the scripts wrote); do not treat its contents as current state.

Re-running either deploy script overwrites the file with fresh results.
