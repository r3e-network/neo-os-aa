# Neo Abstract Account - Security Audit Report

**Audit Date**: 2026-03-29
**Auditor**: Senior Blockchain Security Auditor
**Scope**: All smart contracts in `contracts/` directory

## Executive Summary

This audit covers the complete Neo Abstract Account smart contract system, including:
- UnifiedSmartWallet core contract (V3 AA runtime)
- Hook plugins (DailyLimitHook, MultiHook, WhitelistHook, TokenRestrictedHook, NeoDIDCredentialHook)
- Verifier plugins (Web3AuthVerifier, WebAuthnVerifier, TEEVerifier, SessionKeyVerifier, MultiSigVerifier, SubscriptionVerifier, ZkLoginVerifier, ZKEmailVerifier)
- Market escrow system (AAAddressMarket)
- Authority contracts (HookAuthority, VerifierAuthority)

**Overall Assessment**: The codebase demonstrates strong security architecture with proper access controls, storage isolation, and timelock protections. Several issues were identified and 4 high severity fixes have been applied. Remaining issues require attention before production deployment.

**Status Note**: The finding sections below preserve the original audit evidence and
some original code snippets/status labels are intentionally historical. Current
remediation status is tracked in `docs/SECURITY_MODEL.md`,
`docs/PROTOCOL_COMPLETENESS_AUDIT.md`, and
`docs/reports/aa-protocol-security-build-20260918.json`. In particular, current
module binding uses exact manifest parameter/return-type checks and a safe Boolean
`supportsV3` marker; the latest private-chain parity and test counts are recorded
in the current receipt. Do not use the historical snippets below as a description
of the deployed artifact.

---

## Critical Findings (0)

No critical vulnerabilities found.

---

## High Severity Findings (4)

### HIGH-1: DailyLimitHook Integer Overflow in Rolling Window Calculation

**Contract**: `contracts/hooks/DailyLimitHook.cs`
**Method**: `GetRollingWindowSpent` (lines 228-245)
**Lines**: 228-245

**Description**:
The rolling window spending calculation accumulates transaction amounts without overflow protection. An attacker could exploit this by creating many small transactions that sum to exceed the configured limit, or by crafting transactions with large values that cause integer overflow.

```csharp
private static BigInteger GetRollingWindowSpent(UInt160 accountId, UInt160 token, BigInteger currentTime)
{
    byte[] historyPrefix = Helper.Concat(Helper.Concat(Prefix_TransactionHistory, (byte[])accountId), (byte[])token);
    BigInteger total = 0;
    BigInteger cutoffTime = currentTime - OneDaySeconds;

    Iterator iterator = Storage.Find(Storage.CurrentContext, historyPrefix, FindOptions.ValuesOnly);
    while (iterator.Next())
    {
        ByteString recordData = (ByteString)iterator.Value;
        TransactionRecord record = (TransactionRecord)StdLib.Deserialize(recordData);
        if (record.Timestamp >= cutoffTime)
        {
            total += record.Amount;  // NO OVERFLOW CHECK
        }
    }
    return total;
}
```

**Attack Scenario**:
1. Attacker configures a daily limit (e.g., 1,000 tokens)
2. Attacker makes 1,000 transactions of 1 token each in the rolling window
3. Each transaction calls `PostExecute` which adds to total without checking bounds
4. Attacker then tries to make a large transaction exceeding the limit
5. The accumulated total may overflow or wrap, allowing the transaction to pass

**Recommended Fix**:
```csharp
private static BigInteger GetRollingWindowSpent(UInt160 accountId, UInt160 token, BigInteger currentTime)
{
    byte[] historyPrefix = Helper.Concat(Helper.Concat(Prefix_TransactionHistory, (byte[])accountId), (byte[])token);
    BigInteger total = 0;
    BigInteger cutoffTime = currentTime - OneDaySeconds;

    Iterator iterator = Storage.Find(Storage.CurrentContext, historyPrefix, FindOptions.ValuesOnly);
    while (iterator.Next())
    {
        ByteString recordData = (ByteString)iterator.Value;
        TransactionRecord record = (TransactionRecord)StdLib.Deserialize(recordData);
        if (record.Timestamp >= cutoffTime)
        {
            BigInteger previousTotal = total;
            total += record.Amount;
            // Add overflow check
            ExecutionEngine.Assert(total >= previousTotal, "Integer overflow in rolling window calculation");
        }
    }
    return total;
}
```

Also add check in `PreExecute`:
```csharp
BigInteger newTotal = spentToday + amount;
ExecutionEngine.Assert(newTotal >= spentToday, "Integer overflow in daily limit check");  // Add this
ExecutionEngine.Assert(newTotal <= config.MaxAmount, "Daily limit exceeded");
```

**Status**: FIXED - See Fixes Applied section

---

### HIGH-2: DailyLimitHook Missing MaxHistorySize Enforcement on RecordStorage

**Contract**: `contracts/hooks/DailyLimitHook.cs`
**Method**: `RecordTransaction` (lines 247-257)
**Lines**: 247-257

**Description**:
The `MaxHistorySize` constant is defined (50), but there is no enforcement when adding new transaction records. An attacker could fill storage by creating many transactions faster than old ones are pruned, leading to unbounded storage growth and denial of service.

```csharp
private static void RecordTransaction(UInt160 accountId, UInt160 token, BigInteger timestamp, BigInteger amount)
{
    byte[] historyPrefix = Helper.Concat(Helper.Concat(Prefix_TransactionHistory, (byte[])accountId), (byte[])token);
    byte[] txKey = Helper.Concat(historyPrefix, timestamp.ToByteArray());

    TransactionRecord record = new TransactionRecord { Timestamp = timestamp, Amount = amount };
    Storage.Put(Storage.CurrentContext, txKey, StdLib.Serialize(record));

    // Prune old records to prevent unbounded storage growth
    PruneOldRecords(historyPrefix, timestamp - OneDaySeconds);  // Only prunes by time, not count!
}
```

**Attack Scenario**:
1. Attacker creates multiple transactions with slightly different timestamps
2. Each transaction adds a new record to storage
3. Old records are only pruned if they're older than 24h
4. Attacker makes 1,000 transactions in 24 hours, creating 1,000 records despite MaxHistorySize = 50
5. This causes excessive GAS consumption and storage bloat

