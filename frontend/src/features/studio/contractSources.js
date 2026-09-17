const CONTRACT_SOURCE_DEFINITIONS = [
  { name: 'UnifiedSmartWallet.cs', loader: () => import('@/assets/contracts/UnifiedSmartWallet.cs?raw') },
  { name: 'UnifiedSmartWallet.Models.cs', loader: () => import('@/assets/contracts/UnifiedSmartWallet.Models.cs?raw') },
  { name: 'UnifiedSmartWallet.Internal.cs', loader: () => import('@/assets/contracts/UnifiedSmartWallet.Internal.cs?raw') },
  { name: 'UnifiedSmartWallet.Accounts.cs', loader: () => import('@/assets/contracts/UnifiedSmartWallet.Accounts.cs?raw') },
  { name: 'UnifiedSmartWallet.State.cs', loader: () => import('@/assets/contracts/UnifiedSmartWallet.State.cs?raw') },
  { name: 'UnifiedSmartWallet.Execution.cs', loader: () => import('@/assets/contracts/UnifiedSmartWallet.Execution.cs?raw') },
  { name: 'UnifiedSmartWallet.VerifyContext.cs', loader: () => import('@/assets/contracts/UnifiedSmartWallet.VerifyContext.cs?raw') },
  { name: 'UnifiedSmartWallet.Escape.cs', loader: () => import('@/assets/contracts/UnifiedSmartWallet.Escape.cs?raw') },
  { name: 'UnifiedSmartWallet.MarketEscrow.cs', loader: () => import('@/assets/contracts/UnifiedSmartWallet.MarketEscrow.cs?raw') },
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
