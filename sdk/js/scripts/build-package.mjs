import { lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const repositoryRoot = path.resolve(packageRoot, '../..');
const output = path.join(packageRoot, 'dist');

// Preserve the relative source layout: ../../../shared from SDK modules must
// resolve inside the tarball, without rewriting or duplicating maintained code.
async function copyModules(source, destination) {
  if ((await lstat(source)).isSymbolicLink()) throw new Error(`Package source must not be a symbolic link: ${source}`);
  const entries = await readdir(source, { withFileTypes: true });
  await mkdir(destination, { recursive: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Package source must not be a symbolic link: ${sourcePath}`);
    if (entry.isDirectory()) {
      await copyModules(sourcePath, destinationPath);
    } else if (entry.isFile() && /\.(?:js|mjs|d\.ts)$/.test(entry.name)) {
      await writeFile(destinationPath, await readFile(sourcePath), { mode: 0o644 });
    }
  }
}

await rm(output, { recursive: true, force: true });
await copyModules(path.join(packageRoot, 'src'), path.join(output, 'sdk/js/src'));
await copyModules(path.join(repositoryRoot, 'shared'), path.join(output, 'shared'));
await writeFile(path.join(output, 'LICENSE'), await readFile(path.join(repositoryRoot, 'LICENSE')), { mode: 0o644 });

// Node cannot infer every named export of the CJS object. Generate explicit ESM
// bindings from the copied implementation so a new public method cannot drift.
const publicApi = createRequire(import.meta.url)(path.join(output, 'sdk/js/src/index.js'));
const namedExports = Object.keys(publicApi).sort().map((name, index) =>
  `const api${index} = sdk[${JSON.stringify(name)}];\nexport { api${index} as ${JSON.stringify(name)} };`
);
await writeFile(path.join(output, 'index.mjs'), [
  "import sdk from './sdk/js/src/index.js';",
  'export default sdk;',
  ...namedExports,
  '',
].join('\n'), { mode: 0o644 });