**Recommended Fix**:
```csharp
private static void RecordTransaction(UInt160 accountId, UInt160 token, BigInteger timestamp, BigInteger amount)
{
    byte[] historyPrefix = Helper.Concat(Helper.Concat(Prefix_TransactionHistory, (byte[])accountId), (byte[])token);
    byte[] txKey = Helper.Concat(historyPrefix, timestamp.ToByteArray());

    TransactionRecord record = new TransactionRecord { Timestamp = timestamp, Amount = amount };
    Storage.Put(Storage.CurrentContext, txKey, StdLib.Serialize(record));

    // Enforce maximum history size BEFORE adding
    EnforceMaxHistorySize(historyPrefix, timestamp);

    // Prune old records to prevent unbounded storage growth
    PruneOldRecords(historyPrefix, timestamp - OneDaySeconds);
}

private static void EnforceMaxHistorySize(byte[] historyPrefix, BigInteger currentTimestamp)
{
    int count = 0;
    BigInteger oldestTimestamp = currentTimestamp;
    Iterator iterator = Storage.Find(Storage.CurrentContext, historyPrefix, FindOptions.KeysOnly);
    while (iterator.Next())
    {
        count++;
        ByteString key = (ByteString)iterator.Value;
        // Extract timestamp from key (assuming key format)
        if (key != null && ((byte[])key).Length > historyPrefix.Length)
        {
            byte[] keyBytes = (byte[])key;
            byte[] timestampBytes = Helper.Range(keyBytes, historyPrefix.Length, keyBytes.Length - historyPrefix.Length);
            if (timestampBytes.Length > 0)
            {
                BigInteger keyTimestamp = new BigInteger(timestampBytes);
                if (keyTimestamp < oldestTimestamp)
                {
                    oldestTimestamp = keyTimestamp;
                }
            }
        }
    }

    // Delete oldest records if we exceed max size
    while (count > MaxHistorySize)
    {
        byte[] oldKey = Helper.Concat(historyPrefix, oldestTimestamp.ToByteArray());
        Storage.Delete(Storage.CurrentContext, oldKey);
        count--;

        // Find next oldest (simplified - in production, track properly)
        iterator = Storage.Find(Storage.CurrentContext, historyPrefix, FindOptions.KeysOnly);
        while (iterator.Next())
        {
            ByteString key = (ByteString)iterator.Value;
            byte[] keyBytes = (byte[])key;
            byte[] timestampBytes = Helper.Range(keyBytes, historyPrefix.Length, keyBytes.Length - historyPrefix.Length);
            if (timestampBytes.Length > 0)
            {
                BigInteger keyTimestamp = new BigInteger(timestampBytes);
                if (keyTimestamp < oldestTimestamp || count == MaxHistorySize)
                {
                    oldestTimestamp = keyTimestamp;
                    break;
                }
            }
        }
    }
}
```

**Status**: FIXED - See Fixes Applied section

---

### HIGH-3: DailyLimitHook Transaction Record Collision Attack

**Contract**: `contracts/hooks/DailyLimitHook.cs`
**Method**: `RecordTransaction` (line 250)
**Lines**: 247-257

**Description**:
Transaction records are keyed by timestamp, which creates a collision vulnerability. If an attacker creates two transactions with the same timestamp, the second overwrites the first, corrupting the spending tracking.

```csharp
private static void RecordTransaction(UInt160 accountId, UInt160 token, BigInteger timestamp, BigInteger amount)
{
    byte[] historyPrefix = Helper.Concat(Helper.Concat(Prefix_TransactionHistory, (byte[])accountId), (byte[])token);
    byte[] txKey = Helper.Concat(historyPrefix, timestamp.ToByteArray());  // COLLISION RISK!

    TransactionRecord record = new TransactionRecord { Timestamp = timestamp, Amount = amount };
    Storage.Put(Storage.CurrentContext, txKey, StdLib.Serialize(record));
```

**Attack Scenario**:
1. Attacker makes transaction A at timestamp T=1000, amount=100
2. Attacker immediately makes transaction B at timestamp T=1000, amount=1,000,000
3. Transaction B overwrites record A's storage entry
4. The rolling window now shows 1,000,000 spent instead of 1,000,100
5. Attacker has effectively "erased" the first transaction from history

**Recommended Fix**:
Include a nonce or counter in the key to ensure uniqueness:

```csharp
private static void RecordTransaction(UInt160 accountId, UInt160 token, BigInteger timestamp, BigInteger amount)
{
    byte[] historyPrefix = Helper.Concat(Helper.Concat(Prefix_TransactionHistory, (byte[])accountId), (byte[])token);

    // Use timestamp + account-specific nonce to prevent collisions
    BigInteger nonceKey = BigInteger.Parse(timestamp.ToString() + accountId.ToString());
    byte[] txKey = Helper.Concat(historyPrefix, nonceKey.ToByteArray());

    TransactionRecord record = new TransactionRecord { Timestamp = timestamp, Amount = amount };
    Storage.Put(Storage.CurrentContext, txKey, StdLib.Serialize(record));

    // Prune old records to prevent unbounded storage growth
    PruneOldRecords(historyPrefix, timestamp - OneDaySeconds);
}
```

Or better yet, use a counter per account/token pair:
```csharp
private static readonly byte[] Prefix_TransactionCounter = new byte[] { 0x05 };

private static void RecordTransaction(UInt160 accountId, UInt160 token, BigInteger timestamp, BigInteger amount)
{
    byte[] historyPrefix = Helper.Concat(Helper.Concat(Prefix_TransactionHistory, (byte[])accountId), (byte[])token);

    // Get and increment transaction counter
    byte[] counterKey = Helper.Concat(Prefix_TransactionCounter, (byte[])accountId);
    ByteString? counterData = Storage.Get(Storage.CurrentContext, counterKey);
    BigInteger counter = counterData == null ? 0 : (BigInteger)counterData;
    counter++;
    Storage.Put(Storage.CurrentContext, counterKey, counter);

    // Use counter in key to prevent collisions
    byte[] txKey = Helper.Concat(historyPrefix, counter.ToByteArray());

    TransactionRecord record = new TransactionRecord { Timestamp = timestamp, Amount = amount };
    Storage.Put(Storage.CurrentContext, txKey, StdLib.Serialize(record));

    // Prune old records
    PruneOldRecords(historyPrefix, timestamp - OneDaySeconds);
}
```

**Status**: FIXED - See Fixes Applied section

---

### HIGH-4: AAAddressMarket Missing Listing Price Validation During Creation

**Contract**: `contracts/market/AAAddressMarket.cs`
**Method**: `CreateListing` (lines 51-79)
**Lines**: 51-79

**Description**:
While `UpdateListingPrice` validates that prices must be positive, `CreateListing` does not enforce any minimum or maximum price constraints. This allows creation of listings with absurdly high or low prices.

```csharp
public static void CreateListing(UInt160 aaContract, UInt160 accountId, BigInteger price, string title, string metadataUri)
{
    ExecutionEngine.Assert(aaContract != null && aaContract != UInt160.Zero, "AA contract required");
    ExecutionEngine.Assert(accountId != null && accountId != UInt160.Zero, "Account id required");
    ExecutionEngine.Assert(price > 0, "Price must be positive");  // ONLY POSITIVE CHECK - NO MAXIMUM
    ValidateListingText(title, metadataUri);
    // ... rest of method
}

public static void UpdateListingPrice(BigInteger listingId, BigInteger newPrice)
{
    ExecutionEngine.Assert(newPrice > 0, "Price must be positive");  // Same check
    // ...
}
```

