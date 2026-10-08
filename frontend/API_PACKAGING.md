# Frontend API deployment boundary

The deployable frontend contains both the browser application and `api` server
routes. A frontend-only deployment must load every API module and run the relay
with dependencies declared in this directory's production `dependencies`.
Neither server route may resolve runtime packages through a sibling `sdk/js`
checkout or its development dependencies.

`@cityofzion/neon-js` 5.9.0 is a server runtime dependency for transaction signing,
serialization and backup-owner proof verification. Browser modules continue to
use local lightweight Neo helpers; importing Neon into the browser source graph
is prohibited. Declaring the server dependency does not make it part of the
Vite client graph.

The proxy witness algorithm is canonical in `shared/proxyWitness.mjs`; the
frontend-local copy is included in the deployment and must remain byte-identical.
The relay imports that local copy. No server startup or request path may import a
file outside `frontend`.

`node --test tests/apiPackaging.test.js` copies the real API and application
sources into a temporary frontend-only tree, exposes only declared production
dependencies, imports every API module, and exercises a real relay simulation and
the metadata owner-proof dependency path against an in-process loopback node.
It supplies no live credentials, sends no blockchain transaction and performs no
database mutation. This checks packaging and module resolution; contract witness
correctness remains covered by the separate runtime and private-chain gates.
