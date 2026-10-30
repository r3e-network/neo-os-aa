const fs = require('fs');
const path = require('path');
const { createError, EC } = require('./errors');

const NEF_RELATIVE_PATH = path.join('contracts', 'bin', 'sc', 'SmartAccountV2.nef');
const MANIFEST_RELATIVE_PATH = path.join('contracts', 'bin', 'sc', 'SmartAccountV2.manifest.json');

/** Cache for resolved artifact data keyed by fromDir. */
const artifactCache = new Map();

/**
 * Resolves the repository root by searching for contract artifacts.
 *
 * @param {string} [fromDir=__dirname] - Directory to start search from
 * @returns {string} Absolute path to repository root
 * @throws {Error} If repo root cannot be found
 */
function resolveRepoRoot(fromDir = __dirname) {
  let currentDir = path.resolve(fromDir);

  while (true) {
    const nefPath = path.join(currentDir, NEF_RELATIVE_PATH);
    const manifestPath = path.join(currentDir, MANIFEST_RELATIVE_PATH);
    if (fs.existsSync(nefPath) && fs.existsSync(manifestPath)) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      throw createError(EC.INTERNAL_REPO_ROOT_NOT_FOUND, { fromDir });
    }
    currentDir = parentDir;
  }
}

/**
 * Resolves paths to contract artifact files.
 *
 * @param {Object} options - Resolution options
 * @param {string} [options.fromDir=__dirname] - Directory to start search from
 * @returns {Object} Object with repoRoot, nefPath, and manifestPath
 */
function resolveContractArtifactPaths({ fromDir = __dirname } = {}) {
  const repoRoot = resolveRepoRoot(fromDir);
  return {
    repoRoot,
    nefPath: path.join(repoRoot, NEF_RELATIVE_PATH),
    manifestPath: path.join(repoRoot, MANIFEST_RELATIVE_PATH),
  };
}

/**
 * Reads contract artifacts from the repository (sync, legacy).
 *
 * @param {Object} options - Read options
 * @param {string} [options.fromDir=__dirname] - Directory to start search from
 * @returns {Object} Object with repoRoot, paths, and artifact contents
 */
function readContractArtifacts({ fromDir = __dirname } = {}) {
  const { repoRoot, nefPath, manifestPath } = resolveContractArtifactPaths({ fromDir });
  const nefBytes = fs.readFileSync(nefPath);
  const manifestString = fs.readFileSync(manifestPath, 'utf8');

  return {
    repoRoot,
    nefPath,
    manifestPath,
    nefBytes,
    nefBase64: nefBytes.toString('base64'),
    manifestString,
  };
}

/**
 * Reads contract artifacts asynchronously with caching.
 * Preferred over the sync version for production use.
 *
 * @param {Object} options - Read options
 * @param {string} [options.fromDir=__dirname] - Directory to start search from
 * @returns {Promise<Object>} Object with repoRoot, paths, and artifact contents
 */
async function readContractArtifactsAsync({ fromDir = __dirname } = {}) {
  const cacheKey = path.resolve(fromDir);
  if (artifactCache.has(cacheKey)) return artifactCache.get(cacheKey);

  const { repoRoot, nefPath, manifestPath } = resolveContractArtifactPaths({ fromDir });
  const [nefBytes, manifestString] = await Promise.all([
    fs.promises.readFile(nefPath),
    fs.promises.readFile(manifestPath, 'utf8'),
  ]);

  const result = {
    repoRoot,
    nefPath,
    manifestPath,
    nefBytes,
    nefBase64: nefBytes.toString('base64'),
    manifestString,
  };

  artifactCache.set(cacheKey, result);
  return result;
}

module.exports = {
  readContractArtifacts,
  readContractArtifactsAsync,
  resolveContractArtifactPaths,
  resolveRepoRoot,
};
