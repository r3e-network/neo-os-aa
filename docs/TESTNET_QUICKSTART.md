# Testnet Quickstart

Before any live validator run, check the plan and environment readiness first:

```bash
cd sdk/js
cp .env.example .env
# fill in TEST_WIF (funded testnet account)
npm run testnet:validate:dry-run
```

The dry run prints the planned validation stages and which optional stages
would be skipped for missing environment variables, without broadcasting
anything.

When the dry run looks right, execute the live suite:

```bash
npm run testnet:validate
```

See the "Live Testnet Validation" section of the root `README.md` for RPC endpoint
pinning (`TESTNET_RPC_URL` / `TESTNET_RPC_URLS`), the stage list, and
per-stage commands.