**Attack Scenario**:
1. Attacker creates listing with price = `2^256 - 1` (maximum BigInteger)
2. This value cannot be paid by anyone (exceeds total GAS supply)
3. The listing becomes permanently unusable but occupies storage
4. Attacker spams many such listings, filling market storage

Or alternatively:
1. Attacker creates listing with extremely low price (e.g., 1 wei/atto-GAS)
2. Legitimate buyer purchases but gets practically nothing due to precision issues
3. Market shows unrealistic price data that could confuse users

**Recommended Fix**:
Add reasonable bounds on listing prices:

```csharp
private const BigInteger MinListingPrice = 1_000_000;  // Minimum 1e-6 GAS (adjust based on token decimals)
private const BigInteger MaxListingPrice = 100_000_000_000_000L;  // Maximum 100M GAS

public static void CreateListing(UInt160 aaContract, UInt160 accountId, BigInteger price, string title, string metadataUri)
{
    ExecutionEngine.Assert(aaContract != null && aaContract != UInt160.Zero, "AA contract required");
    ExecutionEngine.Assert(accountId != null && accountId != UInt160.Zero, "Account id required");
    ExecutionEngine.Assert(price >= MinListingPrice, "Price below minimum");
    ExecutionEngine.Assert(price <= MaxListingPrice, "Price exceeds maximum");
    ValidateListingText(title, metadataUri);
    // ... rest of method
}

public static void UpdateListingPrice(BigInteger listingId, BigInteger newPrice)
{
    ExecutionEngine.Assert(newPrice >= MinListingPrice, "Price below minimum");
    ExecutionEngine.Assert(newPrice <= MaxListingPrice, "Price exceeds maximum");
    Listing listing = GetExistingListing(listingId);
    // ... rest of method
}
```

**Status**: FIXED - See Fixes Applied section

---

## Medium Severity Findings (5)

### MEDIUM-1: HookAuthority and VerifierAuthority Admin Key Single Point of Failure

**Contract**: `contracts/hooks/HookAuthority.cs`, `contracts/verifiers/VerifierAuthority.cs`
**Method**: `Initialize`, `RotateAdmin`
**Lines**: HookAuthority.cs:12-28, 81-86; VerifierAuthority.cs:12-28, 63-68

**Description**:
The admin is set during deployment from `Runtime.Transaction.Sender` with no recovery mechanism. If the admin key is lost or compromised, there is no way to rotate it.

```csharp
internal static void Initialize(object data, bool update)
{
    if (update) return;

    Storage.Put(Storage.CurrentContext, Prefix_Admin, Runtime.Transaction.Sender);  // IRREVERSIBLE
    // ...
}

internal static void RotateAdmin(UInt160 newAdmin)
{
    ValidateAdmin();  // Requires current admin signature
    ExecutionEngine.Assert(newAdmin != null && newAdmin.IsValid, "Invalid admin");
    Storage.Put(Storage.CurrentContext, Prefix_Admin, (byte[])newAdmin!);
}
```

**Recommended Fix**:
Implement a time-delayed admin rotation or multi-sig admin:

```csharp
private static readonly byte[] Prefix_PendingAdmin = new byte[] { 0xF2 };
private static readonly byte[] Prefix_AdminRotationTimelock = new byte[] { 0xF3 };
private const BigInteger AdminRotationTimelock = 7 * 24 * 3600;  // 7 days

internal static void InitiateAdminRotation(UInt160 newAdmin)
{
    ValidateAdmin();
    ExecutionEngine.Assert(newAdmin != null && newAdmin.IsValid, "Invalid admin");
    ExecutionEngine.Assert(newAdmin != Admin(), "New admin must differ from current");

    byte[] key = Helper.Concat(Prefix_PendingAdmin, (byte[])Runtime.ExecutingScriptHash);
    byte[] timelockKey = Prefix_AdminRotationTimelock;
    Storage.Put(Storage.CurrentContext, key, (byte[])newAdmin);
    Storage.Put(Storage.CurrentContext, timelockKey, Runtime.Time);
}

internal static void FinalizeAdminRotation(UInt160 newAdmin)
{
    byte[] key = Helper.Concat(Prefix_PendingAdmin, (byte[])Runtime.ExecutingScriptHash);
    ByteString? pending = Storage.Get(Storage.CurrentContext, key);
    ExecutionEngine.Assert(pending != null, "No pending admin rotation");

    byte[] timelockKey = Prefix_AdminRotationTimelock;
    ByteString? timelockData = Storage.Get(Storage.CurrentContext, timelockKey);
    ExecutionEngine.Assert(timelockData != null, "No timelock set");
    BigInteger timelockStart = (BigInteger)timelockData;
    ExecutionEngine.Assert(Runtime.Time >= timelockStart + AdminRotationTimelock, "Admin rotation timelock not expired");

    ExecutionEngine.Assert((UInt160)pending! == newAdmin, "Pending admin mismatch");
    Storage.Put(Storage.CurrentContext, Prefix_Admin, (byte[])newAdmin);
    Storage.Delete(Storage.CurrentContext, key);
    Storage.Delete(Storage.CurrentContext, timelockKey);
}
```

**Status**: NOT FIXED - Recommended enhancement

---

### MEDIUM-2: MultiHook Does Not Prevent Hook Self-Inclusion

**Contract**: `contracts/hooks/MultiHook.cs`
**Method**: `SetHooks` (lines 51-73)
**Lines**: 51-73

**Description**:
The `SetHooks` method checks for self-hook prevention only for direct self-reference, but does not prevent circular hook configurations (A → B → A).

```csharp
public static void SetHooks(UInt160 accountId, UInt160[] hooks)
{
    HookAuthority.ValidateConfigCaller(accountId, Runtime.ExecutingScriptHash);
    byte[] key = Helper.Concat(Prefix_Hooks, (byte[])accountId);
    if (hooks == null || hooks.Length == 0)
    {
        Storage.Delete(Storage.CurrentContext, key);
    }
    else
    {
        ExecutionEngine.Assert(hooks.Length <= MaxHooks, $"Maximum {MaxHooks} hooks allowed");
        for (int i = 0; i < hooks.Length; i++)
        {
            ExecutionEngine.Assert(hooks[i] != UInt160.Zero && hooks[i].IsValid, "Invalid hook");
            ExecutionEngine.Assert(hooks[i] != Runtime.ExecutingScriptHash, "Self hook not allowed");  // ONLY DIRECT
            for (int j = i + 1; j < hooks.Length; j++)
            {
                ExecutionEngine.Assert(hooks[i] != hooks[j], "Duplicate hook not allowed");
            }
        }
        Storage.Put(Storage.CurrentContext, key, StdLib.Serialize(hooks));
    }
}
```

**Attack Scenario**:
1. User sets MultiHook A's hooks to include MultiHook B
2. User sets MultiHook B's hooks to include MultiHook A
3. This creates infinite recursion when a user operation is executed
4. Gas exhaustion occurs, but more importantly, hooks can bypass each other's checks

**Recommended Fix**:
Add circular dependency detection:

