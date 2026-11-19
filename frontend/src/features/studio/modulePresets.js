// v4 module read templates. v4 configuration is callback-bound: the core calls
// onInstall / configure / onUninstall, so a screen may only read an installed
// module's own safe methods. The core passes `(accountId, moduleId)` as the
// first two arguments of every read, so a preset only carries what follows.
export function createModuleReadPresets(t = (_, fallback) => fallback) {
  const arg = (type, value) => ({ type, value });
  const read = (module, labelKey, descriptionKey, description, method, args = []) => ({
    module,
    label: t(labelKey, module),
    description: t(descriptionKey, description),
    method,
    args,
  });
  const validatorReads = [
    read('Any validator', 'studioPanels.readProfileLabel', 'studioPanels.readProfileDesc',
      'Read the module profile JSON the core checks on install.', 'getModuleProfile'),
    read('NeoWitnessValidator', 'studioPanels.readConfigLabel', 'studioPanels.readConfigDesc',
      'Read the instance configuration for this account and module id.', 'getConfig'),
    read('SessionKeyValidator', 'studioPanels.readSessionKeyLabel', 'studioPanels.readSessionKeyDesc',
      'Read the session key grant, its target, method and spending limit.', 'getSessionKey'),
    read('NeoWitnessValidator', 'studioPanels.readThresholdLabel', 'studioPanels.readThresholdDesc',
      'Read the witness threshold this instance enforces.', 'getThreshold'),
    read('P256Validator', 'studioPanels.readPublicKeyLabel', 'studioPanels.readPublicKeyDesc',
      'Read the P-256 public key bound to this instance.', 'getPublicKey'),
  ];
  const hookReads = [
    read('DailyLimitHook', 'studioPanels.readDailyLimitLabel', 'studioPanels.readDailyLimitDesc',
      'Read the daily limit for one token on this instance.', 'getDailyLimit', [
        arg('Hash160', '0x<token>'),
      ]),
    read('NeoDIDCredentialHook', 'studioPanels.readDIDProviderLabel', 'studioPanels.readDIDProviderDesc',
      'Read the provider this hook requires for one target contract.', 'getRequiredProvider', [
        arg('Hash160', '0x<targetContract>'),
      ]),
    read('NeoDIDCredentialHook', 'studioPanels.readDIDClaimLabel', 'studioPanels.readDIDClaimDesc',
      'Read the claim type this hook requires for one target contract.', 'getRequiredClaimType', [
        arg('Hash160', '0x<targetContract>'),
      ]),
  ];
  const commonExamples = [validatorReads[0], validatorReads[2], hookReads[0], hookReads[1]].map((value) => ({
    ...value,
    code: `method: ${value.method}\nargs after (accountId, moduleId): ${JSON.stringify(value.args, null, 2)}`,
  }));
  return { validatorReads, hookReads, commonExamples };
}

export function applyModuleReadPreset(form, preset) {
  if (!preset || typeof preset.method !== 'string') throw new TypeError('Unknown module read preset');
  const args = JSON.parse(JSON.stringify(preset.args ?? []));
  form.method = preset.method;
  form.argsJson = JSON.stringify(args, null, 2);
}
