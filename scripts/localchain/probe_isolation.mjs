import { isProductionDeployment } from '../../frontend/api/deploymentEnv.js';

const OWNED_ENV = /^(AA_|MORPHEUS_|UPSTASH_|VITE_)/;
const LOOPBACK_ERROR = 'Disposable loopback RPC required: literal http://127.0.0.1 or http://[::1] with an explicit port >= 20000';

export function clearLocalchainEnvironment() {
  for (const key of Object.keys(process.env)) {
    if (OWNED_ENV.test(key)) delete process.env[key];
  }
}

export function requireRelayPrivateKeyHex(value = process.env.RELAY_PRIVATE_KEY_HEX) {
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error('RELAY_PRIVATE_KEY_HEX must be exactly 64 hexadecimal characters');
  }
  return value;
}

export function assertLocalchainProbe(rpcUrl) {
  if (isProductionDeployment()) throw new Error('Localchain probe refused production context');

  const raw = String(rpcUrl ?? '');
  let endpoint;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new Error(LOOPBACK_ERROR);
  }
  const authority = /^[a-z][a-z0-9+.-]*:\/\/([^\/?#]*)/i.exec(raw)?.[1];
  const port = Number(endpoint.port);
  if (endpoint.protocol !== 'http:'
      || (endpoint.hostname !== '127.0.0.1' && endpoint.hostname !== '[::1]')
      || authority !== endpoint.host
      || !/^\d+$/.test(endpoint.port)
      || !Number.isInteger(port)
      || port < 20000
      || port > 65535) {
    throw new Error(LOOPBACK_ERROR);
  }
  return endpoint;
}