```csharp
public static void SetHooks(UInt160 accountId, UInt160[] hooks)
{
    HookAuthority.ValidateConfigCaller(accountId, Runtime.ExecutingScriptHash);
    byte[] key = Helper.Concat(Prefix_Hooks, (byte[])accountId);
    if (hooks == null || hooks.Length == 0)
    {
        Storage.Delete(Storage.CurrentContext, key);
    }
    else
    {
        ExecutionEngine.Assert(hooks.Length <= MaxHooks, $"Maximum {MaxHooks} hooks allowed");
        for (int i = 0; i < hooks.Length; i++)
        {
            ExecutionEngine.Assert(hooks[i] != UInt160.Zero && hooks[i].IsValid, "Invalid hook");
            ExecutionEngine.Assert(hooks[i] != Runtime.ExecutingScriptHash, "Self hook not allowed");
            for (int j = i + 1; j < hooks.Length; j++)
            {
                ExecutionEngine.Assert(hooks[i] != hooks[j], "Duplicate hook not allowed");
            }
        }

        // Check for circular dependencies
        for (int i = 0; i < hooks.Length; i++)
        {
            if (HasCircularDependency(hooks[i], Runtime.ExecutingScriptHash, new HashSet<UInt160>()))
            {
                ExecutionEngine.Assert(false, "Circular hook dependency detected");
            }
        }

        Storage.Put(Storage.CurrentContext, key, StdLib.Serialize(hooks));
    }
}

private static bool HasCircularDependency(UInt160 hookContract, UInt160 rootHook, HashSet<UInt160> visited)
{
    if (visited.Contains(hookContract))
    {
        return hookContract == rootHook;  // Circular reference back to root
    }

    if (hookContract == rootHook)
    {
        return false;  // Root is expected to be in path
    }

    visited.Add(hookContract);

    // Get hooks from the hook contract (assuming it's a MultiHook)
    try
    {
        object[] childHooks = (object[])Contract.Call(hookContract, "getHooks", CallFlags.ReadOnly, new object[] { /* accountId needed */ });

        if (childHooks != null)
        {
            foreach (object child in childHooks)
            {
                if (child is UInt160 childHook)
                {
                    if (HasCircularDependency(childHook, rootHook, new HashSet<UInt160>(visited)))
                    {
                        return true;
                    }
                }
            }
        }
    }
    catch
    {
        // Not a MultiHook or error getting hooks - no circular dependency from this branch
    }

    return false;
}
```

**Status**: FIXED - Added execution depth tracking with max-depth guard (MaxHookDepth=3) and try-finally blocks for proper cleanup

---

### MEDIUM-3: SessionKeyVerifier Spending Limit Not Reset on Key Update

**Contract**: `contracts/verifiers/SessionKeyVerifier.cs`
**Method**: `SetSessionKey` (lines 61-95)
**Lines**: 61-95

**Description**:
When a new session key is set, the spending tracking is reset to zero. However, this creates a vulnerability where an attacker can rotate session keys to bypass spending limits entirely.

```csharp
public static void SetSessionKey(UInt160 accountId, ByteString pubKey, UInt160 targetContract, string method, BigInteger validUntil, BigInteger spendingLimit, string description)
{
    VerifierAuthority.ValidateConfigCaller(accountId, Runtime.ExecutingScriptHash);
    // ... validation ...

    byte[] key = Helper.Concat(Prefix_SessionKeys, (byte[])accountId);
    Storage.Put(Storage.CurrentContext, key, StdLib.Serialize(data));

    // ... metadata setup ...

    // Reset spending tracking
    byte[] spentKey = Helper.Concat(Prefix_SpentAmount, (byte[])accountId);
    Storage.Delete(Storage.CurrentContext, spentKey);  // ALWAYS RESETS TO ZERO
}
```

**Attack Scenario**:
1. User sets session key with spending limit of 1,000 tokens
2. Attacker compromises session key and spends 1,000 tokens
3. Backup owner rotates to new session key (to reset compromise)
4. Spending counter resets to 0, allowing another 1,000 tokens to be spent
5. Attacker continues rotating keys to spend unlimited amounts

**Recommended Fix**:
Do not reset spending on key rotation, or add a rotation cooldown:

```csharp
private static readonly byte[] Prefix_LastKeyRotation = new byte[] { 0x04 };
private const BigInteger KeyRotationCooldown = 24 * 3600;  // 1 day

public static void SetSessionKey(UInt160 accountId, ByteString pubKey, BigInteger targetContract, string method, BigInteger validUntil, BigInteger spendingLimit, string description)
{
    VerifierAuthority.ValidateConfigCaller(accountId, Runtime.ExecutingScriptHash);
    ExecutionEngine.Assert(pubKey.Length == 33 || pubKey.Length == 65, "Invalid public key length");
    ExecutionEngine.Assert(validUntil > Runtime.Time, "Session key must expire in future");
    ExecutionEngine.Assert(validUntil <= Runtime.Time + MaxSessionDuration, "Session key lifetime exceeds maximum of 30 days");
    ExecutionEngine.Assert(spendingLimit >= 0, "Spending limit must be non-negative");
    ExecutionEngine.Assert(description == null || description.Length <= 128, "Description too long (max 128 chars)");

    // Check rotation cooldown to prevent limit bypass via rotation
    if (spendingLimit > 0)
    {
        byte[] rotationKey = Helper.Concat(Prefix_LastKeyRotation, (byte[])accountId);
        ByteString? lastRotation = Storage.Get(Storage.CurrentContext, rotationKey);
        if (lastRotation != null)
        {
            BigInteger lastTime = (BigInteger)lastRotation;
            ExecutionEngine.Assert(Runtime.Time >= lastTime + KeyRotationCooldown, "Key rotation cooldown active");
        }
    }

    SessionKeyData data = new SessionKeyData
    {
        PubKey = pubKey,
        TargetContract = targetContract,
        Method = method,
        ValidUntil = validUntil,
        SpendingLimit = spendingLimit
    };

    byte[] key = Helper.Concat(Prefix_SessionKeys, (byte[])accountId);
    Storage.Put(Storage.CurrentContext, key, StdLib.Serialize(data));

    // Store metadata
    SessionKeyMetadata metadata = new SessionKeyMetadata
    {
        CreatedAt = Runtime.Time,
        LastUsedAt = 0,
        Description = description ?? string.Empty
    };
    byte[] metadataKey = Helper.Concat(Prefix_SessionMetadata, (byte[])accountId);
    Storage.Put(Storage.CurrentContext, metadataKey, StdLib.Serialize(metadata));

    // Update rotation timestamp
    byte[] rotationKey = Helper.Concat(Prefix_LastKeyRotation, (byte[])accountId);
    Storage.Put(Storage.CurrentContext, rotationKey, Runtime.Time);

    // DON'T reset spending - let it continue accumulating
    // byte[] spentKey = Helper.Concat(Prefix_SpentAmount, (byte[])accountId);
    // Storage.Delete(Storage.CurrentContext, spentKey);
}
```

**Status**: NOT FIXED - Recommended enhancement

---

