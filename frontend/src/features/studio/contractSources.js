const CONTRACT_SOURCE_DEFINITIONS = [
  { name: 'SmartAccount.cs', loader: () => import('@/assets/contracts/SmartAccount.cs?raw') },
  { name: 'SmartAccount.Models.cs', loader: () => import('@/assets/contracts/SmartAccount.Models.cs?raw') },
  { name: 'SmartAccount.Internal.cs', loader: () => import('@/assets/contracts/SmartAccount.Internal.cs?raw') },
  { name: 'SmartAccount.Accounts.cs', loader: () => import('@/assets/contracts/SmartAccount.Accounts.cs?raw') },
  { name: 'SmartAccount.VerifierChildren.cs', loader: () => import('@/assets/contracts/SmartAccount.VerifierChildren.cs?raw') },
  { name: 'SmartAccount.State.cs', loader: () => import('@/assets/contracts/SmartAccount.State.cs?raw') },
  { name: 'SmartAccount.Execution.cs', loader: () => import('@/assets/contracts/SmartAccount.Execution.cs?raw') },
  { name: 'SmartAccount.VerifyContext.cs', loader: () => import('@/assets/contracts/SmartAccount.VerifyContext.cs?raw') },
  { name: 'SmartAccount.Escape.cs', loader: () => import('@/assets/contracts/SmartAccount.Escape.cs?raw') },
  { name: 'SmartAccount.MarketEscrow.cs', loader: () => import('@/assets/contracts/SmartAccount.MarketEscrow.cs?raw') },
  { name: 'verifiers/Web3AuthVerifier.cs', loader: () => import('@/assets/contracts/verifiers/Web3AuthVerifier.cs?raw') },
  { name: 'verifiers/TEEVerifier.cs', loader: () => import('@/assets/contracts/verifiers/TEEVerifier.cs?raw') },
  { name: 'verifiers/SessionKeyVerifier.cs', loader: () => import('@/assets/contracts/verifiers/SessionKeyVerifier.cs?raw') },
  { name: 'verifiers/WebAuthnVerifier.cs', loader: () => import('@/assets/contracts/verifiers/WebAuthnVerifier.cs?raw') },
  { name: 'verifiers/ZKEmailVerifier.cs', loader: () => import('@/assets/contracts/verifiers/ZKEmailVerifier.cs?raw') },
  { name: 'verifiers/ZkLoginVerifier.cs', loader: () => import('@/assets/contracts/verifiers/ZkLoginVerifier.cs?raw') },
  { name: 'verifiers/MultiSigVerifier.cs', loader: () => import('@/assets/contracts/verifiers/MultiSigVerifier.cs?raw') },
  { name: 'verifiers/SubscriptionVerifier.cs', loader: () => import('@/assets/contracts/verifiers/SubscriptionVerifier.cs?raw') },
  { name: 'hooks/MultiHook.cs', loader: () => import('@/assets/contracts/hooks/MultiHook.cs?raw') },
  { name: 'hooks/DailyLimitHook.cs', loader: () => import('@/assets/contracts/hooks/DailyLimitHook.cs?raw') },
  { name: 'hooks/WhitelistHook.cs', loader: () => import('@/assets/contracts/hooks/WhitelistHook.cs?raw') },
  { name: 'hooks/TokenRestrictedHook.cs', loader: () => import('@/assets/contracts/hooks/TokenRestrictedHook.cs?raw') },
  { name: 'hooks/NeoDIDCredentialHook.cs', loader: () => import('@/assets/contracts/hooks/NeoDIDCredentialHook.cs?raw') },
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
