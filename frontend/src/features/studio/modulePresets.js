// Public V3 configuration templates. Typed placeholders must be replaced before
// submission; native profile configuration has its own discovery and ABI checks.
export function createModuleConfigurationPresets(t = (_, fallback) => fallback, now = Date.now()) {
  const arg = (type, value) => ({ type, value });
  const account = () => arg('Hash160', '0x<accountId>');
  const preset = (role, module, labelKey, descriptionKey, description, method, args) => ({
    role, module, label: t(labelKey, module), description: t(descriptionKey, description), method, args,
  });
  const verifierPresets = [
    preset('verifier', 'SessionKeyVerifier', 'studioPanels.presetSessionKeyLabel', 'studioPanels.presetSessionKeyDesc',
      'Temporary delegated signer with a transfer spending limit.', 'setSessionKey', [
        account(), arg('ByteArray', '0x<sessionPubKey>'), arg('Hash160', '0x<targetContract>'),
        arg('String', 'transfer'), arg('Integer', String(now + 7 * 86400000)),
        arg('Integer', '1000000'), arg('String', 'Limited transfer session'),
      ]),
    preset('verifier', 'SubscriptionVerifier', 'studioPanels.presetSubscriptionLabel', 'studioPanels.presetSubscriptionDesc',
      'Recurring approvals for scheduled pull-style flows.', 'createSubscription', [
        account(), arg('ByteArray', '0x<subscriptionId>'), arg('Hash160', '0x<merchant>'),
        arg('Hash160', '0x<token>'), arg('Integer', '1000000'), arg('Integer', '86400'),
      ]),
    preset('verifier', 'MultiSigVerifier', 'studioPanels.presetMultiSigLabel', 'studioPanels.presetMultiSigDesc',
      'A threshold of verifier modules. Modules may share keys or controllers; this does not prove independent signers.',
      'setConfig', [
        account(), arg('Array', [arg('Hash160', '0x<childVerifier1>'), arg('Hash160', '0x<childVerifier2>')]),
        arg('Integer', '2'),
      ]),
  ];
  const hookPresets = [
    preset('hook', 'WhitelistHook', 'studioPanels.presetWhitelistLabel', 'studioPanels.presetWhitelistDesc',
      'Allow one target contract.', 'setWhitelist', [account(), arg('Hash160', '0x<targetContract>'), arg('Boolean', true)]),
    preset('hook', 'DailyLimitHook', 'studioPanels.presetDailyLimitLabel', 'studioPanels.presetDailyLimitDesc',
      'Cap daily token outflow.', 'setDailyLimit', [
        account(), arg('Hash160', '0x<token>'), arg('Integer', '1000000'), arg('Boolean', true),
      ]),
    preset('hook', 'NeoDIDCredentialHook', 'studioPanels.presetDIDLabel', 'studioPanels.presetDIDDesc',
      'Require an active NeoDID registry binding before target access.', 'requireCredentialCommitmentForContract', [
        account(), arg('Hash160', '0x<targetContract>'), arg('String', 'github'),
        arg('String', 'Github_VerifiedUser'), arg('ByteArray', '0x<32-byte-commitment>'),
      ]),
    preset('hook', 'MultiHook', 'studioPanels.presetMultiHookLabel', 'studioPanels.presetMultiHookDesc',
      'Compose multiple policy hooks behind one slot.', 'setHooks', [
        account(), arg('Array', [arg('Hash160', '0x<childHook>')]),
      ]),
  ];
  const commonExamples = [hookPresets[0], hookPresets[1], verifierPresets[0], hookPresets[2]].map(value => ({
    ...value, code: `method: ${value.method}\nargs: ${JSON.stringify(value.args, null, 2)}`,
  }));
  return { verifierPresets, hookPresets, commonExamples };
}

export function applyModuleConfigurationPreset(form, preset, now = Date.now()) {
  if (!['verifier', 'hook'].includes(preset.role)) throw new TypeError('Unknown module role');
  const args = JSON.parse(JSON.stringify(preset.args));
  const accountId = String(form.accountAddress || '').trim();
  if (/^(?:0x)?[0-9a-fA-F]{40}$/.test(accountId)) args[0].value = accountId;
  if (preset.module === 'SessionKeyVerifier') args[4].value = String(now + 7 * 86400000);
  form[`${preset.role}Method`] = preset.method;
  form[`${preset.role}ArgsJson`] = JSON.stringify(args, null, 2);
}