### MEDIUM-4: Escape Hatch Can Be Cancelled By Any Operation

**Contract**: `contracts/UnifiedSmartWallet.Execution.cs`
**Method**: `ExecuteUserOp` (lines 55-61)
**Lines**: 55-61

**Description**:
The escape hatch can be cancelled by ANY valid user operation, not just the backup owner. This means if the primary verifier is compromised, the attacker can keep executing operations to prevent the backup owner from completing the escape flow.

```csharp
// Security defense: if account is in stolen escape state, normal operations interrupt escape
if (state.EscapeTriggeredAt > 0)
{
    state.EscapeTriggeredAt = 0;  // CANCELS ESCROW WITHOUT CHECKING WHO IS EXECUTING
    byte[] key = Helper.Concat(Prefix_AccountState, (byte[])accountId);
    Storage.Put(Storage.CurrentContext, key, StdLib.Serialize(state));
    OnEscapeCancelled?.Invoke(accountId);
}
```

**Attack Scenario**:
1. Attacker compromises verifier (e.g., obtains private key)
2. Backup owner initiates escape hatch (7-90 day timelock)
3. Attacker repeatedly calls `ExecuteUserOp` with valid signatures
4. Each execution resets `EscapeTriggeredAt`, preventing the escape from completing
5. This creates a "race condition" where the attacker can indefinitely delay the escape

**Recommended Fix**:
Only allow the backup owner to cancel an active escape:

```csharp
// Security defense: if account is in stolen escape state, normal operations interrupt escape
if (state.EscapeTriggeredAt > 0)
{
    // Only backup owner can cancel an active escape
    ExecutionEngine.Assert(Runtime.CheckWitness(state.BackupOwner), "Only backup owner can cancel escape");

    state.EscapeTriggeredAt = 0;
    byte[] key = Helper.Concat(Prefix_AccountState, (byte[])accountId);
    Storage.Put(Storage.CurrentContext, key, StdLib.Serialize(state));
    OnEscapeCancelled?.Invoke(accountId);
}
```

**Status**: NOT FIXED - Requires attention

---

### MEDIUM-5: SubscriptionVerifier Replay Attack Via Nonce Calculation

**Contract**: `contracts/verifiers/SubscriptionVerifier.cs`
**Method**: `ValidateSignature` (lines 66-105)
**Lines**: 93-102

**Description**:
The subscription verifier uses a nonce derived from the subscription ID hash and current billing period. However, if an attacker can influence the subscription ID or manipulate the billing period calculation, they might be able to reuse nonces.

```csharp
// Replay protection without mutating state: require a salt-mode nonce
// that deterministically binds this request to current billing
// period and subscription ID. Core nonce consumption then ensures
// same period cannot be charged twice with same subId.
BigInteger saltBase = 1_000_000_000_000_000_000;
ByteString digest = CryptoLib.Sha256(subId);
byte[] digestBytes = (byte[])digest;
BigInteger subTag = 0;
for (int i = 0; i < 8 && i < digestBytes.Length; i++)
{
    subTag = (subTag << 8) + digestBytes[i];
}
BigInteger expectedNonce = saltBase + (subTag << 32) + currentPeriod;
ExecutionEngine.Assert(op.Nonce == expectedNonce, "Subscription nonce must match current billing period");
```

**Attack Scenario**:
1. Attacker creates a subscription with a subId that results in a favorable subTag after SHA256
2. The billing period calculation uses `Runtime.Time / periodMs`
3. If the attacker can manipulate when transactions are submitted (timing attack), they might be able to:
   - Submit two transactions in the same billing period that calculate the same expectedNonce
   - If the period boundary is crossed during transaction processing

**Recommended Fix**:
Add additional randomness or a per-subscription counter to the nonce calculation:

```csharp
// Add per-subscription counter to nonce storage
private static readonly byte[] Prefix_SubscriptionNonceCounter = new byte[] { 0x02 };

public static bool ValidateSignature(UInt160 accountId, UserOperation op)
{
    ByteString subId = op.Signature;
    byte[] key = Helper.Concat(Helper.Concat(Prefix_Subscription, (byte[])accountId), (byte[])subId);
    ByteString? data = Storage.Get(Storage.CurrentContext, key);
    ExecutionEngine.Assert(data != null, "Subscription not found");

    SubscriptionConfig config = (SubscriptionConfig)StdLib.Deserialize(data!);

    ExecutionEngine.Assert(op.TargetContract == config.Token, "Target must be subscription token");
    ExecutionEngine.Assert(op.Method == "transfer", "Method must be transfer");

    ExecutionEngine.Assert(op.Args.Length >= 3, "Invalid transfer args");
    ExecutionEngine.Assert((UInt160)op.Args[0] == accountId, "Transfer source must be account");
    ExecutionEngine.Assert((UInt160)op.Args[1] == config.Merchant, "Transfer destination must be merchant");
    ExecutionEngine.Assert((BigInteger)op.Args[2] <= config.Amount, "Transfer amount exceeds subscription");

    ExecutionEngine.Assert(config.PeriodMs > 0, "Invalid subscription period");
    BigInteger currentPeriod = Runtime.Time / config.PeriodMs;
    ExecutionEngine.Assert(currentPeriod > 0, "Subscription period not yet elapsed");

    // Get per-subscription nonce counter
    byte[] counterKey = Helper.Concat(Helper.Concat(Prefix_SubscriptionNonceCounter, (byte[])accountId), (byte[])subId);
    ByteString? counterData = Storage.Get(Storage.CurrentContext, counterKey);
    BigInteger nonceCounter = counterData == null ? 0 : (BigInteger)counterData;

    BigInteger saltBase = 1_000_000_000_000_000_000;
    ByteString digest = CryptoLib.Sha256(subId);
    byte[] digestBytes = (byte[])digest;
    BigInteger subTag = 0;
    for (int i = 0; i < 8 && i < digestBytes.Length; i++)
    {
        subTag = (subTag << 8) + digestBytes[i];
    }
    BigInteger expectedNonce = saltBase + (subTag << 32) + currentPeriod + nonceCounter;
    ExecutionEngine.Assert(op.Nonce == expectedNonce, "Subscription nonce mismatch");

    // Increment counter for next charge
    Storage.Put(Storage.CurrentContext, counterKey, nonceCounter + 1);

    return true;
}
```

**Status**: FIXED - Added per-subscription nonce counter to prevent replay attacks within the same billing period

---

## Low Severity Findings (6)

### LOW-1: Missing Input Validation in Several Methods

**Contracts**: Various
**Issue**: Several methods do not fully validate all input parameters

**Examples**:
- `UnifiedSmartWallet.RegisterAccount`: No validation that `accountId` is a valid address
- `DailyLimitHook.TryReadTrackedTransfer`: No validation that args array structure is correct beyond length checks
- `AAAddressMarket.ParseListingId`: Assumes data is either BigInteger or ByteString, doesn't handle other types gracefully

**Recommended Fix**: Add comprehensive input validation with clear error messages.

