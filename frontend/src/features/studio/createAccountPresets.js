// Guided account creation: the verifier choices a create flow may offer are the
// verifier modules the platform actually publishes for the selected network, and
// the registerAccount invocation is built in one place so the derived account id
// and the submitted arguments cannot disagree about them.
import { MORPHEUS_PUBLIC_REGISTRY } from '../../config/generatedMorpheusRegistry.js';
import { deriveRegistrationAccountIdHash } from '../../utils/neo.js';
import { sanitizeHex } from '../../utils/hex.js';
import { hash160Param } from './helpers.js';

const ZERO_HASH160 = '0000000000000000000000000000000000000000';

// The registry keys the AA platform publishes. A key that the registry does not
// carry for the selected network yields no preset, rather than a raw hex field.
// `paramsMode` is pinned to the shipped verifier ABI by the drive: the verifier
// called with registration params must export setPublicKey(accountId, params).
const VERIFIER_PRESET_SPECS = [
  {
    id: 'web3Auth',
    registryKey: 'aaWeb3AuthVerifier',
    module: 'Web3AuthVerifier',
    paramsMode: 'publicKey',
    labelKey: 'studioPanels.createPresetWeb3AuthLabel',
    fallbackLabel: 'Web3Auth verifier',
    descriptionKey: 'studioPanels.createPresetWeb3AuthDesc',
    fallbackDescription:
      'Published Web3Auth verifier. The account public key you enter is pushed to the verifier during registration.',
  },
  {
    id: 'sessionKey',
    registryKey: 'aaSessionKeyVerifier',
    module: 'SessionKeyVerifier',
    paramsMode: 'none',
    labelKey: 'studioPanels.createPresetSessionKeyLabel',
    fallbackLabel: 'Session key verifier',
    descriptionKey: 'studioPanels.createPresetSessionKeyDesc',
    fallbackDescription:
      'Published session-key verifier. Registration takes no params; configure the session from Permissions & Limits after the account exists.',
  },
  {
    id: 'socialRecovery',
    registryKey: 'aaSocialRecoveryVerifier',
    module: 'SocialRecoveryVerifier',
    paramsMode: 'none',
    labelKey: 'studioPanels.createPresetSocialRecoveryLabel',
    fallbackLabel: 'Social recovery verifier',
    descriptionKey: 'studioPanels.createPresetSocialRecoveryDesc',
    fallbackDescription:
      'Published social-recovery verifier. Registration takes no params; configure recovery from Permissions & Limits after the account exists.',
  },
];

function isPublishedHash(value) {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
}

/**
 * The verifier presets the platform publishes for `network`. The address is the
 * registry value itself: a missing, empty or malformed entry is not offered.
 */
export function createAccountVerifierPresets(
  network,
  { registry = MORPHEUS_PUBLIC_REGISTRY, t = (_, fallback) => fallback } = {},
) {
  const contracts = registry?.[network]?.contracts || {};
  return VERIFIER_PRESET_SPECS.flatMap((spec) => {
    const verifierContract = contracts[spec.registryKey];
    if (!isPublishedHash(verifierContract)) return [];
    return [
      {
        id: spec.id,
        module: spec.module,
        registryKey: spec.registryKey,
        verifierContract,
        paramsMode: spec.paramsMode,
        label: t(spec.labelKey, spec.fallbackLabel),
        description: t(spec.descriptionKey, spec.fallbackDescription),
      },
    ];
  });
}

export function findCreateAccountVerifierPreset(presetId, network, options = {}) {
  if (!presetId) return null;
  return (
    createAccountVerifierPresets(network, options).find((preset) => preset.id === presetId) || null
  );
}

/**
 * Applies a published preset to a create form. The address comes from the
 * registry at application time, not from the caller's object, and an id the
 * network does not publish is refused without touching the form.
 */
export function applyCreateAccountVerifierPreset(form, preset, network, options = {}) {
  if (!form || typeof form !== 'object') {
    throw new TypeError('A create form is required to apply a verifier preset');
  }
  const presetId = typeof preset === 'string' ? preset : String(preset?.id || '');
  const published = findCreateAccountVerifierPreset(presetId, network, options);
  if (!published) {
    throw new TypeError(
      `Verifier preset ${presetId || '(none)'} is not published on ${network}`,
    );
  }
  form.verifierContract = published.verifierContract;
  if (published.paramsMode === 'none') form.verifierParams = '';
  else form.verifierParams = sanitizeHex(form.verifierParams || '');
  return form;
}

/**
 * The registration params the verifier address permits. The rule is selected by
 * the address, not by the last preset clicked: editing the address away from a
 * published preset returns the form to raw params. A published `none` preset
 * resolves empty whatever the form still holds, so a stale value cannot fault in
 * registration; without a matching published address the raw field is used.
 */
export function resolveCreateAccountRegistrationParams(form, network, options = {}) {
  const address = sanitizeHex(form?.verifierContract || '');
  const preset = createAccountVerifierPresets(network, options).find(
    (candidate) => sanitizeHex(candidate.verifierContract) === address,
  );
  if (preset?.paramsMode === 'none') return '';
  return sanitizeHex(form?.verifierParams || '');
}

export function buildRegisterAccountInvocation({
  accountIdHash,
  verifierHash,
  verifierParamsHex,
  hookHash,
  backupOwnerHash,
  escapeTimelockSeconds,
}) {
  return {
    operation: 'registerAccount',
    args: [
      // Display-form account id: matches the on-chain ComputeRegistrationAccountId
      // assert (the byte-reversed internal form would fault here under the
      // standard Hash160 convention).
      { type: 'Hash160', value: accountIdHash },
      { type: 'Hash160', value: verifierHash },
      { type: 'ByteArray', value: verifierParamsHex ? `0x${verifierParamsHex}` : '0x' },
      { type: 'Hash160', value: hookHash },
      { type: 'Hash160', value: backupOwnerHash },
      { type: 'Integer', value: escapeTimelockSeconds },
    ],
  };
}

/**
 * Everything the create flow needs to derive the account id and submit the
 * registration, from one pass over the form: the same params value feeds the id
 * derivation and the invocation.
 */
export function planCreateAccount(form, network, options = {}) {
  if (!form || typeof form !== 'object') {
    throw new TypeError('A create form is required to plan an account registration');
  }
  const verifierParamsHex = resolveCreateAccountRegistrationParams(form, network, options);
  const verifierHash = String(form.verifierContract || '').trim()
    ? hash160Param(form.verifierContract)
    : ZERO_HASH160;
  const hookHash = String(form.hookContract || '').trim()
    ? hash160Param(form.hookContract)
    : ZERO_HASH160;
  const backupOwnerHash = hash160Param(form.backupOwner);
  const escapeTimelockSeconds = Math.floor((Number(form.escapeTimelockDays) || 0) * 24 * 60 * 60);
  const accountIdHash = deriveRegistrationAccountIdHash({
    verifierContractHash: verifierHash,
    verifierParamsHex,
    hookContractHash: hookHash,
    backupOwnerAddress: form.backupOwner,
    escapeTimelock: escapeTimelockSeconds,
  });
  return {
    verifierHash,
    hookHash,
    backupOwnerHash,
    verifierParamsHex,
    escapeTimelockSeconds,
    accountIdHash,
    invocation: buildRegisterAccountInvocation({
      accountIdHash,
      verifierHash,
      verifierParamsHex,
      hookHash,
      backupOwnerHash,
      escapeTimelockSeconds,
    }),
  };
}
