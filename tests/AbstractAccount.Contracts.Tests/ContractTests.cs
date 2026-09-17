using System.ComponentModel;
using System.IO;
using System.Linq;
using System.Reflection;
using System;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace AbstractAccount.Contracts.Tests;

[TestClass]
public class ContractTests
{
    private static readonly string RepoRoot =
        Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));

    private static readonly string ContractsDir = Path.Combine(RepoRoot, "contracts");

    private static readonly string[] UnifiedSmartWalletFiles =
    {
        "UnifiedSmartWallet.cs",
        "UnifiedSmartWallet.Models.cs",
        "UnifiedSmartWallet.Internal.cs",
        "UnifiedSmartWallet.Events.cs",
        "UnifiedSmartWallet.Accounts.cs",
        "UnifiedSmartWallet.State.cs",
        "UnifiedSmartWallet.Execution.cs",
        "UnifiedSmartWallet.VerifyContext.cs",
        "UnifiedSmartWallet.Escape.cs",
        "UnifiedSmartWallet.MarketEscrow.cs",
        "UnifiedSmartWallet.Admin.cs",
        "UnifiedSmartWallet.Paymaster.cs"
    };

    private static readonly string[] HookFiles =
    {
        "hooks/HookAuthority.cs",
        "hooks/WhitelistHook.cs",
        "hooks/DailyLimitHook.cs",
        "hooks/TokenRestrictedHook.cs",
        "hooks/MultiHook.cs",
        "hooks/NeoDIDCredentialHook.cs"
    };

    private static readonly string[] VerifierFiles =
    {
        "verifiers/VerifierAuthority.cs",
        "verifiers/Web3AuthVerifier.cs",
        "verifiers/TEEVerifier.cs",
        "verifiers/WebAuthnVerifier.cs",
        "verifiers/SessionKeyVerifier.cs",
        "verifiers/MultiSigVerifier.cs",
        "verifiers/SubscriptionVerifier.cs",
        "verifiers/ZKEmailVerifier.cs",
        "verifiers/ZkLoginVerifier.cs"
    };

    private static readonly string[] ContractProjectFiles =
    {
        "UnifiedSmartWallet.csproj",
        "hooks/DailyLimitHook.csproj",
        "hooks/MultiHook.csproj",
        "hooks/NeoDIDCredentialHook.csproj",
        "hooks/TokenRestrictedHook.csproj",
        "hooks/WhitelistHook.csproj",
        "market/AAAddressMarket.csproj",
        "mocks/MockTransferTarget.csproj",
        "paymaster/Paymaster.csproj",
        "verifiers/MultiSigVerifier.csproj",
        "verifiers/SessionKeyVerifier.csproj",
        "verifiers/SubscriptionVerifier.csproj",
        "verifiers/TEEVerifier.csproj",
        "verifiers/Web3AuthVerifier.csproj",
        "verifiers/WebAuthnVerifier.csproj",
        "verifiers/ZKEmailVerifier.csproj",
        "verifiers/ZkLoginVerifier.csproj",
    };

    private static Type ContractType => typeof(global::AbstractAccount.UnifiedSmartWallet);

    private static string ReadContractFile(string fileName) =>
        File.ReadAllText(Path.Combine(ContractsDir, fileName));

    private static string ReadCombinedSource() =>
        string.Join("\n\n", UnifiedSmartWalletFiles.Select(ReadContractFile));

    private static string ExtractSourceBlock(string source, string startMarker, string endMarker)
    {
        int start = source.IndexOf(startMarker, StringComparison.Ordinal);
        Assert.IsTrue(start >= 0, $"Missing source marker: {startMarker}");

        int end = source.IndexOf(endMarker, start, StringComparison.Ordinal);
        Assert.IsTrue(end > start, $"Missing source marker: {endMarker}");

        return source[start..end];
    }

    [TestMethod]
    public void ContractAssemblyExposesUnifiedSmartWalletV3Metadata()
    {
        Assert.AreEqual("UnifiedSmartWallet", ContractType.Name);

        DisplayNameAttribute? displayName = ContractType.GetCustomAttribute<DisplayNameAttribute>();
        Assert.IsNotNull(displayName);
        Assert.AreEqual("UnifiedSmartWalletV3", displayName.DisplayName);

        CustomAttributeData? manifestExtra = ContractType.CustomAttributes
            .FirstOrDefault(attribute => attribute.AttributeType.Name == "ManifestExtraAttribute");

        Assert.IsNotNull(manifestExtra);
        Assert.AreEqual(2, manifestExtra!.ConstructorArguments.Count);
        Assert.AreEqual("Description", manifestExtra.ConstructorArguments[0].Value);
        Assert.AreEqual(
            "ERC-4337 Aligned Minimalist AA Engine for Neo N3",
            manifestExtra.ConstructorArguments[1].Value);
    }

    [TestMethod]
    public void ContractExposesCanonicalV3Entrypoints()
    {
        string[] requiredMethods =
        {
            "RegisterAccount",
            "RegisterAccounts",
            "UpdateHook",
            "ConfirmHookUpdate",
            "UpdateVerifier",
            "ConfirmVerifierUpdate",
            "CallVerifier",
            "CallHook",
            "PreviewUserOpValidation",
            "ExecuteUserOp",
            "ExecuteUserOps",
            "ExecuteSponsoredUserOp",
            "ExecuteSponsoredUserOps",
            "InitiateEscape",
            "FinalizeEscape",
            "EnterMarketEscrow",
            "CancelMarketEscrow",
            "SettleMarketEscrow",
            "_deploy",
            "Update",
            "GetContractAdmin",
            "ProposeAdminTransfer",
            "ConfirmAdminTransfer",
            "CancelAdminTransfer"
        };

        string[] exportedMethods = ContractType
            .GetMethods(BindingFlags.Public | BindingFlags.Static)
            .Select(method => method.Name)
            .Distinct()
            .ToArray();

        CollectionAssert.IsSubsetOf(requiredMethods, exportedMethods);
    }

    [TestMethod]
    public void UnifiedSmartWalletProjectCompilesAllPartialModules()
    {
        string projectFile = File.ReadAllText(Path.Combine(ContractsDir, "UnifiedSmartWallet.csproj"));
        foreach (string fileName in UnifiedSmartWalletFiles)
        {
            StringAssert.Contains(projectFile, $"<Compile Include=\"{fileName}\" />");
            Assert.IsTrue(File.Exists(Path.Combine(ContractsDir, fileName)), $"Missing source file: {fileName}");
        }
    }

    [TestMethod]
    public void ExecutionPathKeepsFixedCallFlagsAll()
    {
        string executionSource = ReadContractFile("UnifiedSmartWallet.Execution.cs");

        StringAssert.Contains(
            executionSource,
            "object result = Contract.Call(op.TargetContract, op.Method, CallFlags.All, op.Args);");
        Assert.IsFalse(executionSource.Contains("op.CallFlags", StringComparison.Ordinal));
        StringAssert.Contains(executionSource, "ConsumeNonce(accountId, op.Nonce);");
        StringAssert.Contains(executionSource, "Contract.Call(state.Verifier, \"validateSignature\", CallFlags.ReadOnly, new object[] { accountId, op });");
    }

    [TestMethod]
    public void RegisterAccountBindsAccountIdToRegistrationParameters()
    {
        string accountsSource = ReadContractFile("UnifiedSmartWallet.Accounts.cs");

        StringAssert.Contains(accountsSource, "Account id required");
        StringAssert.Contains(accountsSource, "Account already exists");
        StringAssert.Contains(accountsSource, "public static UInt160 ComputeRegistrationAccountId(");
        StringAssert.Contains(accountsSource, "public static void RegisterAccounts(");
        StringAssert.Contains(accountsSource, "Account batch size must be 1-64");
        StringAssert.Contains(accountsSource, "RegisterAccount(ids[i]!, verifier, paramList[i], hookId, backupOwner!, escapeTimelock)");
        StringAssert.Contains(accountsSource, "Account id does not match registration parameters");
        StringAssert.Contains(
            accountsSource,
            "ComputeRegistrationAccountId(verifier, verifierParams, hookId, backupOwner!");
    }

    [TestMethod]
    public void VerifierAllowlistBlocksImmediateKeyRotationMethods()
    {
        string accountsSource = ReadContractFile("UnifiedSmartWallet.Accounts.cs");
        string allowlistBlock = ExtractSourceBlock(
            accountsSource,
            "private static readonly string[] AllowedVerifierMethods = new string[]",
            "private static readonly string[] AllowedHookMethods = new string[]");

        Assert.IsFalse(allowlistBlock.Contains("\"setPublicKey\"", StringComparison.Ordinal));
    }

    [TestMethod]
    public void PluginConfigurationCallsRequireReplayAfterTimelock()
    {
        string accountsSource = ReadContractFile("UnifiedSmartWallet.Accounts.cs");

        StringAssert.Contains(accountsSource, "PendingModuleCall pending = new PendingModuleCall");
        StringAssert.Contains(accountsSource, "ComputeModuleCallHash(string method, object[] args)");
        StringAssert.Contains(accountsSource, "return false;");
        StringAssert.Contains(accountsSource, "Timelock not elapsed");
        StringAssert.Contains(accountsSource, "Storage.Delete(Storage.CurrentContext, pendingKey);");
    }

    [TestMethod]
    public void ExecutionPathAppliesVerifierPostExecutionEffectsAfterSuccessfulCalls()
    {
        string executionSource = ReadContractFile("UnifiedSmartWallet.Execution.cs");

        StringAssert.Contains(
            executionSource,
            "Contract.Call(state.Verifier, \"postExecute\", CallFlags.All, new object[] { accountId, op, result });");
    }

    [TestMethod]
    public void MarketEscrowSettlementWipesInheritedVerifierAndHookState()
    {
        string marketSource = ReadContractFile("UnifiedSmartWallet.MarketEscrow.cs");

        StringAssert.Contains(marketSource, "state.Verifier = UInt160.Zero;");
        StringAssert.Contains(marketSource, "state.HookId = UInt160.Zero;");
        StringAssert.Contains(marketSource, "state.EscapeTriggeredAt = 0;");
        StringAssert.Contains(marketSource, "Account locked in market escrow");
        StringAssert.Contains(marketSource, "Only escrow market");
    }

    [TestMethod]
    public void CombinedSourceDocumentsV3RegistrationAndExecutionFlow()
    {
        string source = ReadCombinedSource();

        StringAssert.Contains(source, "RegisterAccount");
        StringAssert.Contains(source, "ExecuteUserOp");
        StringAssert.Contains(source, "Backup owner required");
        StringAssert.Contains(source, "Verifier rejected signature");
        StringAssert.Contains(source, "Native witness failed");
    }

    [TestMethod]
    public void HookContractsUseTrustedCoreAuthorityInsteadOfCallerControlledSpoofing()
    {
        foreach (string fileName in HookFiles)
        {
            string source = ReadContractFile(fileName);
            Assert.IsFalse(
                source.Contains("Runtime.CallingScriptHash,\n                \"canConfigureHook\"", StringComparison.Ordinal)
                || source.Contains("Runtime.CallingScriptHash,\r\n                \"canConfigureHook\"", StringComparison.Ordinal)
                || source.Contains("Runtime.CallingScriptHash,\n                \"canExecuteHook\"", StringComparison.Ordinal)
                || source.Contains("Runtime.CallingScriptHash,\r\n                \"canExecuteHook\"", StringComparison.Ordinal),
                $"Direct caller-controlled authority call still present in {fileName}");
        }

        StringAssert.Contains(ReadContractFile("hooks/WhitelistHook.cs"), "HookAuthority.ValidateConfigCaller");
        StringAssert.Contains(ReadContractFile("hooks/WhitelistHook.cs"), "HookAuthority.ValidateExecutionCaller");
        StringAssert.Contains(ReadContractFile("hooks/DailyLimitHook.cs"), "HookAuthority.ValidateExecutionCaller");
        StringAssert.Contains(ReadContractFile("hooks/MultiHook.cs"), "HookAuthority.ValidateExecutionCaller");
        StringAssert.Contains(ReadContractFile("hooks/NeoDIDCredentialHook.cs"), "HookAuthority.ValidateExecutionCaller");
        StringAssert.Contains(ReadContractFile("hooks/TokenRestrictedHook.cs"), "HookAuthority.ValidateExecutionCaller");
    }

    [TestMethod]
    public void WalletTracksHookExecutionContextForTrustedPluginCalls()
    {
        string internalSource = ReadContractFile("UnifiedSmartWallet.Internal.cs");
        string verifyContextSource = ReadContractFile("UnifiedSmartWallet.VerifyContext.cs");
        string executionSource = ReadContractFile("UnifiedSmartWallet.Execution.cs");

        StringAssert.Contains(internalSource, "Prefix_HookExecutionContext");
        StringAssert.Contains(internalSource, "SetHookExecutionContext");
        StringAssert.Contains(internalSource, "ClearHookExecutionContext");
        StringAssert.Contains(verifyContextSource, "public static bool CanExecuteHook");
        StringAssert.Contains(executionSource, "SetHookExecutionContext(accountId, state.HookId);");
        StringAssert.Contains(executionSource, "ClearHookExecutionContext(accountId);");
    }

    [TestMethod]
    public void HookProjectsCompileSharedAuthorityHelper()
    {
        string[] hookProjects =
        {
            "hooks/WhitelistHook.csproj",
            "hooks/DailyLimitHook.csproj",
            "hooks/TokenRestrictedHook.csproj",
            "hooks/MultiHook.csproj",
            "hooks/NeoDIDCredentialHook.csproj",
        };

        foreach (string project in hookProjects)
        {
            string projectFile = ReadContractFile(project);
            StringAssert.Contains(projectFile, "<Compile Include=\"HookAuthority.cs\" />");
        }
    }

    [TestMethod]
    public void DailyLimitHookOnlyAccruesUsageAfterSuccessfulExecution()
    {
        string source = ReadContractFile("hooks/DailyLimitHook.cs");

        StringAssert.Contains(source, "public static void PostExecute");
        StringAssert.Contains(source, "if (!DidExecutionSucceed(result)) return;");
        StringAssert.Contains(source, "ExecutionEngine.Assert(IsProtectedTransferSource(accountId, fromAccount), \"Transfer source not permitted\");");
        // Assets leave from the account's holding address (the core's proxy script
        // hash), not from the accountId itself, so the protected-source check has to
        // compare against that address.
        StringAssert.Contains(source, "return from == AssetAddressOf(accountId);");
        StringAssert.Contains(source, "Contract.Call(core, \"getProxyScriptHash\", CallFlags.ReadOnly, accountId)");
        StringAssert.Contains(source, "StoreFixedWindowSpent(accountId, targetContract, currentTime, spentToday + amount);");
        Assert.IsFalse(source.Contains("Storage.Put(Storage.CurrentContext, spentKey, newTotal);", StringComparison.Ordinal));
    }

    [TestMethod]
    public void MultiHookRejectsUnsafeHookTopologies()
    {
        string source = ReadContractFile("hooks/MultiHook.cs");

        StringAssert.Contains(source, "hooks allowed");
        StringAssert.Contains(source, "Self hook not allowed");
        StringAssert.Contains(source, "Duplicate hook not allowed");
    }

    [TestMethod]
    public void NeoDidHookUsesRegistryBackedChecksInsteadOfLocalCredentialFlags()
    {
        string source = ReadContractFile("hooks/NeoDIDCredentialHook.cs");

        StringAssert.Contains(source, "SetRegistry");
        StringAssert.Contains(source, "\"getBinding\"");
        StringAssert.Contains(source, "\"getClaimCommitment\"");
        StringAssert.Contains(source, "RequireCredentialCommitmentForContract");
        StringAssert.Contains(source, "NeoDID registry not configured");
        Assert.IsFalse(source.Contains("IssueCredential(", StringComparison.Ordinal));
        Assert.IsFalse(source.Contains("RevokeCredential(", StringComparison.Ordinal));
        Assert.IsFalse(source.Contains("Prefix_VerifiedCredentials", StringComparison.Ordinal));
        Assert.IsFalse(source.Contains("Prefix_RequiredClaimValue", StringComparison.Ordinal));
    }

    [TestMethod]
    public void VerifierContractsUseTrustedCoreAuthorityInsteadOfCallerControlledSpoofing()
    {
        foreach (string fileName in VerifierFiles)
        {
            string source = ReadContractFile(fileName);
            Assert.IsFalse(
                source.Contains("Runtime.CallingScriptHash,\n                \"canConfigureVerifier\"", StringComparison.Ordinal)
                || source.Contains("Runtime.CallingScriptHash,\r\n                \"canConfigureVerifier\"", StringComparison.Ordinal),
                $"Direct caller-controlled verifier authority call still present in {fileName}");
        }

        StringAssert.Contains(ReadContractFile("verifiers/Web3AuthVerifier.cs"), "VerifierAuthority.ValidateConfigCaller");
        StringAssert.Contains(ReadContractFile("verifiers/TEEVerifier.cs"), "VerifierAuthority.ValidateConfigCaller");
        StringAssert.Contains(ReadContractFile("verifiers/WebAuthnVerifier.cs"), "VerifierAuthority.ValidateConfigCaller");
        StringAssert.Contains(ReadContractFile("verifiers/SessionKeyVerifier.cs"), "VerifierAuthority.ValidateConfigCaller");
        StringAssert.Contains(ReadContractFile("verifiers/MultiSigVerifier.cs"), "VerifierAuthority.ValidateConfigCaller");
        StringAssert.Contains(ReadContractFile("verifiers/SubscriptionVerifier.cs"), "VerifierAuthority.ValidateConfigCaller");
        StringAssert.Contains(ReadContractFile("verifiers/ZKEmailVerifier.cs"), "VerifierAuthority.ValidateConfigCaller");
        StringAssert.Contains(ReadContractFile("verifiers/ZkLoginVerifier.cs"), "VerifierAuthority.ValidateConfigCaller");
    }

    [TestMethod]
    public void SessionAndSubscriptionVerifiersKeepValidateSignatureReadOnlyAndPersistStateInPostExecute()
    {
        string sessionSource = ReadContractFile("verifiers/SessionKeyVerifier.cs");
        string subscriptionSource = ReadContractFile("verifiers/SubscriptionVerifier.cs");

        string sessionValidateBlock = ExtractSourceBlock(
            sessionSource,
            "public static bool ValidateSignature(UInt160 accountId, UserOperation op)",
            "private static BigInteger ExtractTransferValue(UserOperation op)");
        string subscriptionValidateBlock = ExtractSourceBlock(
            subscriptionSource,
            "public static bool ValidateSignature(UInt160 accountId, UserOperation op)",
            "public static void ClearAccount(UInt160 accountId)");

        Assert.IsFalse(sessionValidateBlock.Contains("Storage.Put(", StringComparison.Ordinal));
        Assert.IsFalse(subscriptionValidateBlock.Contains("Storage.Put(", StringComparison.Ordinal));
        StringAssert.Contains(sessionSource, "public static void PostExecute(UInt160 accountId, UserOperation op, object result)");
        StringAssert.Contains(subscriptionSource, "public static void PostExecute(UInt160 accountId, UserOperation op, object result)");
    }

    [TestMethod]
    public void MultiSigPropagatesVerifierPostExecutionEffectsToChildVerifiers()
    {
        string source = ReadContractFile("verifiers/MultiSigVerifier.cs");

        StringAssert.Contains(source, "public static void PostExecute(UInt160 accountId, UserOperation op, object result)");
        StringAssert.Contains(
            source,
            "Contract.Call(config.Verifiers[i], \"postExecute\", CallFlags.All, new object[] { accountId, subOp, result });");
    }

    [TestMethod]
    public void SessionAndSubscriptionPostExecuteDoNotTreatBusinessReturnValuesAsExecutionFailure()
    {
        string sessionSource = ReadContractFile("verifiers/SessionKeyVerifier.cs");
        string subscriptionSource = ReadContractFile("verifiers/SubscriptionVerifier.cs");

        Assert.IsFalse(sessionSource.Contains("DidExecutionSucceed(result)", StringComparison.Ordinal));
        Assert.IsFalse(subscriptionSource.Contains("DidExecutionSucceed(result)", StringComparison.Ordinal));
        Assert.IsFalse(sessionSource.Contains("private static bool DidExecutionSucceed", StringComparison.Ordinal));
        Assert.IsFalse(subscriptionSource.Contains("private static bool DidExecutionSucceed", StringComparison.Ordinal));
    }

    [TestMethod]
    public void SourceInvariantSuiteDoesNotClaimBehavioralFuzzCoverage()
    {
        string source = File.ReadAllText(Path.Combine(RepoRoot, "tests", "AbstractAccount.Contracts.Tests", "SourceInvariantTests.cs"));

        Assert.IsFalse(source.Contains("Fuzz_", StringComparison.Ordinal));
        Assert.IsFalse(source.Contains("fuzz tests", StringComparison.OrdinalIgnoreCase));
        Assert.IsFalse(source.Contains("fuzzing", StringComparison.OrdinalIgnoreCase));
    }

    [TestMethod]
    public void VerifierProjectsCompileSharedAuthorityHelper()
    {
        string[] verifierProjects =
        {
            "verifiers/Web3AuthVerifier.csproj",
            "verifiers/TEEVerifier.csproj",
            "verifiers/WebAuthnVerifier.csproj",
            "verifiers/SessionKeyVerifier.csproj",
            "verifiers/MultiSigVerifier.csproj",
            "verifiers/SubscriptionVerifier.csproj",
            "verifiers/ZKEmailVerifier.csproj",
            "verifiers/ZkLoginVerifier.csproj",
        };

        foreach (string project in verifierProjects)
        {
            string projectFile = ReadContractFile(project);
            StringAssert.Contains(projectFile, "<Compile Include=\"VerifierAuthority.cs\" />");
        }
    }

    private const string PinnedFrameworkVersion = "3.9.1";

    [TestMethod]
    public void ContractSubprojectsUseConsistentFrameworkVersionAndOptInNccs()
    {
        foreach (string project in ContractProjectFiles)
        {
            string projectFile = ReadContractFile(project);
            StringAssert.Contains(
                projectFile,
                $"<PackageReference Include=\"Neo.SmartContract.Framework\" Version=\"{PinnedFrameworkVersion}\" />");
            StringAssert.Contains(projectFile, "<RunNccsAfterBuild>false</RunNccsAfterBuild>");
            StringAssert.Contains(projectFile, "Condition=\"'$(RunNccsAfterBuild)' == 'true'\"");
        }
    }

    // ========================================================================
    // Paymaster Contract Tests
    // ========================================================================

    [TestMethod]
    public void PaymasterContractHasCorrectMetadata()
    {
        string source = ReadContractFile("paymaster/Paymaster.cs");

        StringAssert.Contains(source, "[DisplayName(\"AAPaymaster\")]");
        StringAssert.Contains(source, "On-Chain Paymaster for Sponsored Transactions on Neo N3 AA");
        StringAssert.Contains(source, "0xd2a4cff31913016155e38e474a2c06d08be276cf");
    }

    [TestMethod]
    public void PaymasterExposesAllRequiredEntrypoints()
    {
        string source = ReadContractFile("paymaster/Paymaster.cs");

        string[] requiredMethods =
        {
            "OnNEP17Payment",
            "WithdrawDeposit",
            "SetPolicy",
            "RevokePolicy",
            "ValidatePaymasterOp",
            "SettleReimbursement",
            "GetSponsorDeposit",
            "GetPolicy",
            "GetDailySpent",
            "GetTotalSpent",
            "SetAuthorizedCore",
            "RotateAdmin",
            "ConfirmAdminRotation",
            "CancelAdminRotation",
            "Update",
        };

        foreach (string method in requiredMethods)
        {
            StringAssert.Contains(source, method, $"Missing entrypoint: {method}");
        }
    }

    [TestMethod]
    public void PaymasterOnlyAcceptsGAS()
    {
        string source = ReadContractFile("paymaster/Paymaster.cs");

        StringAssert.Contains(source, "Runtime.CallingScriptHash == GAS.Hash");
        StringAssert.Contains(source, "Only GAS accepted");
    }

    [TestMethod]
    public void PaymasterSettlementOnlyCallableByCore()
    {
        string source = ReadContractFile("paymaster/Paymaster.cs");

        StringAssert.Contains(source, "PaymasterAuthority.ValidateCoreCaller()");
    }

    [TestMethod]
    public void PaymasterFollowsChecksEffectsInteractionsPattern()
    {
        string source = ReadContractFile("paymaster/Paymaster.cs");

        // In SettleReimbursement: deposit deducted BEFORE GAS transfer
        int deductIndex = source.IndexOf("SetSponsorDeposit(sponsor!, deposit - amount)", StringComparison.Ordinal);
        int transferIndex = source.IndexOf("GAS.Hash, \"transfer\", CallFlags.All", deductIndex, StringComparison.Ordinal);
        Assert.IsTrue(deductIndex > 0 && transferIndex > deductIndex,
            "Deposit must be deducted before GAS transfer (checks-effects-interactions)");
    }

    [TestMethod]
    public void PaymasterHasOverflowProtection()
    {
        string source = ReadContractFile("paymaster/Paymaster.cs");

        StringAssert.Contains(source, "Deposit overflow");
        StringAssert.Contains(source, "Daily spend overflow");
        StringAssert.Contains(source, "Total spend overflow");
    }

    [TestMethod]
    public void PaymasterStoragePrefixesAreUnique()
    {
        string source = ReadContractFile("paymaster/Paymaster.cs");

        var expectedPrefixes = new (byte Value, string Name)[]
        {
            (0x01, "Prefix_SponsorDeposit"),
            (0x02, "Prefix_Policy"),
            (0x03, "Prefix_DailySpent"),
            (0x04, "Prefix_DailyReset"),
            (0x05, "Prefix_TotalSpent"),
        };

        var values = new System.Collections.Generic.HashSet<byte>();
        foreach (var (value, name) in expectedPrefixes)
        {
            StringAssert.Contains(source, name);
            Assert.IsTrue(values.Add(value), $"Duplicate prefix 0x{value:X2} for {name}");
        }
    }

    [TestMethod]
    public void PaymasterAuthorityPrefixesDoNotCollideWithPaymasterPrefixes()
    {
        string authoritySource = ReadContractFile("paymaster/PaymasterAuthority.cs");
        string paymasterSource = ReadContractFile("paymaster/Paymaster.cs");

        // Authority uses 0xD0-0xD3, Paymaster uses 0x01-0x05 — no collision
        StringAssert.Contains(authoritySource, "0xD0");
        StringAssert.Contains(authoritySource, "0xD1");
        StringAssert.Contains(authoritySource, "0xD2");
        StringAssert.Contains(authoritySource, "0xD3");

        Assert.IsFalse(paymasterSource.Contains("0xD0", StringComparison.Ordinal));
        Assert.IsFalse(paymasterSource.Contains("0xD1", StringComparison.Ordinal));
    }

    [TestMethod]
    public void PaymasterProjectCompilesSharedAuthorityHelper()
    {
        string projectFile = ReadContractFile("paymaster/Paymaster.csproj");

        StringAssert.Contains(projectFile, "<Compile Include=\"PaymasterAuthority.cs\" />");
        StringAssert.Contains(projectFile, "<Compile Include=\"Paymaster.cs\" />");
    }

    [TestMethod]
    public void PaymasterAuthorityUsesTimelockForAdminRotation()
    {
        string source = ReadContractFile("paymaster/PaymasterAuthority.cs");

        StringAssert.Contains(source, "AdminRotationTimelockMs = 7L * 24 * 60 * 60 * 1000");
        StringAssert.Contains(source, "Admin rotation timelock not expired");
        StringAssert.Contains(source, "Pending admin mismatch");
    }

    [TestMethod]
    public void VerifierAndHookAuthorityUseRuntimeMillisecondsForAdminRotation()
    {
        string verifierSource = ReadContractFile("verifiers/VerifierAuthority.cs");
        string hookSource = ReadContractFile("hooks/HookAuthority.cs");

        StringAssert.Contains(verifierSource, "AdminRotationTimelockMs = 7L * 24 * 60 * 60 * 1000");
        StringAssert.Contains(hookSource, "AdminRotationTimelockMs = 7L * 24 * 60 * 60 * 1000");
        Assert.IsFalse(verifierSource.Contains("AdminRotationTimelockSeconds", StringComparison.Ordinal));
        Assert.IsFalse(hookSource.Contains("AdminRotationTimelockSeconds", StringComparison.Ordinal));
    }

    [TestMethod]
    public void VerifierAndHookAuthorityRequireNewAdminWitnessForRotationConfirmation()
    {
        string verifierSource = ReadContractFile("verifiers/VerifierAuthority.cs");
        string hookSource = ReadContractFile("hooks/HookAuthority.cs");

        StringAssert.Contains(verifierSource, "Runtime.CheckWitness(newAdmin)");
        StringAssert.Contains(hookSource, "Runtime.CheckWitness(newAdmin)");
    }

    [TestMethod]
    public void PaymasterEventsAreComplete()
    {
        string source = ReadContractFile("paymaster/Paymaster.cs");

        string[] requiredEvents =
        {
            "Deposited", "Withdrawn", "PolicyCreated", "PolicyRevoked", "Reimbursed"
        };

        foreach (string evt in requiredEvents)
        {
            StringAssert.Contains(source, $"[DisplayName(\"{evt}\")]", $"Event {evt} declared");
            StringAssert.Contains(source, $"On{evt}", $"On{evt} raised in code");
        }
    }

    [TestMethod]
    public void PaymasterValidatePaymasterOpIsSafe()
    {
        string source = ReadContractFile("paymaster/Paymaster.cs");

        // Extract the block from [Safe] to the next public method
        int safeIdx = source.IndexOf("[Safe]\n        public static bool ValidatePaymasterOp", StringComparison.Ordinal);
        Assert.IsTrue(safeIdx >= 0, "ValidatePaymasterOp must have [Safe] attribute");

        // Find the method body
        int braceStart = source.IndexOf('{', safeIdx);
        int depth = 1, pos = braceStart + 1;
        while (pos < source.Length && depth > 0)
        {
            if (source[pos] == '{') depth++;
            else if (source[pos] == '}') depth--;
            pos++;
        }
        string methodBody = source[safeIdx..pos];

        Assert.IsFalse(methodBody.Contains("Storage.Put(", StringComparison.Ordinal),
            "ValidatePaymasterOp must not mutate storage");
        Assert.IsFalse(methodBody.Contains("Storage.Delete(", StringComparison.Ordinal),
            "ValidatePaymasterOp must not delete storage");
        Assert.IsFalse(methodBody.Contains("Contract.Call(", StringComparison.Ordinal),
            "ValidatePaymasterOp must not call other contracts");
    }

    [TestMethod]
    public void SponsoredExecutionEntrypointsExistInCore()
    {
        string source = ReadContractFile("UnifiedSmartWallet.Paymaster.cs");

        StringAssert.Contains(source, "public static object ExecuteSponsoredUserOp(");
        StringAssert.Contains(source, "public static object[] ExecuteSponsoredUserOps(");
        StringAssert.Contains(source, "settleReimbursement");
        StringAssert.Contains(source, "CallFlags.All");
        StringAssert.Contains(source, "Runtime.Transaction.Sender");
        StringAssert.Contains(source, "OnSponsoredUserOpExecuted");

        // C-2 fix: verify paymaster trust check
        StringAssert.Contains(source, "authorizedCore");
        StringAssert.Contains(source, "Paymaster not bound to this core");

        // M-2 fix: accountId validation
        StringAssert.Contains(source, "AccountId required");

        // H-2 fix: batch ops must share target/method
        StringAssert.Contains(source, "Batch ops must share target contract");
        StringAssert.Contains(source, "Batch ops must share method");
    }

    [TestMethod]
    public void SponsoredExecutionEventDeclaredInEvents()
    {
        string source = ReadContractFile("UnifiedSmartWallet.Events.cs");

        StringAssert.Contains(source, "SponsoredUserOpExecutedDelegate");
        StringAssert.Contains(source, "[DisplayName(\"SponsoredUserOpExecuted\")]");
        StringAssert.Contains(source, "OnSponsoredUserOpExecuted");
    }

    [TestMethod]
    public void PaymasterGasPermissionIsTightened()
    {
        string source = ReadContractFile("paymaster/Paymaster.cs");

        // Must use specific GAS hash, not wildcard
        StringAssert.Contains(source,
            "[ContractPermission(\"0xd2a4cff31913016155e38e474a2c06d08be276cf\", \"transfer\")]");
    }

    [TestMethod]
    public void PaymasterSupportsGlobalPolicyFallback()
    {
        string source = ReadContractFile("paymaster/Paymaster.cs");

        StringAssert.Contains(source, "ResolvePolicy(sponsor, accountId, out UInt160 spendingKey)");
        StringAssert.Contains(source, "ReadPolicy(sponsor, UInt160.Zero)");
        StringAssert.Contains(source, "spendingAccountId = UInt160.Zero");
    }
}