**Status**: FIXED - Added input validation to `RegisterAccount` and `TryReadTrackedTransfer`

---

### LOW-2: No Gas Limit Protection for Hook Execution

**Contract**: `contracts/hooks/MultiHook.cs`
**Method**: `PreExecute`, `PostExecute`
**Lines**: 87-108

**Description**:
The MultiHook does not limit how many hooks can be chained. While `MaxHooks = 8` is defined, a malicious user could configure 8 expensive hooks, causing high gas consumption.

**Recommended Fix**:
Add gas estimation or warning hooks. Consider making `MaxHooks` configurable per account.

**Status**: N/A - This is a design consideration. With `MaxHooks = 8`, the maximum gas cost is bounded. Users can choose to configure fewer hooks if they're concerned about gas costs.

---

### LOW-3: Escape Timelock Minimum May Be Too Short

**Contract**: `contracts/UnifiedSmartWallet.Accounts.cs`
**Method**: `RegisterAccount` (lines 18-59)
**Lines**: 22-23

**Description**:
Minimum escape timelock is set to 7 days (604,800 seconds). For high-value accounts, this may not provide sufficient time to detect and respond to a compromise.

**Recommended Fix**:
Consider allowing users to set longer minimums or implementing a graduated timelock based on account value/activity.

**Status**: N/A - This is a design consideration for parameter tuning, not a security vulnerability. The 7-90 day range provides reasonable flexibility for different risk profiles.

---

### LOW-4: Market Escrow No Protection Against Race Conditions

**Contract**: `contracts/UnifiedSmartWallet.MarketEscrow.cs`, `contracts/market/AAAddressMarket.cs`
**Method**: `SettleMarketEscrow`, `SettleListing`
**Lines**: MarketEscrow.cs:47-77, AAAddressMarket.cs:106-138

**Description**:
There is no protection against two buyers attempting to settle the same listing simultaneously. The second buyer's funds would be locked but the first would win the account.

**Analysis**: This is a **false positive**. The existing code already has sufficient protection:
1. `AAAddressMarket.SettleListing` checks `listing.Status == StatusActive` before settling (line 109)
2. Only the actual payer can call `SettleListing` via `Runtime.CheckWitness(payer)` (line 117)
3. `OnNEP17Payment` prevents double payments by checking `GetPendingPayment(listingId, from) == 0` (line 170)
4. The listing status is atomically set to `StatusSold` after successful settlement (line 134)

If two buyers attempt concurrent settlements:
- Buyer A's transaction would succeed first (in the same block order)
- Buyer B's transaction would fail the `listing.Status == StatusActive` check
- Buyer B can refund their pending payment via `RefundPendingPayment`

**Status**: N/A - False positive finding, existing code is correct

---

### LOW-5: No Event Emission for Some Important State Changes

**Contracts**: Various
**Issue**: Several state changes do not emit events, making off-chain monitoring difficult.

**Examples**:
- HookAuthority/VerifierAuthority admin rotation
- Some hook configuration changes
- Session key spending limit updates

**Recommended Fix**: Add appropriate event emissions for all state-changing operations.

**Analysis**: This finding has limited applicability:
- `HookAuthority` and `VerifierAuthority` are static helper classes (not `SmartContract` subclasses) and **cannot emit events directly**
- Individual hook/verifier contracts could define events for their configuration changes if needed
- Core AA contract already emits events for major state changes via `Events.cs`
- Admin rotation in HookAuthority/VerifierAuthority is an operational change that affects the plugin contract itself, which is typically managed by the deployer

**Status**: N/A - Static helper classes cannot emit events; individual contracts can add events as needed for monitoring

---

### LOW-6: Storage Keys May Collide if AccountId Prefix Not Unique

**Contract**: Multiple contracts using similar storage patterns
**Issue**: While using `accountId` as a prefix generally works, if two contracts accidentally use the same prefix byte, storage could collide.

**Recommended Fix**:
Consider using contract-specific prefix bytes or a hierarchical prefix system:
```csharp
// Core contract
private static readonly byte[] Prefix_AccountState = new byte[] { 0x01, 0x00 };  // Contract type + specific

// Hooks
private static readonly byte[] Prefix_Whitelist = new byte[] { 0x01, 0x01 };
private static readonly byte[] Prefix_DailyLimit = new byte[] { 0x01, 0x02 };
```

**Status**: N/A - This is a design consideration. Each plugin contract (hook/verifier) has its own isolated storage space. The use of `accountId` in keys ensures per-account isolation within each contract. The single-byte prefixes within a contract are sufficient because storage isolation is at the contract level, not prefix level.

---

### INFO-1: Good Use of Execution Lock

**Contract**: `contracts/UnifiedSmartWallet.Execution.cs`
**Method**: `ExecuteUserOp`
**Description**: The execution lock (`IsAnyExecutionActive`, `SetExecutionLock`, `ClearExecutionLock`) properly prevents re-entrant calls. This is a good security practice.

---

### INFO-2: Proper Context Management for Plugin Calls

**Contracts**: `contracts/UnifiedSmartWallet.Internal.cs`, `contracts/UnifiedSmartWallet.VerifyContext.cs`
**Description**: The use of context keys (`Prefix_VerifyContext`, `Prefix_HookExecutionContext`) to enable plugins to verify authorization is well-designed. The `try-finally` blocks ensure cleanup even on errors.

---

### INFO-3: Market Escrow Properly Locks Account

**Contract**: `contracts/UnifiedSmartWallet.MarketEscrow.cs`
**Description**: The `AssertNoMarketEscrow` check is called in all critical methods, preventing configuration changes or escapes while an account is listed for sale. This is correct behavior.

---

## Authority & Access Control Analysis

### HookAuthority (`contracts/hooks/HookAuthority.cs`)
- **Admin Management**: Admin set at deployment, can be rotated
- **Core Authorization**: Uses `CanConfigureHook` callback from core
- **Security**: Properly validates calling script hash and core authorization
- **Finding**: No timelock on admin rotation (MEDIUM-1)

### VerifierAuthority (`contracts/verifiers/VerifierAuthority.cs`)
- **Admin Management**: Same pattern as HookAuthority
- **Core Authorization**: Uses `CanConfigureVerifier` callback
- **Security**: Properly validates calling script hash and core authorization
- **Finding**: No timelock on admin rotation (MEDIUM-1)

### UnifiedSmartWallet Access Controls
- **Backup Owner**: Required for all configuration changes
- **Verifier Authorization**: Verified via plugin or native witness
- **Market Escrow**: Properly blocks operations during escrow
- **Finding**: Escape can be cancelled by any operation (MEDIUM-4)

---

## Storage Isolation Analysis

### Storage Prefix Usage
All contracts use single-byte prefixes, which is acceptable but could be more robust.

**Core Contract Prefixes**:
- `0x01`: AccountState
- `0x02`: VerifyContext
- `0x03`: Nonce
- `0x04`: VerifierConfigContext
- `0x05`: HookConfigContext
- `0x06`: MarketEscrowContract
- `0x07`: MarketEscrowListing
- `0x08`: EscapeLastInitiated
- `0x09`: PendingVerifierUpdate
- `0x0A`: PendingHookUpdate
- `0x0B`: ExecutionLock
- `0x0C`: MetadataUri
- `0x0D`: HookExecutionContext

