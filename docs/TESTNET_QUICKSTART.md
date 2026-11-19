# Testnet Quickstart

Before any live validator run, check the plan and environment readiness first:

```bash
cd sdk/js
cp .env.example .env
# fill in TEST_WIF or NEO_TESTNET_WIF (funded testnet account)
npm run testnet:validate:dry-run
```

The dry run prints the planned validation stages, marks a required stage
`blocked` when its environment is missing, and names the optional stages it
would skip — without broadcasting anything.

When the dry run looks right, execute the live suite:

```bash
npm run testnet:validate
```

See the "Live Testnet Validation" section of the root `README.md` for RPC endpoint
pinning (`TESTNET_RPC_URL` / `TESTNET_RPC_URLS`), the stage list, and
per-stage commands.
