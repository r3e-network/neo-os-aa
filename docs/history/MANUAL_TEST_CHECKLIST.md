# Manual Test Checklist

This checklist is for human verification runs that supplement automated tests.

## Recovery verifier checks

- Confirm `TEST_WIF` is provided only through environment variables
- Confirm `bash contracts/recovery/compile_recovery_contracts.sh` succeeds
- Confirm the deployer account has sufficient testnet GAS
- Confirm each deployed contract hash matches the recorded validation doc
- Confirm the official package-script validators pass

## Canonical record

Write final txids and hashes to:

- `contracts/recovery/TESTNET_VALIDATION_2026-03-09.md`