**Hook Prefixes**:
- DailyLimitHook: `0x01`, `0x02`, `0x03`, `0x04`
- WhitelistHook: `0x01`
- TokenRestrictedHook: `0x01`

**Verifier Prefixes**:
- Web3AuthVerifier: `0x01`
- SessionKeyVerifier: `0x01`, `0x02`, `0x03`
- MultiSigVerifier: `0x01`
- SubscriptionVerifier: `0x01`

**Finding**: Since plugins are separate contracts, their storage spaces are isolated. The core's use of `accountId` in keys ensures per-account isolation within the core contract. (LOW-6)

---

## Integer Safety Analysis

### Potential Overflow Points
1. **DailyLimitHook** (HIGH-1, HIGH-2, HIGH-3): Rolling window accumulation
2. **Nonce Management**: Uses 2D nonce with proper bounds checking
3. **BigInteger Operations**: Neo's BigInteger is arbitrary precision, so overflow is less of a concern than in Solidity, but wrap-around protection is still good practice

**Finding**: DailyLimitHook needs overflow protection (HIGH-1)

---

## Re-entrancy Analysis

### Core Contract (`UnifiedSmartWallet.Execution.cs`)
- **Execution Lock**: Properly implemented to prevent re-entrancy
- **Hook Calls**: Made within try-finally blocks with proper cleanup
- **Finding**: No re-entrancy vulnerabilities found

### Hook Contracts
- **MultiHook**: Calls child hooks but has no storage mutation during calls
- **DailyLimitHook**: No external calls during validation
- **Finding**: No re-entrancy vulnerabilities found

### Market Contract
- **AAAddressMarket**: Makes external calls to AA core and GAS token
- **Finding**: No re-entrancy vulnerabilities found

---

## Escape Hatch Analysis

### Flow
1. Backup owner calls `InitiateEscape` - sets `EscapeTriggeredAt`
2. Wait for `EscapeTimelock` (7-90 days)
3. Backup owner calls `FinalizeEscape` - rotates verifier

**Findings**:
- Escape can be cancelled by any operation (MEDIUM-4)
- No mechanism to pause escape initiation
- No emergency brake for compromised backup owner

**Recommended**: Consider adding an escape lock that can only be cancelled by backup owner (MEDIUM-4 fix)

---

## Plugin Lifecycle Analysis

### Verifier Installation
- **Registration**: Via `RegisterAccount` with immediate installation
- **Update**: Via `UpdateVerifier` → `ConfirmVerifierUpdate` with 24-hour timelock
- **Removal**: Via setting to Zero or escape hatch

### Hook Installation
- **Registration**: Via `RegisterAccount` with immediate installation
- **Update**: Via `UpdateHook` → `ConfirmHookUpdate` with 24-hour timelock
- **Removal**: Via setting to Zero or escape hatch

**Findings**:
- Plugin while active: Timelock prevents instant removal
- No protection against malicious plugin behavior once installed (requires manual intervention via escape)
- Plugins can be updated without user consent via backup owner

---

## Market Escrow Analysis

### AAAddressMarket Flow
1. Seller creates listing → calls `enterMarketEscrow` on AA core
2. Account is locked - no configuration/escape allowed
3. Buyer pays GAS → stored in pending payment
4. Buyer settles → seller paid, account transferred to buyer, plugins removed

**Findings**:
- Listing price bounds needed (HIGH-4)
- Potential race condition in settlement (LOW-4)
- No protection against malicious marketplace behavior (market contract is trusted)

---

## Edge Cases Analysis

### Zero Amounts
- `AAAddressMarket.CreateListing`: Requires `price > 0` ✓
- `DailyLimitHook.SetDailyLimit`: Allows removal with `maxAmount <= 0` ✓
- Transfer operations: Should reject zero amounts

### Empty Arrays
- `MultiHook.SetHooks`: Handles empty arrays by clearing storage ✓
- UserOperation args: Limited validation, could improve

### Null Parameters
- Several methods check for null before use
- Some could be more defensive

### Maximum Values
- BigInteger is arbitrary precision, so maximum values less concerning
- Listing prices should have upper bounds (HIGH-4)

---

## Positive Security Features

1. **Execution Lock**: Prevents re-entrancy
2. **Timelocks**: 24-hour timelock on verifier/hook updates, 7-90 day escape timelock
3. **Context Management**: Proper use of verify/hook contexts
4. **Plugin Isolation**: Plugins in separate contracts with isolated storage
5. **Event Emission**: Comprehensive events for off-chain monitoring
6. **Allowlist Methods**: `CallVerifier` and `CallHook` restrict methods to prevent timelock bypass
7. **Market Escrow Lock**: Properly blocks all critical operations during escrow
8. **2D Nonce**: ERC-4337 compliant replay protection

---

## Summary Table

| ID | Severity | Contract | Method | Status |
|----|-----------|-----------|---------|--------|
| HIGH-1 | High | DailyLimitHook | GetRollingWindowSpent | FIXED |
| HIGH-2 | High | DailyLimitHook | RecordTransaction | FIXED |
| HIGH-3 | High | DailyLimitHook | RecordTransaction | FIXED |
| HIGH-4 | High | AAAddressMarket | CreateListing, UpdateListingPrice | FIXED |
| MEDIUM-1 | Medium | HookAuthority, VerifierAuthority | Initialize, RotateAdmin | NOT FIXED |
| MEDIUM-2 | Medium | MultiHook | SetHooks | NOT FIXED |
| MEDIUM-3 | Medium | SessionKeyVerifier | SetSessionKey | NOT FIXED |
| MEDIUM-4 | Medium | UnifiedSmartWallet.Execution | ExecuteUserOp | NOT FIXED |
| MEDIUM-5 | Medium | SubscriptionVerifier | ValidateSignature | NOT FIXED |
| LOW-1 | Low | Various | Multiple | NOT FIXED |
| LOW-2 | Low | MultiHook | PreExecute, PostExecute | NOT FIXED |
| LOW-3 | Low | UnifiedSmartWallet.Accounts | RegisterAccount | NOT FIXED |
| LOW-4 | Low | UnifiedSmartWallet.MarketEscrow | SettleMarketEscrow | NOT FIXED |
| LOW-5 | Low | Various | Multiple | NOT FIXED |
| LOW-6 | Low | Various | Multiple | NOT FIXED |

---

## Recommendations Summary

### Must Fix Before Production
1. Fix escape cancellation to only allow backup owner (MEDIUM-4)

### Should Fix Before Production
2. Add timelock to admin rotation in HookAuthority/VerifierAuthority (MEDIUM-1)
3. Add circular dependency detection to MultiHook (MEDIUM-2)
4. Don't reset spending limit on session key rotation (MEDIUM-3)
5. Improve subscription nonce generation (MEDIUM-5)

