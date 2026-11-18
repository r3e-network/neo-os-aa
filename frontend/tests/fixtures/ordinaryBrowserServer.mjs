import { after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { build, preview } from 'vite';

let buildPromise;

async function buildFixtureApp(root) {
  const outDir = await mkdtemp(join(tmpdir(), 'sa-ordinary-browser-'));
  try {
    // Fixture VITE_* variables are set by the caller before the first build.
    // Never reuse production dist: it has a different network/core identity.
    await build({ root, envFile: false, logLevel: 'error', build: { outDir, emptyOutDir: true } });
    return outDir;
  } catch (error) {
    await rm(outDir, { recursive: true, force: true });
    throw error;
  }
}

// Keep one immutable fixture build per test process. A dev server can discover
// lazy dependencies after the first render and reload /app during a click;
// ignoring filesystem watches does not disable that optimizer/HMR reload.
export async function startOrdinaryBrowserServer(root) {
  buildPromise ||= buildFixtureApp(root);
  const outDir = await buildPromise;
  const server = await preview({
    root, envFile: false, logLevel: 'error', build: { outDir },
    preview: { host: '127.0.0.1', port: 0 },
  });
  return {
    origin: `http://127.0.0.1:${server.httpServer.address().port}`,
    close: () => new Promise((resolve, reject) => {
      server.httpServer.close((error) => error ? reject(error) : resolve());
    }),
  };
}

after(async () => {
  const outDir = await buildPromise?.catch(() => null);
  if (outDir) await rm(outDir, { recursive: true, force: true });
});
