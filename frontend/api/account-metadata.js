import { createRequire } from 'node:module';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { createClient } from '@supabase/supabase-js';
import {
  DEFAULT_ABSTRACT_ACCOUNT_HASH,
  DEFAULT_ABSTRACT_ACCOUNT_HASH_TESTNET,
  DEFAULT_RPC_URL,
  DEFAULT_RPC_URL_TESTNET,
  resolveAbstractAccountHash,
} from '../src/config/runtimeConfig.js';
import { checkRateLimit, resolveClientIp, resolveRateLimitFailure, sanitizeError } from './rateLimiter.js';
import { apiFetch } from './outboundFetch.js';

function trim(value) {
  return String(value || '').trim();
}

function normalizeHex(value) {
  return trim(value).replace(/^0x/i, '').toLowerCase();
}

function getSdkRequire() {
  return createRequire(new URL('../package.json', import.meta.url));
}

function getNeonWallet() {
  const sdkRequire = getSdkRequire();
  const { wallet, u } = sdkRequire('@cityofzion/neon-js');
  return { wallet, u };
}

function resolveControlNetwork(req) {
  const candidate = trim(
    req?.body?.network
      || req?.query?.network
      || req?.headers?.['x-aa-network']
      || process.env.VITE_AA_NETWORK
      || process.env.MORPHEUS_NETWORK
      || '',
  ).toLowerCase();
  return candidate === 'testnet' ? 'testnet' : 'mainnet';
}

function resolveControlRpcUrl(network) {
  const upper = network === 'testnet' ? 'TESTNET' : 'MAINNET';
  return trim(
    process.env[`AA_RELAY_${upper}_RPC_URL`]
      || process.env.AA_RELAY_RPC_URL
      || process.env.VITE_AA_RPC_URL
      || process.env.VITE_NEO_RPC_URL
      || (network === 'testnet' ? DEFAULT_RPC_URL_TESTNET : DEFAULT_RPC_URL),
  );
}

function resolveControlAaHash(network) {
  const defaultHash = network === 'testnet'
    ? DEFAULT_ABSTRACT_ACCOUNT_HASH_TESTNET
    : DEFAULT_ABSTRACT_ACCOUNT_HASH;
  const configured = network === 'testnet'
    ? process.env.AA_RELAY_TESTNET_ALLOWED_HASH || process.env.VITE_AA_HASH_TESTNET || process.env.VITE_ABSTRACT_ACCOUNT_HASH_TESTNET
    : process.env.AA_RELAY_MAINNET_ALLOWED_HASH || process.env.VITE_AA_HASH || process.env.VITE_ABSTRACT_ACCOUNT_HASH;
  return resolveAbstractAccountHash(
    trim(process.env.AA_RELAY_ALLOWED_HASH) || trim(configured) || defaultHash,
    defaultHash,
  );
}

function decodeHash160StackValue(item, u) {
  if (!item || typeof item !== 'object') return '';
  // Normalize every form to the internal little-endian script hash that
  // getScriptHashFromPublicKey produces, so callers can compare directly.
  if (item.type === 'Hash160') {
    const display = normalizeHex(item.value);
    return /^[0-9a-f]{40}$/.test(display) ? normalizeHex(u.reverseHex(display)) : '';
  }
  if (item.type === 'ByteString' && item.value) {
    // Nodes emit UInt160 stack values as a ByteString of internal little-endian
    // bytes, matching getScriptHashFromPublicKey, so no reversal is needed.
    return normalizeHex(Buffer.from(item.value, 'base64').toString('hex'));
  }
  return '';
}

async function readBackupOwnerScriptHash({ accountIdHash, network }) {
  const rpcUrl = resolveControlRpcUrl(network);
  const aaHash = resolveControlAaHash(network);
  if (!rpcUrl || !aaHash) return '';

  const { u } = getNeonWallet();
  const response = await apiFetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'invokefunction',
      params: [
        `0x${normalizeHex(aaHash)}`,
        'getBackupOwner',
        [{ type: 'Hash160', value: `0x${normalizeHex(accountIdHash)}` }],
      ],
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (payload?.error || payload?.result?.state === 'FAULT') return '';
  return decodeHash160StackValue(payload?.result?.stack?.[0], u);
}

