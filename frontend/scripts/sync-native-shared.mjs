import { readdir, readFile, writeFile } from "node:fs/promises";

// Full-repository builds consume canonical codecs. A standalone frontend build
// uses its committed copies; byte identity is enforced by the repository tests,
// which is why this mirrors every canonical module rather than a named subset:
// a module added to shared/ without a copy would otherwise fail that test only
// after the next frontend build, instead of here.
const canonicalDir = new URL("../../shared/", import.meta.url);
for (const name of (await readdir(canonicalDir)).filter((entry) => entry.endsWith(".mjs")).sort()) {
  const canonical = new URL(name, canonicalDir);
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
