# Testnet Validation Runbook

This runbook executes the v4 SDK testnet validation scripts in the safest recommended order, stopping on the first failure.

## Required environment

- `TEST_WIF` or `NEO_TESTNET_WIF` set to a dedicated funded Neo testnet account

The paymaster policy probe is the one stage that needs no wallet: it checks an off-chain allowlist pinned to a deployed core, so it needs `SA_CORE_HASH_TESTNET` (the deployed v4 core) and `PAYMASTER_ACCOUNT_ID` (the account that core derived). Without them the suite skips the stage instead of failing.

## Optional environment

- `SA_VALIDATION_RUN_ID` to name one suite run; every stage then shares the derived `sa-v4-<run id>` deployment tag
- `SA_VALIDATION_DEPLOY_TAG` to override that tag directly
- `SA_MATRIX_SCENARIOS` as a comma-separated list to narrow the plugin matrix to named scenarios (see the file header of `tests/testnet_plugin_matrix.js` for the names)
- `SA_MAX_SYSTEM_FEE` / `SA_MAX_NETWORK_FEE` / `SA_MAX_TOTAL_FEE` to tighten the fee caps the SDK enforces before signing (defaults `50000000` / `5000000` / `55000000`)
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

The dry run marks a stage `blocked` when a required variable is missing and `skip` when an optional stage cannot run, so the plan it prints is the plan the live run can execute.

## Live execution

From `sdk/js`, run the full ordered suite:

```bash
./run_testnet_validation_suite.sh
```

The suite writes `docs/reports/sa-testnet-validation-suite.latest.json` and `docs/TESTNET_VALIDATION_SUMMARY.md`, both stamped with the run id, the deployment tag and the core under test.

## v4 deployment model

The kernel and the modules it installs are deployed under their canonical manifest names. Two protocol checks make that mandatory: the SDK client only adopts a core whose manifest is named `SmartAccount`, and the kernel binds a module by comparing the profile's `contractName` with the deployed manifest name (§7.3 of `docs/SA-MODULE-PROTOCOL.md`), refusing a mismatch with `SA_MODULE_CODE_BINDING_MISMATCH`. A run tag would rename the manifest and break both checks, so only non-module contracts (paymaster, address market, test probe) carry the per-run suffix. Because the canonical hash of a given kernel is fixed, a rerun reuses the contracts already on chain instead of spending fees on duplicate deployments.

## Ordered scripts

1. `tests/testnet_smoke.js`
2. `tests/testnet_plugin_matrix.js`
3. `tests/testnet_market_escrow.js`
4. `tests/testnet_paymaster_onchain.mjs`
5. `tests/testnet_paymaster_policy.mjs` when a paymaster runtime token, `SA_CORE_HASH_TESTNET` and `PAYMASTER_ACCOUNT_ID` are present
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
- The plugin matrix deploys the v4 kernel plus the validator and hook modules it exercises, all under canonical names, and records a JSON report under `docs/reports/`.
- The paymaster policy validator exercises explicit deny paths such as wrong `dapp_id`, wrong `account_id`, wrong `target_contract`, wrong `method`, missing `operation_hash`, and over-limit gas.
- The paymaster validator can reuse a fixed allowlisted account or register a fresh account and update the worker allowlist live.
- The public paymaster endpoint is allowed to enforce hosted anti-abuse controls. Local handler validation proves policy logic and relay wiring without weakening that production boundary.
- Prefer a disposable test key and a fresh or resettable testnet environment before running the full suite.
- Re-running the suite against the same live state can change outcomes because nonces, verifier keys, allowlists, and balances move forward.