function verifyBackupOwnerSignature({ publicKey, signature, message }) {
  const pub = normalizeHex(publicKey);
  const sig = normalizeHex(signature);
  if (!/^[0-9a-f]{66}$/.test(pub) || !/^[0-9a-f]{128}$/.test(sig) || !message) {
    return '';
  }
  const { wallet } = getNeonWallet();
  const messageHex = Buffer.from(message, 'utf8').toString('hex');
  if (!wallet.verify(messageHex, sig, pub)) {
    return '';
  }
  return normalizeHex(wallet.getScriptHashFromPublicKey(pub));
}

function extractWalletPublicKeys(claims = {}) {
  const wallets = Array.isArray(claims.wallets) ? claims.wallets : [];
  return wallets
    .map((entry) => normalizeHex(entry?.public_key || entry?.publicKey || ''))
    .filter((value) => /^[0-9a-f]{66}$/.test(value));
}

async function authorizeUpsertControl(req, accountIdHash) {
  const network = resolveControlNetwork(req);
  const account = normalizeHex(accountIdHash);
  if (!/^[0-9a-f]{40}$/.test(account)) {
    return { ok: false, statusCode: 400, error: 'accountIdHash must be a 20-byte hash' };
  }

  const idToken = trim(req.body?.idToken);
  const ownerProof = req.body?.ownerProof && typeof req.body.ownerProof === 'object' ? req.body.ownerProof : null;

  // Reject before any chain lookup when the caller supplies no proof of control.
  if (!idToken && !ownerProof) {
    return { ok: false, statusCode: 403, error: 'Proof of account control required' };
  }

  const onChainBackupOwner = await readBackupOwnerScriptHash({ accountIdHash: account, network });
  if (!onChainBackupOwner) {
    return { ok: false, statusCode: 403, error: 'Unable to resolve account backup owner for control proof' };
  }

  if (idToken) {
    const jwksUrl = trim(process.env.WEB3AUTH_JWKS_URL || 'https://api-auth.web3auth.io/.well-known/jwks.json');
    const clientId = trim(process.env.WEB3AUTH_CLIENT_ID || process.env.VITE_WEB3AUTH_CLIENT_ID || '');
    if (!clientId) {
      return { ok: false, statusCode: 500, error: 'WEB3AUTH_CLIENT_ID is not configured' };
    }
    let claims = {};
    try {
      const JWKS = createRemoteJWKSet(new URL(jwksUrl));
      const { payload } = await jwtVerify(idToken, JWKS, { audience: clientId });
      claims = payload || {};
    } catch (error) {
      return { ok: false, statusCode: 401, error: error instanceof Error ? error.message : 'Web3Auth token verification failed' };
    }
    const { wallet } = getNeonWallet();
    const controls = extractWalletPublicKeys(claims)
      .some((pub) => normalizeHex(wallet.getScriptHashFromPublicKey(pub)) === onChainBackupOwner);
    if (!controls) {
      return { ok: false, statusCode: 403, error: 'Web3Auth identity does not control this account' };
    }
    return { ok: true };
  }

  const signerScriptHash = verifyBackupOwnerSignature({
    publicKey: ownerProof.publicKey,
    signature: ownerProof.signature,
    message: trim(ownerProof.message),
  });
  if (!signerScriptHash) {
    return { ok: false, statusCode: 401, error: 'Invalid backup owner signature' };
  }
  // Bind the signed challenge to the target account so a signature for one
  // account cannot be replayed against another.
  if (!trim(ownerProof.message).includes(account)) {
    return { ok: false, statusCode: 403, error: 'Signed message is not bound to this account' };
  }
  if (signerScriptHash !== onChainBackupOwner) {
    return { ok: false, statusCode: 403, error: 'Signer is not the account backup owner' };
  }
  return { ok: true };
}

