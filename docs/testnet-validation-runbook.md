# Testnet Validation Runbook

This runbook executes the current V3 SDK testnet validation scripts in the safest recommended order, stopping on the first failure.

## Required environment

- `TEST_WIF` set to a dedicated funded Neo testnet account

## Optional environment

- `TESTNET_RPC_URL` to force one Neo N3 testnet RPC
- `TESTNET_RPC_URLS` as a comma- or whitespace-separated Neo N3 testnet RPC candidate list; when unset, the validators auto-probe the official public seeds `seed1` through `seed5.neo.org:20332` and then fall back to `https://testnet1.neo.coz.io:443`
- `MORPHEUS_RUNTIME_TOKEN` preferred, or `PHALA_API_TOKEN` / `PHALA_SHARED_SECRET`, to enable the live Morpheus paymaster relay validator
- `MORPHEUS_TESTNET_RUNTIME_URL` or `MORPHEUS_RUNTIME_URL` to override the default Morpheus testnet runtime URL; otherwise the validators use `https://oracle.meshmini.app/testnet/paymaster/authorize`
- `MORPHEUS_LOCAL_PAYMASTER_HANDLER_PATH` to run the Morpheus paymaster worker handler directly from a local checkout, for example `/home/neo/git/neo-morpheus-oracle/workers/phala-worker/src/worker.js`
- `MORPHEUS_PAYMASTER_APP_ID` if the paymaster validator should target a non-default CVM app
- `PAYMASTER_ACCOUNT_ID` if you want to replay against a fixed existing allowlisted account instead of deriving the bootstrap account from `TEST_WIF`
- `SKIP_PAYMASTER_ALLOWLIST_UPDATE=1` if you already manually allowlisted the account on the Morpheus worker
- `PHALA_SSH_RETRIES` to tune CVM bridge retries for the paymaster validator
- `PHALA_CLI` to override the Phala CLI launch command. When unset, the validators prefer a global `phala` binary and otherwise fall back to `npx --yes phala`.

If the public `paymaster/authorize` endpoint returns `401` or `403`, or a direct request fails before an HTTP response is available, the off-chain validators automatically retry through the remote worker path via `phala` / `npx phala` when the CLI is available. For deterministic local validation, set `MORPHEUS_LOCAL_PAYMASTER_HANDLER_PATH`; the validators then exercise the worker handler locally while still submitting the relay transaction to Neo N3 testnet.

## Dry run

From `sdk/js`, print the planned commands without broadcasting anything:

```bash
./run_testnet_validation_suite.sh --dry-run
```

## Live execution

From `sdk/js`, run the full ordered suite:

```bash
./run_testnet_validation_suite.sh
```

The suite writes machine-readable JSON reports to `docs/reports/`.

## Ordered scripts

1. `tests/testnet_smoke.js`
2. `tests/testnet_plugin_matrix.js`
3. `tests/testnet_market_escrow.js`
4. `tests/testnet_paymaster_onchain.mjs`
5. `tests/testnet_paymaster_policy.mjs` when `MORPHEUS_RUNTIME_TOKEN` or `PHALA_API_TOKEN` is present
6. `tests/testnet_paymaster_relay.mjs` when `MORPHEUS_RUNTIME_TOKEN` or `PHALA_API_TOKEN` is present

## Individual commands

```bash
npm run testnet:validate:smoke
npm run testnet:validate:plugin-matrix
npm run testnet:validate:market
npm run testnet:validate:paymaster-onchain
npm run testnet:validate:paymaster-policy
npm run testnet:validate:paymaster
npm run testnet:validate:report
```

## Safety notes

- The runner stops on the first failure.
- Several scripts deploy contracts or broadcast real testnet transactions and mutate live state.
- Testnet validators intentionally ignore generic `NEO_RPC_URL`; use only `TESTNET_RPC_URL` / `TESTNET_RPC_URLS`. Every live script verifies Neo N3 testnet network magic before it can broadcast.
- The plugin matrix deploys fresh verifier and hook artifacts and records a JSON report under `docs/reports/`.
- The paymaster policy validator exercises explicit deny paths such as wrong `dapp_id`, wrong `account_id`, wrong `target_contract`, wrong `method`, missing `operation_hash`, and over-limit gas.
- The paymaster validator can reuse a fixed allowlisted account or register a fresh account and update the worker allowlist live.
- The public paymaster endpoint is allowed to enforce hosted anti-abuse controls. Local handler validation proves policy logic and relay wiring without weakening that production boundary.
- Prefer a disposable test key and a fresh or resettable testnet environment before running the full suite.
- Re-running the suite against the same live state can change outcomes because nonces, verifier keys, allowlists, and balances move forward.
