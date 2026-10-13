# Custom Verifiers (Pluggable Authorization)

While the default Role structures cover 95% of use cases, the Neo Abstract Account protocol is designed to be infinitely extensible. 

Users can bypass the standard `M-of-N` signature logic by assigning a **Custom Verifier Contract**. When assigned, the Master Entry Contract defers authorization checks directly to this custom logic, then continues through the same hardened policy-gated execution path. A custom verifier does not bypass method policy, whitelist / blacklist checks, or max-transfer enforcement.

## How to Build a Custom Verifier

To create a custom verifier, developers must write and deploy a standard Neo smart contract. The contract must expose the following exact interface signature:

```csharp
using Neo;
using Neo.SmartContract.Framework;

namespace MyCustomVerifier 
{
    public class CustomVerifierContract : SmartContract
    {
        // The method MUST be named "verify" and accept a single ByteString argument
        public static bool verify(ByteString accountId)
        {
            // Extract the transaction and signers
            var tx = (Transaction)Runtime.Transaction;
            
            // ... implement custom authorization logic ...
            // Examples:
            // 1. Check if the current time is between 9 AM and 5 PM
            // 2. Validate a ZK-SNARK proof passed via transaction attributes
            // 3. Inspect Runtime.Transaction and related state before approving
            
            // Return true if authorized, false to reject
            return true; 
        }
    }
}
```

## How to Bind a Custom Verifier

Once your custom verifier contract is deployed to the Neo N3 network, you must bind it to your Abstract Account. This can only be done by an existing `Admin` of the account.

**Using the Frontend Studio:**
1. Navigate to the **Permissions & Limits** tab.
2. Locate the **Custom Verifier Contract** panel.
3. Input the Script Hash (e.g., `0xabc123...`) of your deployed verifier contract.
4. Click **Set Custom Verifier** and approve the transaction.

**Using the SDK:**
```javascript
const payload = {
  scriptHash: masterContractHash,
  operation: 'updateVerifier',
  args: [
    sc.ContractParam.hash160(myAbstractAccountAddress),
    sc.ContractParam.hash160(myCustomVerifierScriptHash),
    sc.ContractParam.byteArray('0x')
  ]
};

// Sign and invoke using the Admin's wallet
await walletService.invoke(payload);
```

`updateVerifier(accountId, newVerifier, verifierParams)` is the deployed entrypoint
(`contracts/UnifiedSmartWallet.Accounts.cs:249`, in every pinned
`contracts/build/UnifiedSmartWalletV3.manifest.json`); the studio calls it the same way in
`frontend/src/features/studio/useStudioController.js:498`. `verifierParams` is an empty `ByteArray`
for a verifier that takes no configuration.

To remove a custom verifier and fallback to the native role-based logic, simply update the verifier configuration with an empty hash (`0x0000000000000000000000000000000000000000`).

## Important Runtime Notes

- The verifier receives only `accountId`; it must derive any extra context from `Runtime.Transaction`, contract storage, or other on-chain state.
- Verifier approval does not bypass runtime restrictions such as method policy, whitelist / blacklist checks, or max-transfer limits.
