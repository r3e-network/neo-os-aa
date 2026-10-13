import { readFile, writeFile } from "node:fs/promises";

// Full-repository builds consume canonical codecs. A standalone frontend build
// uses its committed copies; byte identity is enforced by the repository tests.
for (const name of ["nativeSmartAccount.mjs", "nativeSmartAccountClient.mjs", "nativeTransactionArtifact.mjs", "nativeWalletWitness.mjs", "relayContractParameter.mjs"]) {
  const canonical = new URL("../../shared/" + name, import.meta.url);
  const target = new URL("../src/shared/" + name, import.meta.url);
  let source;
  try {
    source = await readFile(canonical);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await readFile(target); // A missing standalone copy is always a build error.
    continue;
  }
  let current;
  try {
    current = await readFile(target);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!current?.equals(source)) await writeFile(target, source);
}
