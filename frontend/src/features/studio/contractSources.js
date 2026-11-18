const CONTRACT_SOURCE_DEFINITIONS = [
  { name: 'SmartAccount.cs', loader: () => import('@/assets/contracts/custom/SmartAccount.cs?raw') },
  { name: 'SmartAccount.Admin.cs', loader: () => import('@/assets/contracts/custom/SmartAccount.Admin.cs?raw') },
  { name: 'SmartAccount.Models.cs', loader: () => import('@/assets/contracts/custom/SmartAccount.Models.cs?raw') },
  { name: 'SmartAccount.Internal.cs', loader: () => import('@/assets/contracts/custom/SmartAccount.Internal.cs?raw') },
  { name: 'SmartAccount.Accounts.cs', loader: () => import('@/assets/contracts/custom/SmartAccount.Accounts.cs?raw') },
  { name: 'SmartAccount.State.cs', loader: () => import('@/assets/contracts/custom/SmartAccount.State.cs?raw') },
  { name: 'SmartAccount.ModuleProtocol.cs', loader: () => import('@/assets/contracts/custom/SmartAccount.ModuleProtocol.cs?raw') },
  { name: 'SmartAccount.Modules.cs', loader: () => import('@/assets/contracts/custom/SmartAccount.Modules.cs?raw') },
  { name: 'SmartAccount.Execution.cs', loader: () => import('@/assets/contracts/custom/SmartAccount.Execution.cs?raw') },
  { name: 'SmartAccount.VerifyContext.cs', loader: () => import('@/assets/contracts/custom/SmartAccount.VerifyContext.cs?raw') },
  { name: 'SmartAccount.Message.cs', loader: () => import('@/assets/contracts/custom/SmartAccount.Message.cs?raw') },
  { name: 'SmartAccount.Nonce.cs', loader: () => import('@/assets/contracts/custom/SmartAccount.Nonce.cs?raw') },
  { name: 'SmartAccount.Intents.cs', loader: () => import('@/assets/contracts/custom/SmartAccount.Intents.cs?raw') },
  { name: 'SmartAccount.Escape.cs', loader: () => import('@/assets/contracts/custom/SmartAccount.Escape.cs?raw') },
  { name: 'SmartAccount.Migration.cs', loader: () => import('@/assets/contracts/custom/SmartAccount.Migration.cs?raw') },
  { name: 'SmartAccount.MarketEscrow.cs', loader: () => import('@/assets/contracts/custom/SmartAccount.MarketEscrow.cs?raw') },
  { name: 'SmartAccount.Paymaster.cs', loader: () => import('@/assets/contracts/custom/SmartAccount.Paymaster.cs?raw') },
  { name: 'SmartAccount.PlatformRegistrar.cs', loader: () => import('@/assets/contracts/custom/SmartAccount.PlatformRegistrar.cs?raw') },
  { name: 'SmartAccount.Proxy.cs', loader: () => import('@/assets/contracts/custom/SmartAccount.Proxy.cs?raw') },
  { name: 'SmartAccount.Events.cs', loader: () => import('@/assets/contracts/custom/SmartAccount.Events.cs?raw') },
  { name: 'validators/Web3AuthValidator.cs', loader: () => import('@/assets/contracts/plugins/validators/Web3AuthValidator.cs?raw') },
  { name: 'validators/TeeKeyValidator.cs', loader: () => import('@/assets/contracts/plugins/validators/TeeKeyValidator.cs?raw') },
  { name: 'validators/SessionKeyValidator.cs', loader: () => import('@/assets/contracts/plugins/validators/SessionKeyValidator.cs?raw') },
  { name: 'validators/P256Validator.cs', loader: () => import('@/assets/contracts/plugins/validators/P256Validator.cs?raw') },
  { name: 'validators/ZKEmailVerifier.cs', loader: () => import('@/assets/contracts/plugins/validators/ZKEmailVerifier.cs?raw') },
  { name: 'validators/DelegatedIdentityValidator.cs', loader: () => import('@/assets/contracts/plugins/validators/DelegatedIdentityValidator.cs?raw') },
  { name: 'validators/MultiSigValidator.cs', loader: () => import('@/assets/contracts/plugins/validators/MultiSigValidator.cs?raw') },
  { name: 'validators/SubscriptionValidator.cs', loader: () => import('@/assets/contracts/plugins/validators/SubscriptionValidator.cs?raw') },
  { name: 'validators/NeoWitnessValidator.cs', loader: () => import('@/assets/contracts/plugins/validators/NeoWitnessValidator.cs?raw') },
  { name: 'hooks/DailyLimitHook.cs', loader: () => import('@/assets/contracts/plugins/hooks/DailyLimitHook.cs?raw') },
  { name: 'hooks/WhitelistHook.cs', loader: () => import('@/assets/contracts/plugins/hooks/WhitelistHook.cs?raw') },
  { name: 'hooks/TokenRestrictedHook.cs', loader: () => import('@/assets/contracts/plugins/hooks/TokenRestrictedHook.cs?raw') },
  { name: 'hooks/NeoDIDCredentialHook.cs', loader: () => import('@/assets/contracts/plugins/hooks/NeoDIDCredentialHook.cs?raw') },
  { name: 'hooks/MultiHook.cs', loader: () => import('@/assets/contracts/plugins/hooks/MultiHook.cs?raw') },
];

const contractSourceCache = new Map();

export async function loadContractSourceFiles() {
  return Promise.all(
    CONTRACT_SOURCE_DEFINITIONS.map(async ({ name, loader }) => {
      if (!contractSourceCache.has(name)) {
        contractSourceCache.set(
          name,
          Promise.resolve(loader()).then((module) => module?.default || module || ''),
        );
      }

      return {
        name,
        content: await contractSourceCache.get(name),
      };
    }),
  );
}
