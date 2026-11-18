# Mainnet Read-Only Validation

This runbook validates the published Neo N3 mainnet SA anchors without broadcasting transactions.

Run from `sdk/js`:

```bash
npm run mainnet:validate:readonly
```

The validator checks:

- the generated Morpheus mainnet registry has the expected network magic
- the public mainnet runtime catalog and status endpoints are reachable and operational
- the mainnet SA core, Web3Auth verifier, session-key verifier, and social-recovery verifier contracts are deployed
- each deployed manifest exposes the required read/write entrypoints for the published architecture

The latest report is written to `sdk/docs/reports/v3-mainnet-readonly.latest.json`.