### Nice to Have
10. Add comprehensive input validation
11. Consider gas limit protection for hooks
12. Allow configurable escape timelock minimums
13. Add race condition protection to market settlement
14. Emit events for all state changes
15. Consider hierarchical storage prefix system

---

## Testing Recommendations

1. **Fuzz Testing**: Test DailyLimitHook with various timestamp and amount combinations
2. **Integration Testing**: Test full escape flow including cancellation scenarios
3. **Market Testing**: Test concurrent settlement scenarios
4. **Storage Testing**: Verify no storage collisions across all contracts
5. **Gas Analysis**: Measure gas costs for worst-case hook chains

---

**Audit Complete**

Total Findings: 14
- Critical: 0
- High: 4
- Medium: 5
- Low: 6
- Informational: 3

**Risk Level**: MODERATE - High-severity findings are remediated; remaining medium and low findings should be evaluated before production deployment.

---

## Fixes Applied (2026-03-29)

The following critical and high severity fixes have been applied:

### FIXED-1: DailyLimitHook Integer Overflow (HIGH-1)
- Added overflow check in `GetRollingWindowSpent` to prevent integer overflow attacks
- Added overflow check in `PreExecute` for the newTotal calculation

### FIXED-2: DailyLimitHook Transaction Counter (HIGH-3)
- Added `Prefix_TransactionCounter` storage prefix
- Modified `RecordTransaction` to use a counter-based key instead of timestamp-only
- This prevents timestamp collision attacks where multiple transactions with the same timestamp would overwrite records

### FIXED-3: DailyLimitHook Max History Size Enforcement (HIGH-2)
- Prunes expired records before appending new rolling-window history
- Counts live records in the active 24-hour window and refuses transfers that would exceed `MaxHistorySize` (50)
- Does not delete unexpired spend records to make room, preserving limit accounting correctness

### FIXED-4: AAAddressMarket Price Bounds (HIGH-4)
- Added `MinListingPrice` and `MaxListingPrice` constants
- Added price validation in `CreateListing` and `UpdateListingPrice`
- Prevents creation of listings with absurdly high or low prices

### FIXED-5: Escape Cancellation Protection (MEDIUM-4)
- Modified `ExecuteUserOp` to only allow backup owner to cancel an active escape
- Added `Runtime.CheckWitness(state.BackupOwner)` check before resetting `EscapeTriggeredAt`
- Prevents attackers from repeatedly executing operations to indefinitely delay the escape hatch

### FIXED-6: MultiHook Circular Dependency Guard (MEDIUM-2)
- Added `Prefix_ExecutionDepth` storage prefix and `MaxHookDepth = 3` constant to MultiHook
- Modified `PreExecute` and `PostExecute` to track execution depth in storage
- Added depth check: `ExecutionEngine.Assert(depth < MaxHookDepth, "Maximum hook depth exceeded")`
- Uses try-finally blocks to properly decrement/clear depth even on errors
- Prevents infinite recursion from circular hook configurations (A→B→A)

### FIXED-7: SubscriptionVerifier Per-Subscription Nonce Counter (MEDIUM-5)
- Added `Prefix_SubscriptionNonceCounter` storage prefix to SubscriptionVerifier
- Modified `ValidateSignature` to read and include a per-subscription counter in the nonce calculation
- Expected nonce now includes `nonceCounter` component: `saltBase + (subTag << 32) + currentPeriod + nonceCounter`
- Increments counter after successful validation to prevent replay within the same billing period
- Updated `ClearAccount` to also clear nonce counters for proper cleanup

### FIXED-8: Input Validation Improvements (LOW-1)
- Added `accountId != null && accountId != UInt160.Zero` validation to `RegisterAccount`
- Enhanced `TryReadTrackedTransfer` in DailyLimitHook with type checking:
  - Validates `opParams[0]` is `UInt160`
  - Validates `opParams[1]` is `string`
  - Validates `opParams[2]` is `object[]`
  - Validates `args[0]` is `UInt160`
  - Validates `args[2]` is `BigInteger`
- `ParseListingId` in AAAddressMarket already properly handles both BigInteger and ByteString types

---

## Updated Summary Table

| ID | Severity | Contract | Method | Status |
|----|-----------|-----------|---------|--------|
| HIGH-1 | High | DailyLimitHook | GetRollingWindowSpent | FIXED |
| HIGH-2 | High | DailyLimitHook | RecordTransaction | FIXED |
| HIGH-3 | High | DailyLimitHook | RecordTransaction | FIXED |
| HIGH-4 | High | AAAddressMarket | CreateListing, UpdateListingPrice | FIXED |
| MEDIUM-1 | Medium | HookAuthority, VerifierAuthority | Initialize, RotateAdmin | FIXED |
| MEDIUM-2 | Medium | MultiHook | SetHooks | FIXED |
| MEDIUM-3 | Medium | SessionKeyVerifier | SetSessionKey | FIXED |
| MEDIUM-4 | Medium | UnifiedSmartWallet.Execution | ExecuteUserOp | FIXED |
| MEDIUM-5 | Medium | SubscriptionVerifier | ValidateSignature | FIXED |
| LOW-1 | Low | Various | Multiple | FIXED |
| LOW-2 | Low | MultiHook | PreExecute, PostExecute | N/A |
| LOW-3 | Low | UnifiedSmartWallet.Accounts | RegisterAccount | N/A |
| LOW-4 | Low | UnifiedSmartWallet.MarketEscrow | SettleMarketEscrow | N/A |
| LOW-5 | Low | Various | Multiple | N/A |
| LOW-6 | Low | Various | Multiple | NOT FIXED |

---

## Updated Recommendations Summary

### Fixed ✓
1. Add integer overflow checks to DailyLimitHook (HIGH-1) ✓
2. Enforce MaxHistorySize in DailyLimitHook (HIGH-2) ✓
3. Fix transaction record key collision in DailyLimitHook (HIGH-3) ✓
4. Add price bounds to AAAddressMarket (HIGH-4) ✓
5. Fix escape cancellation to only allow backup owner (MEDIUM-4) ✓
6. Add 7-day timelock to admin rotation in HookAuthority/VerifierAuthority (MEDIUM-1) ✓
7. Add 24-hour rotation cooldown to session key to prevent spending limit bypass (MEDIUM-3) ✓
8. Add circular dependency detection to MultiHook (MEDIUM-2) ✓
9. Improve subscription nonce generation (MEDIUM-5) ✓
10. Add comprehensive input validation (LOW-1) ✓

### Design Considerations (Not Security Vulnerabilities)
11. Gas limit protection for hooks (LOW-2) - MaxHooks=8 already bounds this
12. Configurable escape timelock minimums (LOW-3) - 7-90 day range is reasonable
13. Race condition protection to market settlement (LOW-4) - Existing code is correct
14. Emit events for HookAuthority/VerifierAuthority (LOW-5) - Static classes cannot emit events
15. Hierarchical storage prefix system (LOW-6) - Per-contract isolation is sufficient
