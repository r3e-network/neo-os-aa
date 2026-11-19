using System.ComponentModel;
using System.IO;
using System.Linq;
using System.Reflection;
using System;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace SmartAccount.Contracts.Tests;

[TestClass]
public class ContractTests
{
    private static readonly string RepoRoot =
        Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));

    private static readonly string ContractsDir = Path.Combine(RepoRoot, "contracts");

    // The user-contract core: its partials are named bare, as SmartAccount.csproj lists them.
    private static readonly string CoreDir = Path.Combine(ContractsDir, "custom");

    private static readonly string[] SmartAccountFiles =
    {
        "SmartAccount.cs",
        "SmartAccount.ModuleProtocol.cs",
        "SmartAccount.Models.cs",
        "SmartAccount.Modules.cs",
        "SmartAccount.Intents.cs",
        "SmartAccount.Nonce.cs",
        "SmartAccount.Message.cs",
        "SmartAccount.Internal.cs",
        "SmartAccount.Events.cs",
        "SmartAccount.Accounts.cs",
        "SmartAccount.Migration.cs",
        "SmartAccount.PlatformRegistrar.cs",
        "SmartAccount.Proxy.cs",
        "SmartAccount.State.cs",
        "SmartAccount.Execution.cs",
        "SmartAccount.VerifyContext.cs",
        "SmartAccount.Escape.cs",
        "SmartAccount.MarketEscrow.cs",
        "SmartAccount.Admin.cs",
        "SmartAccount.Paymaster.cs"
    };

    private static readonly string[] HookFiles =
    {
        "plugins/hooks/HookAuthority.cs",
        "plugins/hooks/WhitelistHook.cs",
        "plugins/hooks/DailyLimitHook.cs",
        "plugins/hooks/TokenRestrictedHook.cs",
        "plugins/hooks/MultiHook.cs",
        "plugins/hooks/NeoDIDCredentialHook.cs"
    };

    private static readonly string[] VerifierFiles =
    {
        "plugins/validators/ValidatorAuthority.cs",
        "plugins/validators/Web3AuthValidator.cs",
        "plugins/validators/TeeKeyValidator.cs",
        "plugins/validators/P256Validator.cs",
        "plugins/validators/SessionKeyValidator.cs",
        "plugins/validators/MultiSigValidator.cs",
        "plugins/validators/SubscriptionValidator.cs",
        "plugins/validators/ZKEmailVerifier.cs",
        "plugins/validators/DelegatedIdentityValidator.cs"
    };

    private static readonly string[] ContractProjectFiles =
    {
        "custom/SmartAccount.csproj",
        "plugins/hooks/DailyLimitHook.csproj",
        "plugins/hooks/MultiHook.csproj",
        "plugins/hooks/NeoDIDCredentialHook.csproj",
        "plugins/hooks/TokenRestrictedHook.csproj",
        "plugins/hooks/WhitelistHook.csproj",
        "custom/market/SAAddressMarket.csproj",
        "../tests/mocks/MarkerOnlyModule.csproj",
        "../tests/mocks/MockTransferTarget.csproj",
        "custom/paymaster/Paymaster.csproj",
        "custom/registrar/PlatformRegistrar.csproj",
        "plugins/validators/MultiSigValidator.csproj",
        "plugins/validators/SessionKeyValidator.csproj",
        "plugins/validators/SubscriptionValidator.csproj",
        "plugins/validators/TeeKeyValidator.csproj",
        "plugins/validators/Web3AuthValidator.csproj",
        "plugins/validators/P256Validator.csproj",
        "plugins/validators/ZKEmailVerifier.csproj",
        "plugins/validators/DelegatedIdentityValidator.csproj",
    };

    private static Type ContractType => typeof(global::SmartAccount.SmartAccount);

    private static int CountOccurrences(string text, string needle)
    {
        int count = 0;
        for (int at = text.IndexOf(needle, StringComparison.Ordinal);
             at >= 0;
             at = text.IndexOf(needle, at + needle.Length, StringComparison.Ordinal))
        {
            count++;
        }

        return count;
    }

    // Contract source pins use "\n" line endings; the repository may be checked out
    // with CRLF on Windows, so normalize every read before pattern matching.
    private static string NormalizeLineEndings(string text) =>
        text.Replace("\r\n", "\n").Replace("\r", "\n");

    private static string ReadContractFile(string fileName) =>
        NormalizeLineEndings(File.ReadAllText(Path.Combine(ContractsDir, fileName)));

    private static string ReadCoreFile(string fileName) =>
        NormalizeLineEndings(File.ReadAllText(Path.Combine(CoreDir, fileName)));

    private static string ReadCombinedSource() =>
        string.Join("\n\n", SmartAccountFiles.Select(ReadCoreFile));

    private static string ExtractSourceBlock(string source, string startMarker, string endMarker)
    {
        int start = source.IndexOf(startMarker, StringComparison.Ordinal);
        Assert.IsTrue(start >= 0, $"Missing source marker: {startMarker}");

        int end = source.IndexOf(endMarker, start, StringComparison.Ordinal);
        Assert.IsTrue(end > start, $"Missing source marker: {endMarker}");

        return source[start..end];
    }

    [TestMethod]
    public void ContractAssemblyExposesSmartAccountMetadata()
    {
        Assert.AreEqual("SmartAccount", ContractType.Name);

        DisplayNameAttribute? displayName = ContractType.GetCustomAttribute<DisplayNameAttribute>();
        Assert.IsNotNull(displayName);
        Assert.AreEqual("SmartAccount", displayName.DisplayName);

        CustomAttributeData? manifestExtra = ContractType.CustomAttributes
            .FirstOrDefault(attribute => attribute.AttributeType.Name == "ManifestExtraAttribute");

        Assert.IsNotNull(manifestExtra);
        Assert.AreEqual(2, manifestExtra!.ConstructorArguments.Count);
        Assert.AreEqual("Description", manifestExtra.ConstructorArguments[0].Value);
        Assert.AreEqual(
            "ERC-7579-aligned SA module-model kernel for Neo N3",
            manifestExtra.ConstructorArguments[1].Value);
    }

    [TestMethod]
    public void ContractExposesCanonicalV4Entrypoints()
    {
        // Protocol v4 replaces the v3 register/update/call-verifier surface with
        // the module-model kernel: atomic account creation, timelocked
        // configuration intents, the canonical executeUserOp envelope, recovery
        // and the service boundaries (market, registrar, paymaster, admin).
        // Names are the C# declarations; nccs lowercases the first letter in the
        // manifest, and Contract.Call targets that manifest form.
        string[] requiredMethods =
        {
            "ComputeAccountIdentity",
            "createAccount",
            "createAccounts",
            "proposeConfiguration",
            "confirmConfiguration",
            "cancelConfiguration",
            "executeUserOp",
            "executeUserOps",
            "ExecuteSponsoredUserOp",
            "ExecuteSponsoredUserOps",
            "beginRecovery",
            "cancelRecovery",
            "executeRecovery",
            "freezeAccount",
            "unfreezeAccount",
            // Phase 1b service-boundary entries.
            "EnterMarketEscrow",
            "CancelMarketEscrow",
            "SettleMarketEscrow",
            "SetMarketService",
            "IsMarketService",
            "ApplyPlatformAccountOwnerRotation",
            "GetPlatformAccountBinding",
            "ProposePlatformRegistrar",
            "ConfirmPlatformRegistrar",
            "CancelPlatformRegistrar",
            "getAccount",
            "getModules",
            "getHookOrder",
            "getRecoveryStatus",
            "getProtocolInfo",
            "getOperationDigest",
            "isValidSignature",
            "Verify",
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
    public void SmartAccountProjectCompilesAllPartialModules()
    {
        string projectFile = File.ReadAllText(Path.Combine(CoreDir, "SmartAccount.csproj"));
        foreach (string fileName in SmartAccountFiles)
        {
            StringAssert.Contains(projectFile, $"<Compile Include=\"{fileName}\" />");
            Assert.IsTrue(File.Exists(Path.Combine(CoreDir, fileName)), $"Missing source file: {fileName}");
        }
    }

    [TestMethod]
    public void ExecutionPathKeepsFixedCallFlagsAll()
    {
        string executionSource = ReadCoreFile("SmartAccount.Execution.cs");

        StringAssert.Contains(
            executionSource,
            "object result = Contract.Call(target, (string)method, CallFlags.All, executionArgs);");
        Assert.IsFalse(executionSource.Contains("op.CallFlags", StringComparison.Ordinal));
        StringAssert.Contains(executionSource, "ConsumeOperationNonce(accountId, channel, namespaceDigest, sequence);");
        StringAssert.Contains(executionSource, "AssertNoMarketEscrow(accountId);");
        StringAssert.Contains(executionSource, "SetVerifyContext(accountId, target);");
        StringAssert.Contains(executionSource, "ClearVerifyContext(accountId);");
        // Module callbacks never reach a raw Contract.Call from the execution
        // kernel: the dispatched target is the only unbounded call, and every
        // callback goes through the bounded gate in the module-callback helpers.
        Assert.AreEqual(
            1,
            CountOccurrences(executionSource, "Contract.Call("),
            "the dispatched target call must be the only raw contract call in the execution kernel");
        StringAssert.Contains(executionSource, "CallModuleGasCapped(");
    }

    [TestMethod]
    public void CreateAccountBindsAccountIdToRegistrationParameters()
    {
        string accountsSource = ReadCoreFile("SmartAccount.Accounts.cs");

        StringAssert.Contains(accountsSource, "Custody required");
        StringAssert.Contains(accountsSource, "Account already exists");
        StringAssert.Contains(accountsSource, "Custody witness required");
        StringAssert.Contains(accountsSource, "public static UInt160 ComputeAccountIdentity(UInt160 custody, ByteString salt)");
        StringAssert.Contains(accountsSource, "public static void createAccounts(");
        StringAssert.Contains(accountsSource, "Account batch size must be 1-64");
        StringAssert.Contains(
            accountsSource,
            "CreateAccountCore(ids[i], custody, saltList[i], recoveryTimelockMs, new object[0], true, null);");
        StringAssert.Contains(
            accountsSource,
            "ExecutionEngine.Assert(accountId == expected, \"Account id does not match registration parameters\");");
        StringAssert.Contains(accountsSource, "UInt160 expected = expectedAccountId ?? ComputeAccountIdentity(custody!, salt!);");
    }

    [TestMethod]
    public void PluginConfigurationHasNoCallerSuppliedMethodAllowlist()
    {
        // v3 reached plugins through a name allowlist, which left every future
        // plugin method one omission away from being callable. v4 configuration
        // is a fixed set of typed action codes that terminate in the module's
        // own lifecycle callback, so no caller-supplied method name exists.
        string accountsSource = ReadCoreFile("SmartAccount.Accounts.cs");
        string modulesSource = ReadCoreFile("SmartAccount.Modules.cs");
        string sessionSource = ReadContractFile("plugins/validators/SessionKeyValidator.cs");

        Assert.IsFalse(accountsSource.Contains("AllowedVerifierMethods", StringComparison.Ordinal));
        Assert.IsFalse(accountsSource.Contains("AllowedHookMethods", StringComparison.Ordinal));
        StringAssert.Contains(modulesSource, "CallModuleLifecycle(accountId, moduleId, module, \"configure\", configData!);");

        // The immediate key-rotation hole is closed inside the validator: the
        // grant cannot be swapped inside the cooldown, so a fresh key cannot
        // reset the spending window.
        StringAssert.Contains(sessionSource, "Key rotation cooldown active (24h)");
        StringAssert.Contains(
            sessionSource,
            "// Do NOT reset spending tracking — prevent spending limit bypass via key rotation");
    }

    [TestMethod]
    public void PluginConfigurationRequiresAProposedIntentAfterTimelock()
    {
        string intentsSource = ReadCoreFile("SmartAccount.Intents.cs");
        string protocolSource = ReadCoreFile("SmartAccount.ModuleProtocol.cs");

        StringAssert.Contains(
            intentsSource,
            "public static BigInteger proposeConfiguration(UInt160 accountId, object[] actions, ByteString[] readSet)");
        StringAssert.Contains(intentsSource, "intent.MatureAt = now + ModuleChangeDelayMs;");
        StringAssert.Contains(intentsSource, "ExecutionEngine.Assert(now >= record!.MatureAt, ErrorIntentImmature);");
        StringAssert.Contains(intentsSource, "ExecutionEngine.Assert(now <= record.ExpiresAt, ErrorIntentExpired);");
        StringAssert.Contains(intentsSource, "private static ByteString ComputeActionsDigest(object[] actions)");
        StringAssert.Contains(
            intentsSource,
            "ExecutionEngine.Assert(ComputeActionsDigest(actions!) == record.ActionDigest, ErrorOperationMalformed);");
        StringAssert.Contains(intentsSource, "DropConfigurationIntent(accountId, intentId);");
        StringAssert.Contains(protocolSource, "ModuleChangeDelayMs = 86_400_000");
    }

    [TestMethod]
    public void ExecutionPathAppliesValidatorCompletionAfterSuccessfulCalls()
    {
        string executionSource = ReadCoreFile("SmartAccount.Execution.cs");
        string modulesSource = ReadCoreFile("SmartAccount.Modules.cs");

        StringAssert.Contains(executionSource, "CallValidatorOnUserOpComplete(");
        StringAssert.Contains(
            modulesSource,
            "module.ContractHash, \"onUserOpComplete\", CallFlags.All, CompletionPerCallGasLimit,");
        StringAssert.Contains(modulesSource, "EnterModulePhase(accountId, ctx, PhaseCompletion, moduleId);");
        StringAssert.Contains(modulesSource, "ChargeCallbackGas(ctx, GasPoolCompletion, gasBefore, CompletionPerCallGasLimit);");
        // Completion runs only for the routed validator or for the members that
        // actually approved, and only after the target dispatch returned.
        StringAssert.Contains(executionSource, "if (approvedMembers[i] == 0) break;");
        StringAssert.Contains(executionSource, "approvedMembers[i], approvedModules[i], op, result);");
    }

    [TestMethod]
    public void BoundedModuleCallbackSyscallIsDeclaredOnceAndBehindOneGate()
    {
        // No published Neo.SmartContract.Framework declares
        // System.Contract.CallWithGasLimit, so the contract declares the syscall
        // itself in the PLATFORM build. The compiled bytes are checked separately
        // in CompiledCoreSyscallTests; this pins the source shape and the single
        // gate every module callback passes through.
        string executionSource = ReadCoreFile("SmartAccount.Execution.cs");
        string modulesSource = ReadCoreFile("SmartAccount.Modules.cs");

        StringAssert.Contains(executionSource, "[Syscall(\"System.Contract.CallWithGasLimit\")]");
        StringAssert.Contains(executionSource, "public static extern object CallWithGasLimit(");
        StringAssert.Contains(
            executionSource,
            "UInt160 scriptHash, string method, CallFlags flags, long gasLimit, params object?[]? args);");
        Assert.AreEqual(
            1,
            CountOccurrences(modulesSource, "PlatformSyscalls.CallWithGasLimit("),
            "the platform syscall is reached from exactly one gate");
        Assert.IsFalse(
            executionSource.Contains("Contract.CallWithGasLimit(", StringComparison.Ordinal),
            "the framework-declared form does not exist in any published framework");

        // Public builds cannot reach that syscall: the same gate carries the
        // documented degradation branch instead of calling modules directly.
        StringAssert.Contains(modulesSource, "#if PLATFORM");
        StringAssert.Contains(modulesSource, "PLAN A DEGRADATION");
        StringAssert.Contains(modulesSource, "#else");
        Assert.AreEqual(
            2,
            CountOccurrences(
                modulesSource,
                "private static object CallModuleGasCapped(UInt160 scriptHash, string method, CallFlags flags, long gasLimit, object[] args) =>"),
            "one gate, one implementation per build branch");

        int declarations = Directory.EnumerateFiles(ContractsDir, "*.cs", SearchOption.AllDirectories)
            .Where(path => !path.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}", StringComparison.Ordinal))
            .Sum(path => CountOccurrences(File.ReadAllText(path), "[Syscall(\"System.Contract.CallWithGasLimit\")]"));
        Assert.AreEqual(1, declarations, "the syscall must be declared exactly once");
    }

    [TestMethod]
    public void HookCallbacksReceiveTheCanonicalOperationViewInPreAndPostPhases()
    {
        string modulesSource = ReadCoreFile("SmartAccount.Modules.cs");
        string executionSource = ReadCoreFile("SmartAccount.Execution.cs");

        // The 13-field canonical operation is rebuilt field by field, with deep
        // copies of the two nested arrays, so a hook can neither observe a
        // Struct nor mutate the authenticated operation the target executes.
        StringAssert.Contains(modulesSource, "private static object[] BuildCanonicalOperationView(object[] operation)");
        StringAssert.Contains(modulesSource, "operation[OpVersion],");
        StringAssert.Contains(modulesSource, "operation[OpSignature],");
        StringAssert.Contains(modulesSource, "CloneOperationArguments((object[])operation[OpArgs]),");
        StringAssert.Contains(modulesSource, "CloneOperationArguments((object[])operation[OpHookProofs])");
        StringAssert.Contains(
            modulesSource,
            "new object[] { accountId, BuildCanonicalOperationView(operation) });");
        StringAssert.Contains(
            modulesSource,
            "new object[] { accountId, BuildCanonicalOperationView(operation), CloneCallbackValue(result)!, hookData });");
        StringAssert.Contains(executionSource, "object[] executionArgs = CloneOperationArguments((object[])op[OpArgs]);");
        StringAssert.Contains(executionSource, "ByteString[] hookData = new ByteString[hookCount];");
        // postCheck runs in reverse over the ORIGINAL pre-approved snapshot and
        // receives exactly the hookData its own instance returned.
        StringAssert.Contains(executionSource, "for (int i = hookCount - 1; i >= 0; i--)");
        StringAssert.Contains(
            executionSource,
            "CallHookPostCheck(accountId, ctx, hookOrder.HookIds[i], hookModules[i], op, result, hookData[i]);");
        StringAssert.Contains(executionSource, "private static object[] CloneOperationArguments(object[] args)");
        StringAssert.Contains(executionSource, "private static object? CloneCallbackValue(object? value)");
    }

    [TestMethod]
    public void MultiHookChildCompositionIsRetiredInProtocolV4()
    {
        string source = ReadContractFile("plugins/hooks/MultiHook.cs");

        // v4 owns composition (the per-account hookOrder), so the composable
        // hook has no children to fan out to — and the shared-mutable-array
        // problem it used to mitigate does not exist.
        StringAssert.Contains(source, "MultiHook is not installable in protocol v4; use the core hookOrder");
        StringAssert.Contains(source, "MultiHook is retired in protocol v4");
        Assert.IsFalse(source.Contains("CloneHookParams", StringComparison.Ordinal));
        Assert.IsFalse(source.Contains("Contract.Call(", StringComparison.Ordinal));

        string modulesSource = ReadCoreFile("SmartAccount.Modules.cs");
        StringAssert.Contains(modulesSource, "private static HookOrderRecord AppendHookToOrder(UInt160 accountId, BigInteger hookId)");
        StringAssert.Contains(modulesSource, "private static HookOrderRecord RemoveHookFromOrder(UInt160 accountId, BigInteger hookId)");
        StringAssert.Contains(modulesSource, "private static void PutHookOrder(UInt160 accountId, HookOrderRecord order)");
        StringAssert.Contains(modulesSource, "case ActionSetHookOrder:");
    }

    [TestMethod]
    public void CallbackResultIsolationDocumentsUnsupportedInteropBoundary()
    {
        string executionSource = ReadCoreFile("SmartAccount.Execution.cs");
        string securityModel = File.ReadAllText(Path.Combine(RepoRoot, "docs", "SECURITY_MODEL.md"));

        StringAssert.Contains(executionSource, "StdLib.Deserialize(StdLib.Serialize(value))");
        StringAssert.Contains(securityModel, "InteropInterface values (including iterators and storage contexts)");
        StringAssert.Contains(securityModel, "repeated container references fail closed before post callbacks");
    }

    [TestMethod]
    public void MarketEscrowSettlementWipesInheritedVerifierAndHookState()
    {
        string marketSource = ReadCoreFile("SmartAccount.MarketEscrow.cs");

        StringAssert.Contains(marketSource, "state.Verifier = UInt160.Zero;");
        StringAssert.Contains(marketSource, "state.HookId = UInt160.Zero;");
        StringAssert.Contains(marketSource, "state.EscapeTriggeredAt = BigInteger.Zero;");
        StringAssert.Contains(marketSource, "Account locked in market escrow");
        StringAssert.Contains(marketSource, "Only escrow market");
    }

    [TestMethod]
    public void CombinedSourceDocumentsV4RegistrationAndExecutionFlow()
    {
        string source = ReadCombinedSource();

        StringAssert.Contains(source, "createAccount");
        StringAssert.Contains(source, "executeUserOp");
        StringAssert.Contains(source, "Custody required");
        StringAssert.Contains(source, "ErrorValidationRejected");
        StringAssert.Contains(source, "VerifyHookProofsAgainstSnapshot");
        StringAssert.Contains(source, "InitializeDefaultMessageSubjects");
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

        StringAssert.Contains(ReadContractFile("plugins/hooks/HookAuthority.cs"), "ModuleContext.RequireLifecycle(Core(), accountId, moduleId);");
        StringAssert.Contains(ReadContractFile("plugins/hooks/HookAuthority.cs"), "ModuleContext.RequireInstance(Core(), accountId, ModulePhase.HookPre);");
        StringAssert.Contains(ReadContractFile("plugins/hooks/HookAuthority.cs"), "ModuleContext.RequireInstance(Core(), accountId, ModulePhase.HookPost);");
        foreach (string fileName in HookFiles.Where(path => path != "plugins/hooks/HookAuthority.cs"))
        {
            string source = ReadContractFile(fileName);
            StringAssert.Contains(
                source,
                "HookAuthority.RequirePreCheck(accountId, operation);",
                $"Core authority preCheck missing from {fileName}");
            StringAssert.Contains(
                source,
                "HookAuthority.RequirePostCheck(accountId, operation);",
                $"Core authority postCheck missing from {fileName}");
        }
    }

    [TestMethod]
    public void CoreRecordsTheHookWriterPhaseForTrustedPluginCalls()
    {
        string modelsSource = ReadCoreFile("SmartAccount.Models.cs");
        string modulesSource = ReadCoreFile("SmartAccount.Modules.cs");
        string executionSource = ReadCoreFile("SmartAccount.Execution.cs");

        // v3 tracked a hook "execution context" blob; v4 publishes the writer
        // phase itself (0x58), so a plugin authenticates through
        // getAuthorizedModuleId(accountId, phase) and gets its own instance id
        // back only while the core is actually running that phase for it.
        StringAssert.Contains(modelsSource, "private const byte PhaseHookPre = 2;");
        StringAssert.Contains(modelsSource, "private const byte PhaseTargetDispatch = 3;");
        StringAssert.Contains(modelsSource, "private const byte PhaseHookPost = 4;");
        StringAssert.Contains(modulesSource, "EnterModulePhase(accountId, ctx, PhaseHookPre, moduleId);");
        StringAssert.Contains(modulesSource, "EnterModulePhase(accountId, ctx, PhaseHookPost, moduleId);");
        StringAssert.Contains(executionSource, "EnterModulePhase(accountId, ctx, PhaseTargetDispatch, BigInteger.Zero);");
        StringAssert.Contains(modulesSource, "public static BigInteger getAuthorizedModuleId(UInt160 accountId, byte phase)");
        StringAssert.Contains(
            modulesSource,
            "if (ctx == null || ctx.Phase != phase || ctx.ActiveModuleId <= 0) return BigInteger.MinusOne;");
        StringAssert.Contains(modulesSource, "if (Runtime.CallingScriptHash != module.ContractHash) return BigInteger.MinusOne;");
    }

    [TestMethod]
    public void HookProjectsCompileSharedAuthorityHelper()
    {
        string[] hookProjects =
        {
            "plugins/hooks/WhitelistHook.csproj",
            "plugins/hooks/DailyLimitHook.csproj",
            "plugins/hooks/TokenRestrictedHook.csproj",
            "plugins/hooks/MultiHook.csproj",
            "plugins/hooks/NeoDIDCredentialHook.csproj",
        };

        foreach (string project in hookProjects)
        {
            string projectFile = ReadContractFile(project);
            StringAssert.Contains(projectFile, "<Compile Include=\"HookAuthority.cs\" />");
        }
    }

    [TestMethod]
    public void DailyLimitHookAlwaysMetersActualOutflow()
    {
        string source = ReadContractFile("plugins/hooks/DailyLimitHook.cs");

        StringAssert.Contains(source, "public static void PostCheck(UInt160 accountId, object[] operation, object result, ByteString hookData)");
        Assert.IsFalse(source.Contains("if (!DidExecutionSucceed(result)) return;", StringComparison.Ordinal));
        // The account's assets leave from the proxy script hash, not from the
        // accountId itself, so the protected-source check compares that address.
        StringAssert.Contains(source, "ExecutionEngine.Assert(IsProtectedTransferSource(accountId, fromAccount), \"Transfer source not permitted\");");
        StringAssert.Contains(source, "return from == HookAuthority.AssetAddress(accountId);");
        // Measured balance delta is the authoritative meter: a router/intermediary
        // hop cannot slip past the limit by hiding the token from the target.
        StringAssert.Contains(source, "SnapshotAllLimitedBalances(accountId, moduleId);");
        StringAssert.Contains(source, "MeterAllLimitedOutflows(accountId, moduleId, directToken, declaredAmount);");
        Assert.IsFalse(source.Contains("Storage.Put(Storage.CurrentContext, spentKey, newTotal);", StringComparison.Ordinal));
    }

    [TestMethod]
    public void CoreHookOrderRejectsUnsafeHookTopologies()
    {
        // Composition moved from the composable hook into the core. The order
        // must be exactly the installed hook set (every installed hook runs, so a
        // signature scheme cannot drop policy by omitting hooks), distinct and
        // bounded — the checks that used to live in MultiHook.
        string modulesSource = ReadCoreFile("SmartAccount.Modules.cs");

        StringAssert.Contains(modulesSource, "private static void ValidateHookOrder(UInt160 accountId, BigInteger[] hookIds)");
        StringAssert.Contains(modulesSource, "ExecutionEngine.Assert(hookIds != null && hookIds.Length <= MaxHookModuleInstances, ErrorModuleLimitHook);");
        StringAssert.Contains(modulesSource, "ExecutionEngine.Assert(module.ModuleType == ModuleTypeCodeHook, ErrorOperationMalformed);");
        StringAssert.Contains(modulesSource, "ExecutionEngine.Assert(hookIds[j] != hookIds[i], ErrorOperationMalformed);");
        StringAssert.Contains(
            modulesSource,
            "(BigInteger)hookIds.Length == CountModulesOfType(accountId, ModuleTypeCodeHook),");
        StringAssert.Contains(modulesSource, "case ActionSetHookOrder:");
    }

    [TestMethod]
    public void NeoDidHookUsesRegistryBackedChecksInsteadOfLocalCredentialFlags()
    {
        string source = ReadContractFile("plugins/hooks/NeoDIDCredentialHook.cs");

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
    public void ZkLoginConfigBlobRejectsTrailingBytes()
    {
        string source = ReadContractFile("plugins/validators/DelegatedIdentityValidator.cs");

        // Configuration is a signed protocol envelope with a fixed arity, so two
        // encodings cannot map to the same stored tuple.
        StringAssert.Contains(
            source,
            "ExecutionEngine.Assert(ModuleConfig.Command(data, 3) == \"setConfig\", \"Unknown config command\");");
        StringAssert.Contains(
            ReadContractFile("plugins/validators/ModuleOperation.cs"),
            "ExecutionEngine.Assert(data != null && data.Length == argumentCount + 1, \"Invalid config arguments\");");

        // The proof is the same story: an exact-length canonical layout means it
        // must consume the whole byte string.
        StringAssert.Contains(
            source,
            "int expectedLength = 2 + provider.Length + NullifierLength + NullifierLength + SignatureLength;");
        StringAssert.Contains(source, "if (proof.Length != expectedLength) return false;");
        Assert.AreEqual(
            1,
            CountOccurrences(source, "if (proof.Length != expectedLength) return false;"),
            "ZkLogin proof must have exactly one canonical end-of-input check");
    }

    [TestMethod]
    public void ZkLoginProviderUsesTheOneByteWireLengthBound()
    {
        string source = ReadContractFile("plugins/validators/DelegatedIdentityValidator.cs");

        // The provider travels with a one-byte length prefix in both the proof
        // and the signed preimage, so values that cannot be encoded canonically
        // are rejected at configuration time.
        StringAssert.Contains(
            source,
            "ExecutionEngine.Assert(provider != null && provider.Length > 0 && provider.Length <= 255, \"Provider must be 1-255 bytes\");");
        StringAssert.Contains(source, "if (proof[1] != provider.Length) return false;");
        StringAssert.Contains(source, "preimage = Helper.Concat(preimage, new byte[] { (byte)provider.Length });");
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

        StringAssert.Contains(ReadContractFile("plugins/validators/ValidatorAuthority.cs"), "ModuleContext.RequireLifecycle(Core(), accountId, moduleId);");
        StringAssert.Contains(ReadContractFile("plugins/validators/ValidatorAuthority.cs"), "ModuleContext.ResolveValidationInstance(Core(), accountId, operation);");
        StringAssert.Contains(ReadContractFile("plugins/validators/ValidatorAuthority.cs"), "ModuleContext.RequireInstance(Core(), accountId, ModulePhase.Completion);");

        // Each shipped validator authenticates its lifecycle callback and at
        // least one of the two execution phases through the shared authority.
        foreach (string fileName in VerifierFiles.Where(path => path != "plugins/validators/ValidatorAuthority.cs"))
        {
            string source = ReadContractFile(fileName);
            StringAssert.Contains(
                source,
                "ValidatorAuthority.RequireLifecycle(accountId, moduleId);",
                $"Core authority lifecycle gate missing from {fileName}");
            Assert.IsTrue(
                source.Contains("ValidatorAuthority.RequireValidation(accountId, operation);", StringComparison.Ordinal)
                || source.Contains("ValidatorAuthority.RequireCompletion(accountId, operation);", StringComparison.Ordinal),
                $"Core authority execution gate missing from {fileName}");
        }
    }

    [TestMethod]
    public void DisabledZkEmailVerifierFaultsEveryLifecycleCallback()
    {
        // The placeholder advertises the v4 validator surface, so the ABI gate
        // passes; every lifecycle callback then faults. Installation is atomic
        // with the registration/confirmation action, so binding is rejected up
        // front instead of letting an account attach to a validator that can
        // only ever reject (which previously forced a 7-90 day escape).
        string source = ReadContractFile("plugins/validators/ZKEmailVerifier.cs");
        StringAssert.Contains(
            source,
            "public static bool ValidateUserOp(UInt160 accountId, ByteString operationDigest, object[] operation) => false;");
        StringAssert.Contains(source, "ZKEmailVerifier disabled pending real proof verification");
        Assert.AreEqual(
            4,
            CountOccurrences(source, "ExecutionEngine.Assert(false, Disabled);"),
            "onInstall, onUninstall, configure and onUserOpComplete must all refuse");
    }

    [TestMethod]
    public void DiscoveryReadsAreSafeAndNonFaulting()
    {
        // Wallets and explorers probe counterfactual accounts before creation,
        // so getAccount must be Safe and must report a zero row (not fault) for
        // an unknown account id, including the two execution-relevant latches.
        string source = ReadCoreFile("SmartAccount.State.cs");
        StringAssert.Contains(source, "[Safe]\n        public static object[] getAccount(UInt160 accountId)");
        StringAssert.Contains(source, "Non-faulting for unknown accounts");
        StringAssert.Contains(source, "if (control != null)");
        StringAssert.Contains(source, "IsMarketEscrowActive(accountId),");
        StringAssert.Contains(source, "HasLegacyAccountRow(accountId)");
        StringAssert.Contains(source, "public static object[] getModules(UInt160 accountId, string moduleType, BigInteger cursor, BigInteger limit)");
        StringAssert.Contains(source, "public static object[] getHookOrder(UInt160 accountId)");

        // Off-chain pre-flight signs the digest published by the core, never a
        // locally reconstructed copy of the domain separator.
        string executionSource = ReadCoreFile("SmartAccount.Execution.cs");
        StringAssert.Contains(executionSource, "[Safe]\n        public static ByteString getOperationDigest(UInt160 accountId, object operation)");
    }

    [TestMethod]
    public void SessionKeyValidatorAcceptsInstallTimeInitialKey()
    {
        // The core delivers registration initData to onInstall; decoding and
        // storing must reuse the timelocked configure path instead of
        // duplicating the validation.
        string source = ReadContractFile("plugins/validators/SessionKeyValidator.cs");
        StringAssert.Contains(source, "if (initData.Length > 0) ApplyConfig(accountId, moduleId, generation, initData);");
        StringAssert.Contains(source, "if (command == \"setSessionKey\")");
        StringAssert.Contains(
            source,
            "SetSessionKey(accountId, moduleId, generation, (ByteString)data[1], (UInt160)data[2], (string)data[3],");
        StringAssert.Contains(
            source,
            "ExecutionEngine.Assert(spendingLimit == 0 || method == \"transfer\", \"Spending limit only enforceable on transfer session keys\");");
        StringAssert.Contains(source, "ExecutionEngine.Assert(false, \"Unknown config command\");");
    }

    [TestMethod]
    public void SessionAndSubscriptionValidatorsKeepValidationReadOnlyAndPersistInCompletion()
    {
        string sessionSource = ReadContractFile("plugins/validators/SessionKeyValidator.cs");
        string subscriptionSource = ReadContractFile("plugins/validators/SubscriptionValidator.cs");

        // The core calls validateUserOp with ReadOnly, and the declared-Safe ABI
        // is what makes that impossible to bypass: validation can never write.
        // The state transition therefore lives in the completion callback.
        StringAssert.Contains(sessionSource, "[Safe]\n        public static bool ValidateUserOp(UInt160 accountId, ByteString operationDigest, object[] operation)");
        StringAssert.Contains(subscriptionSource, "[Safe]\n        public static bool ValidateUserOp(UInt160 accountId, ByteString operationDigest, object[] operation)");

        string sessionValidateBlock = ExtractSourceBlock(
            sessionSource,
            "public static bool ValidateUserOp(UInt160 accountId, ByteString operationDigest, object[] operation)",
            "public static void OnUserOpComplete(UInt160 accountId, object[] operation, object result)");
        string subscriptionValidateBlock = ExtractSourceBlock(
            subscriptionSource,
            "public static bool ValidateUserOp(UInt160 accountId, ByteString operationDigest, object[] operation)",
            "public static void OnUserOpComplete(UInt160 accountId, object[] operation, object result)");

        Assert.IsFalse(sessionValidateBlock.Contains("Storage.Put(", StringComparison.Ordinal));
        Assert.IsFalse(subscriptionValidateBlock.Contains("Storage.Put(", StringComparison.Ordinal));
        StringAssert.Contains(sessionSource, "public static void OnUserOpComplete(UInt160 accountId, object[] operation, object result)");
        StringAssert.Contains(subscriptionSource, "public static void OnUserOpComplete(UInt160 accountId, object[] operation, object result)");
    }

    [TestMethod]
    public void MultiSigCompletionIsOrchestratedByTheCore()
    {
        // v4 moved threshold orchestration into the core: every approved member
        // receives its own completion callback from the core, and the member
        // validator owns no child calls of its own.
        string executionSource = ReadCoreFile("SmartAccount.Execution.cs");
        string multiSigSource = ReadContractFile("plugins/validators/MultiSigValidator.cs");

        StringAssert.Contains(executionSource, "if (approvedMembers[i] == 0) break;");
        StringAssert.Contains(executionSource, "approvedMembers[i], approvedModules[i], op, result);");
        StringAssert.Contains(
            multiSigSource,
            "public static void OnUserOpComplete(UInt160 accountId, object[] operation, object result)");
        StringAssert.Contains(multiSigSource, "ValidatorAuthority.RequireCompletion(accountId, operation);");
        Assert.IsFalse(multiSigSource.Contains("Contract.Call(", StringComparison.Ordinal));
    }

    [TestMethod]
    public void AccountSweepIsCallbackFreeAcrossOwnershipTransitions()
    {
        // v3 handed ownership transitions a clearAccount callback, so a stale or
        // hostile plugin still held a write window on a shell it no longer
        // controlled. v4 deletes the account's own rows locally and never calls
        // the plugin, so there is nothing to fail open.
        string escapeSource = ReadCoreFile("SmartAccount.Escape.cs");
        string marketSource = ReadCoreFile("SmartAccount.MarketEscrow.cs");
        string modulesSource = ReadCoreFile("SmartAccount.Modules.cs");

        foreach (string source in new[] { escapeSource, marketSource, modulesSource })
        {
            Assert.IsFalse(source.Contains("clearAccount", StringComparison.Ordinal));
        }

        StringAssert.Contains(escapeSource, "Callback-free sweep: no external call is made anywhere below.");
        StringAssert.Contains(escapeSource, "SweepAccountModulesAndPolicies(accountId);");
        StringAssert.Contains(marketSource, "SweepAccountModulesAndPolicies(accountId);");
        StringAssert.Contains(marketSource, "Callback-free clean sweep: no old plugin, market or oracle call.");
        Assert.IsFalse(escapeSource.Contains("Contract.Call(", StringComparison.Ordinal));
        Assert.IsFalse(marketSource.Contains("Contract.Call(", StringComparison.Ordinal));

        // A code-identity change under a bound instance still fails the whole
        // transaction, so an upgrade can never silently swap behaviour.
        StringAssert.Contains(modulesSource, "private static void AssertCodeBindingUnchanged(ModuleInstance module)");
        int bindingStart = modulesSource.IndexOf(
            "private static void AssertCodeBindingUnchanged(ModuleInstance module)", StringComparison.Ordinal);
        string bindingBody = modulesSource.Substring(bindingStart,
            modulesSource.IndexOf("\n        }", bindingStart, StringComparison.Ordinal) - bindingStart);
        StringAssert.Contains(bindingBody, "contract!.Id == module.ContractId");
        StringAssert.Contains(bindingBody, "contract.UpdateCounter == module.UpdateCounter");
        // The per-callback check compares (deployment id, update counter) and
        // carries the install-time NEF hash only as the record's evidence: a
        // destroy-and-redeploy cannot reuse the id and any update of the slot
        // bumps the counter, so re-hashing every Nef on every callback charged
        // the account for a proof the pair already carries (spec §11).
        Assert.IsFalse(bindingBody.Contains("CryptoLib", StringComparison.Ordinal),
            "The per-callback continuity check must not re-hash the Nef");
        StringAssert.Contains(modulesSource, "module.NefSha256 = CryptoLib.Sha256(contract.Nef);");
    }

    [TestMethod]
    public void ModuleBindingRequiresTheCanonicalProfile()
    {
        // v3 gated binding on a supportsV3() marker plus a clearAccount ABI
        // probe. v4 binds to the canonical profile the configuration action
        // committed to: its digest, its declared module type, its declared
        // capabilities, and the full callback ABI of that module type.
        string accountsSource = ReadCoreFile("SmartAccount.Accounts.cs");
        string modulesSource = ReadCoreFile("SmartAccount.Modules.cs");

        StringAssert.Contains(modulesSource, "private static void BindModuleProfile(ModuleInstance module, Contract contract, ByteString profileDigest)");
        StringAssert.Contains(modulesSource, "ModuleExposesSafeMethod(moduleHash, \"getModuleProfile\", ContractParameterType.String),");
        StringAssert.Contains(modulesSource, "ExecutionEngine.Assert(CryptoLib.Sha256((ByteString)profileJson) == profileDigest,");
        StringAssert.Contains(
            modulesSource,
            "ExecutionEngine.Assert((string)profile[\"moduleType\"] == ModuleTypeNameFromCode((int)module.ModuleType),");
        StringAssert.Contains(modulesSource, "private static void AssertModuleCallbackAbi(UInt160 moduleHash, ModuleInstance module)");
        StringAssert.Contains(modulesSource, "ModuleExposesMethod(moduleHash, \"onInstall\", ContractParameterType.Void,");
        StringAssert.Contains(accountsSource, "private static bool ModuleExposesSafeMethod(UInt160 module, string methodName, ContractParameterType returnType,");
        StringAssert.Contains(accountsSource, "if (method.Parameters[j].Type != parameterTypes[j])");

        foreach (string moduleName in new[] { "WhitelistHook", "DailyLimitHook", "TokenRestrictedHook", "NeoDIDCredentialHook", "MultiHook" })
        {
            string profile = ReadContractFile($"plugins/hooks/{moduleName}.profile.json");
            StringAssert.Contains(profile, "\"profileVersion\":1", $"Profile version missing from {moduleName}");
            StringAssert.Contains(profile, "\"moduleType\":\"hook\"", $"Module type missing from {moduleName}");
            StringAssert.Contains(profile, $"\"contractName\":\"{moduleName}\"", $"Contract name missing from {moduleName}");
            StringAssert.Contains(
                profile,
                "\"lifecycle\":[\"onInstall\",\"onUninstall\",\"configure\"]",
                $"Lifecycle declaration missing from {moduleName}");
        }
    }

    [TestMethod]
    public void SessionAndSubscriptionCompletionEnforceTransferResultLocally()
    {
        string sessionSource = ReadContractFile("plugins/validators/SessionKeyValidator.cs");
        string subscriptionSource = ReadContractFile("plugins/validators/SubscriptionValidator.cs");

        StringAssert.Contains(sessionSource, "if (ModuleOperation.Method(operation) == \"transfer\")");
        StringAssert.Contains(sessionSource, "result is bool accepted && accepted");
        StringAssert.Contains(subscriptionSource, "result is bool accepted && accepted");
        Assert.IsFalse(sessionSource.Contains("DidExecutionSucceed(result)", StringComparison.Ordinal));
        Assert.IsFalse(subscriptionSource.Contains("DidExecutionSucceed(result)", StringComparison.Ordinal));
        Assert.IsFalse(sessionSource.Contains("private static bool DidExecutionSucceed", StringComparison.Ordinal));
        Assert.IsFalse(subscriptionSource.Contains("private static bool DidExecutionSucceed", StringComparison.Ordinal));
    }

    [TestMethod]
    public void SourceInvariantSuiteDoesNotClaimBehavioralFuzzCoverage()
    {
        string source = File.ReadAllText(Path.Combine(RepoRoot, "tests", "SmartAccount.Contracts.Tests", "SourceInvariantTests.cs"));

        Assert.IsFalse(source.Contains("Fuzz_", StringComparison.Ordinal));
        Assert.IsFalse(source.Contains("fuzz tests", StringComparison.OrdinalIgnoreCase));
        Assert.IsFalse(source.Contains("fuzzing", StringComparison.OrdinalIgnoreCase));
    }

    [TestMethod]
    public void VerifierProjectsCompileSharedAuthorityHelper()
    {
        string[] verifierProjects =
        {
            "plugins/validators/Web3AuthValidator.csproj",
            "plugins/validators/TeeKeyValidator.csproj",
            "plugins/validators/P256Validator.csproj",
            "plugins/validators/SessionKeyValidator.csproj",
            "plugins/validators/MultiSigValidator.csproj",
            "plugins/validators/SubscriptionValidator.csproj",
            "plugins/validators/ZKEmailVerifier.csproj",
            "plugins/validators/DelegatedIdentityValidator.csproj",
        };

        foreach (string project in verifierProjects)
        {
            string projectFile = ReadContractFile(project);
            StringAssert.Contains(projectFile, "<Compile Include=\"ValidatorAuthority.cs\" />");
        }
    }

    private const string PinnedFrameworkVersion = "$(NeoSmartContractFrameworkVersion)";

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

    // ========================================================================
    // Registrar Contract Tests (Phase 1b service extraction)
    // ========================================================================

    [TestMethod]
    public void RegistrarContractHasCorrectMetadata()
    {
        string source = ReadContractFile("custom/registrar/PlatformRegistrar.cs");

        StringAssert.Contains(source, "[DisplayName(\"SAPlatformRegistrar\")]");
        StringAssert.Contains(source, "Platform Account Registrar Service for Neo N3 SA");
        StringAssert.Contains(source, "[ContractPermission(\"*\", \"applyPlatformAccountOwnerRotation\")]");
    }

    [TestMethod]
    public void RegistrarExposesAllRequiredEntrypoints()
    {
        string source = ReadContractFile("custom/registrar/PlatformRegistrar.cs");

        string[] requiredMethods =
        {
            "_deploy",
            "RegisterPlatformAccount",
            "RegisterStablePlatformAccount",
            "ProposePlatformAccountOwnerRotation",
            "ConfirmPlatformAccountOwnerRotation",
            "CancelPlatformAccountOwnerRotation",
            "GetPendingPlatformOwnerRotation",
            "GetPlatformOwnerRotationAvailableAt",
            "AuthorizedCore",
            "Admin",
            "SetAuthorizedCore",
            "ProposeAuthorizedCore",
            "ConfirmAuthorizedCore",
            "CancelAuthorizedCoreChange",
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
    public void RegistrarRotationProposalIsTimelocked()
    {
        string source = ReadContractFile("custom/registrar/PlatformRegistrar.cs");

        // Rotation proposals sit behind the 7-day timelock before confirmation.
        StringAssert.Contains(source, "RotationTimelockMs = 7L * 24 * 60 * 60 * 1000");
        StringAssert.Contains(source, "public static void ProposePlatformAccountOwnerRotation(");
    }

    [TestMethod]
    public void PaymasterContractHasCorrectMetadata()
    {
        string source = ReadContractFile("custom/paymaster/Paymaster.cs");

        StringAssert.Contains(source, "[DisplayName(\"SAPaymaster\")]");
        StringAssert.Contains(source, "On-Chain Paymaster for Sponsored Transactions on Neo N3 SA");
        StringAssert.Contains(source, "0xd2a4cff31913016155e38e474a2c06d08be276cf");
    }

    [TestMethod]
    public void PaymasterExposesAllRequiredEntrypoints()
    {
        string source = ReadContractFile("custom/paymaster/Paymaster.cs");

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
        string source = ReadContractFile("custom/paymaster/Paymaster.cs");

        StringAssert.Contains(source, "Runtime.CallingScriptHash == GAS.Hash");
        StringAssert.Contains(source, "Only GAS accepted");
    }

    [TestMethod]
    public void PaymasterSettlementOnlyCallableByCore()
    {
        string source = ReadContractFile("custom/paymaster/Paymaster.cs");

        StringAssert.Contains(source, "PaymasterAuthority.ValidateCoreCaller()");
    }

    [TestMethod]
    public void PaymasterFollowsChecksEffectsInteractionsPattern()
    {
        string source = ReadContractFile("custom/paymaster/Paymaster.cs");

        // In SettleReimbursement: deposit deducted BEFORE GAS transfer
        int deductIndex = source.IndexOf("SetSponsorDeposit(sponsor!, deposit - amount)", StringComparison.Ordinal);
        int transferIndex = source.IndexOf("GAS.Hash, \"transfer\", CallFlags.All", deductIndex, StringComparison.Ordinal);
        Assert.IsTrue(deductIndex > 0 && transferIndex > deductIndex,
            "Deposit must be deducted before GAS transfer (checks-effects-interactions)");
    }

    [TestMethod]
    public void PaymasterHasOverflowProtection()
    {
        string source = ReadContractFile("custom/paymaster/Paymaster.cs");

        StringAssert.Contains(source, "Deposit overflow");
        StringAssert.Contains(source, "Daily spend overflow");
        StringAssert.Contains(source, "Total spend overflow");
    }

    [TestMethod]
    public void PaymasterStoragePrefixesAreUnique()
    {
        string source = ReadContractFile("custom/paymaster/Paymaster.cs");

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
        string authoritySource = ReadContractFile("custom/paymaster/PaymasterAuthority.cs");
        string paymasterSource = ReadContractFile("custom/paymaster/Paymaster.cs");

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
        string projectFile = ReadContractFile("custom/paymaster/Paymaster.csproj");

        StringAssert.Contains(projectFile, "<Compile Include=\"PaymasterAuthority.cs\" />");
        StringAssert.Contains(projectFile, "<Compile Include=\"Paymaster.cs\" />");
    }

    [TestMethod]
    public void PaymasterAuthorityUsesTimelockForAdminRotation()
    {
        string source = ReadContractFile("custom/paymaster/PaymasterAuthority.cs");

        StringAssert.Contains(source, "AdminRotationTimelockMs = 7L * 24 * 60 * 60 * 1000");
        StringAssert.Contains(source, "Admin rotation timelock not expired");
        StringAssert.Contains(source, "Pending admin mismatch");
    }

    [TestMethod]
    public void VerifierAndHookAuthorityUseRuntimeMillisecondsForAdminRotation()
    {
        string verifierSource = ReadContractFile("plugins/validators/ValidatorAuthority.cs");
        string hookSource = ReadContractFile("plugins/hooks/HookAuthority.cs");

        StringAssert.Contains(verifierSource, "AdminRotationTimelockMs = 7L * 24 * 60 * 60 * 1000");
        StringAssert.Contains(hookSource, "AdminRotationTimelockMs = 7L * 24 * 60 * 60 * 1000");
        Assert.IsFalse(verifierSource.Contains("AdminRotationTimelockSeconds", StringComparison.Ordinal));
        Assert.IsFalse(hookSource.Contains("AdminRotationTimelockSeconds", StringComparison.Ordinal));
    }

    [TestMethod]
    public void VerifierAndHookAuthorityRequireNewAdminWitnessForRotationConfirmation()
    {
        string verifierSource = ReadContractFile("plugins/validators/ValidatorAuthority.cs");
        string hookSource = ReadContractFile("plugins/hooks/HookAuthority.cs");

        StringAssert.Contains(verifierSource, "Runtime.CheckWitness(newAdmin)");
        StringAssert.Contains(hookSource, "Runtime.CheckWitness(newAdmin)");
    }

    [TestMethod]
    public void PaymasterEventsAreComplete()
    {
        string source = ReadContractFile("custom/paymaster/Paymaster.cs");

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
        string source = ReadContractFile("custom/paymaster/Paymaster.cs");

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
        string source = ReadCoreFile("SmartAccount.Paymaster.cs");

        StringAssert.Contains(source, "public static object ExecuteSponsoredUserOp(");
        StringAssert.Contains(source, "public static object[] ExecuteSponsoredUserOps(");
        StringAssert.Contains(source, "settleReimbursement");
        StringAssert.Contains(source, "CallFlags.All");
        StringAssert.Contains(source, "Runtime.Transaction.Sender");
        StringAssert.Contains(source, "OnSponsoredUserOpExecuted");

        // C-2 fix: verify paymaster trust check
        StringAssert.Contains(source, "authorizedCore");
        StringAssert.Contains(source, "Paymaster not bound to this core");

        // M-2 fix: accountId validation and the 13-field envelope check are
        // shared with the canonical execution path
        StringAssert.Contains(source, "ValidateAccountId(accountId)");
        StringAssert.Contains(source, "object[] op = ValidateOperationEnvelope(operation);");

        // H-2 fix: batch ops must share target/method
        StringAssert.Contains(source, "Batch ops must share target contract");
        StringAssert.Contains(source, "Batch ops must share method");
    }

    [TestMethod]
    public void SponsoredExecutionEventDeclaredInEvents()
    {
        string source = ReadCoreFile("SmartAccount.Events.cs");

        StringAssert.Contains(source, "SponsoredUserOpExecutedDelegate");
        StringAssert.Contains(source, "[DisplayName(\"SponsoredUserOpExecuted\")]");
        StringAssert.Contains(source, "OnSponsoredUserOpExecuted");
    }

    [TestMethod]
    public void PaymasterGasPermissionIsTightened()
    {
        string source = ReadContractFile("custom/paymaster/Paymaster.cs");

        // Must use specific GAS hash, not wildcard
        StringAssert.Contains(source,
            "[ContractPermission(\"0xd2a4cff31913016155e38e474a2c06d08be276cf\", \"transfer\")]");
    }

    [TestMethod]
    public void PaymasterSupportsGlobalPolicyFallback()
    {
        string source = ReadContractFile("custom/paymaster/Paymaster.cs");

        StringAssert.Contains(source, "ResolvePolicy(sponsor, accountId, out UInt160 spendingKey)");
        StringAssert.Contains(source, "ReadPolicy(sponsor, UInt160.Zero)");
        StringAssert.Contains(source, "spendingAccountId = UInt160.Zero");
    }
}