function getServiceSupabaseClient() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !serviceRoleKey) return null;
  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
}

function getAllowedOrigins() {
  if (process.env.ALLOWED_ORIGINS) {
    return process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim()).filter(Boolean);
  }
  if (process.env.ALLOWED_ORIGIN) {
    return [process.env.ALLOWED_ORIGIN];
  }
  // Default to the app's own Vercel-hosted origin
  const vercelUrl = process.env.VERCEL_URL;
  if (vercelUrl) {
    return [`https://${vercelUrl}`];
  }
  return [];
}

function isOriginAllowed(origin, allowedOrigins) {
  if (!origin) return false;
  return allowedOrigins.includes(origin);
}

function setCorsHeaders(req, res) {
  const allowedOrigins = getAllowedOrigins();
  const origin = req.headers.origin;
  if (allowedOrigins.length > 0 && isOriginAllowed(origin, allowedOrigins)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const clientIp = resolveClientIp(req);
  const rate = await checkRateLimit(clientIp);
  if (!rate.allowed) {
    const failure = resolveRateLimitFailure(rate);
    if (failure.retryAfter) res.setHeader('Retry-After', String(failure.retryAfter));
    return res.status(failure.statusCode).json({
      error: failure.error === 'client_identity_unavailable' ? failure.error : 'Rate limit exceeded',
    });
  }

  const supabase = getServiceSupabaseClient();
  if (!supabase) return res.status(500).json({ error: 'Service unavailable' });

  const { action } = req.body || {};

  try {
    if (action === 'get') {
      const { accountIdHash } = req.body;
      if (!accountIdHash) return res.status(400).json({ error: 'accountIdHash required' });

      const { data, error } = await supabase
        .from('aa_account_metadata')
        .select('description, logo_url, metadata_uri, updated_at')
        .eq('account_id_hash', accountIdHash)
        .maybeSingle();

      if (error) throw error;
      return res.status(200).json({ ok: true, metadata: data || { description: '', logo_url: '', metadata_uri: '', updated_at: null } });
    }

    if (action === 'getBatch') {
      const { accountIdHashes } = req.body;
      if (!Array.isArray(accountIdHashes) || accountIdHashes.length === 0) {
        return res.status(400).json({ error: 'accountIdHashes array required' });
      }
      if (accountIdHashes.length > 50) {
        return res.status(400).json({ error: 'Maximum 50 hashes per batch' });
      }

      const { data, error } = await supabase
        .from('aa_account_metadata')
        .select('account_id_hash, description, logo_url, metadata_uri')
        .in('account_id_hash', accountIdHashes);

      if (error) throw error;

      const map = {};
      for (const row of data || []) {
        map[row.account_id_hash] = { description: row.description, logo_url: row.logo_url, metadata_uri: row.metadata_uri };
      }
      return res.status(200).json({ ok: true, map });
    }

    if (action === 'upsert') {
      const { accountIdHash, description, logoUrl, metadataUri } = req.body;
      if (!accountIdHash) return res.status(400).json({ error: 'accountIdHash required' });

      const control = await authorizeUpsertControl(req, accountIdHash);
      if (!control.ok) {
        return res.status(control.statusCode).json({ error: control.error });
      }

      const sanitized = {
        account_id_hash: accountIdHash,
        description: String(description || '').slice(0, 500),
        logo_url: String(logoUrl || '').slice(0, 500),
        metadata_uri: String(metadataUri || '').slice(0, 240),
        updated_at: new Date().toISOString(),
      };

      if (sanitized.logo_url && !sanitized.logo_url.startsWith('https://')) {
        return res.status(400).json({ error: 'logo_url must be HTTPS' });
      }

      const { error } = await supabase
        .from('aa_account_metadata')
        .upsert(sanitized, { onConflict: 'account_id_hash' });

      if (error) throw error;
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('[account-metadata]', err);
    return res.status(500).json({ error: sanitizeError(err) });
  }
}
