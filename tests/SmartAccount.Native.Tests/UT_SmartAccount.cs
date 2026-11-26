// Copyright (C) 2015-2026 The Neo Project.
//
// UT_SmartAccount.cs file belongs to the neo project and is free
// software distributed under the MIT software license, see the
// accompanying file LICENSE in the main directory of the
// repository or http://www.opensource.org/licenses/mit-license.php
// for more details.
//
// Redistribution and use in source and binary forms with or without
// modifications are permitted.

using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo.Extensions;
using Neo.IO;
using Neo.Network.P2P.Payloads;
using Neo.Persistence;
using Neo.SmartContract;
using Neo.SmartContract.Manifest;
using Neo.SmartContract.Native;
using Neo.UnitTests.Extensions;
using Neo.VM;
using Neo.VM.Types;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Numerics;
using System.Security.Cryptography;
using Array = Neo.VM.Types.Array;

namespace Neo.UnitTests.SmartContract.Native
{
    /// <summary>
    /// End-to-end native kernel behaviour under SA module protocol v4: account
    /// creation, the thirteen-field operation envelope, built-in signature
    /// routing, nonce channels, batch atomicity, verification and recovery.
    /// </summary>
    [TestClass]
    public class UT_SmartAccount
    {
        internal static readonly Neo.Wallets.KeyPair CustodyKey = new(Enumerable.Repeat((byte)0x11, 32).ToArray());
        internal static readonly byte[] Salt = new byte[32];
        internal static readonly UInt160 Custody = Contract.CreateSignatureRedeemScript(CustodyKey.PublicKey).ToScriptHash();
        private static readonly UInt160 NextCustody = UInt160.Parse("0x0303030303030303030303030303030303030303");
        internal static ProtocolSettings Settings => TestProtocolSettings.Default with
        {
            Hardforks = TestProtocolSettings.Default.Hardforks.SetItem(Hardfork.HF_SmartAccountV1, 0)
        };
        internal static DataCache Snapshot(ProtocolSettings settings = null)
        {
            // The persisted native state must be the one the engine's hardfork
            // table produces.
            var snapshot = TestBlockchain.GetTestSnapshotCache();
            snapshot.AddContract(NativeContract.SmartAccount.Hash,
                NativeContract.SmartAccount.GetContractState(settings ?? Settings, 1));
            return snapshot;
        }
        private static Block Block(ulong time) => new()
        {
            Header = new Header
            {
                Index = 1,
                Timestamp = time,
                PrevHash = UInt256.Zero,
                MerkleRoot = UInt256.Zero,
                NextConsensus = UInt160.Zero,
                Witness = new Witness { InvocationScript = ReadOnlyMemory<byte>.Empty, VerificationScript = ReadOnlyMemory<byte>.Empty }
            },
            Transactions = []
        };
        private static void Push(ScriptBuilder builder, object value)
        {
            if (value is object[] items)
            {
                if (items.Length == 0) builder.Emit(OpCode.NEWARRAY0);
                else { for (int i = items.Length - 1; i >= 0; i--) Push(builder, items[i]); builder.EmitPush(items.Length).Emit(OpCode.PACK); }
            }
            else builder.EmitPush(value);
        }
        private static byte[] Script(string method, object[] args, UInt160 target = null, CallFlags flags = CallFlags.All)
        {
            using var builder = new ScriptBuilder();
            Push(builder, args);
            builder.EmitPush((int)flags).EmitPush(method)
                .EmitPush(target ?? NativeContract.SmartAccount.Hash)
                .EmitSysCall(ApplicationEngine.System_Contract_Call);
            return builder.ToArray();
        }
        internal static ApplicationEngine Invoke(DataCache snapshot, string method, object[] args, ulong time = 1000,
            UInt160[] signers = null, TriggerType trigger = TriggerType.Application, UInt160 target = null,
            CallFlags flags = CallFlags.All, long gas = 10_000_000_000, ProtocolSettings settings = null)
        {
            byte[] script = Script(method, args, target, flags);
            var tx = new Transaction
            {
                Version = 0,
                Script = script,
                Signers = (signers ?? [Custody]).Select(a => new Signer { Account = a, Scopes = WitnessScope.Global }).ToArray(),
                Attributes = [],
                Witnesses = [],
            };
            var engine = ApplicationEngine.Create(trigger, tx, snapshot, Block(time), settings ?? Settings, gas: gas);
            engine.LoadScript(tx.Script); engine.Execute(); return engine;
        }
        /// <summary>
        /// Runs a transaction prepared by the test itself, so a scenario can
        /// supply the exact signer set a client builds: signer order, scopes,
        /// witness rules and witness scripts, as the node would receive them.
        /// </summary>
        internal static ApplicationEngine Invoke(DataCache snapshot, Transaction tx, ulong time = 1000, long gas = 10_000_000_000)
        {
            var engine = ApplicationEngine.Create(TriggerType.Application, tx, snapshot, Block(time), Settings, gas: gas);
            engine.LoadScript(tx.Script); engine.Execute(); return engine;
        }
        internal static StackItem Success(DataCache snapshot, string method, object[] args, ulong time = 1000,
            UInt160[] signers = null, UInt160 target = null, ProtocolSettings settings = null)
        {
            using var engine = Invoke(snapshot, method, args, time, signers, target: target, settings: settings);
            Assert.AreEqual(VMState.HALT, engine.State, engine.FaultException?.ToString());
            var result = engine.ResultStack.Pop(); engine.SnapshotCache.Commit(); return result;
        }

        /// <summary>
        /// A fixed caller contract used as the invoking script of an operation:
        /// a deployed contract has a stable identity, unlike an ad-hoc script.
        /// </summary>
        internal static UInt160 Forwarder(DataCache snapshot)
        {
            byte[] script = new byte[] { (byte)OpCode.RET };
            ContractState contract = TestUtils.GetContract(script,
                TestUtils.CreateManifest("call", ContractParameterType.Any, ContractParameterType.Hash160,
                    ContractParameterType.ByteArray, ContractParameterType.Array));
            snapshot.AddContract(contract.Hash, contract);
            return contract.Hash;
        }
        internal static UInt160 Register(DataCache snapshot)
        {
            UInt160 id = SmartAccountProtocol.GetAccountId(Custody, Salt);
            Success(snapshot, "createAccount", [id, Custody, Salt, new object[0]]);
            return id;
        }
        private static Array Account(DataCache snapshot, UInt160 id, ProtocolSettings settings = null) =>
            (Array)Success(snapshot, "getAccount", [id], settings: settings);

        /// <summary>The current packed nonce of the account's built-in channel.</summary>
        private static BigInteger Nonce(DataCache snapshot, UInt160 id, ProtocolSettings settings = null) =>
            Success(snapshot, "getNonce", [id, 0, new byte[32]], settings: settings).GetInteger();

        /// <summary>The 64-bit sequence of a packed nonce (the 191-bit channel is the high half).</summary>
        private static BigInteger Sequence(BigInteger nonce) => nonce & ((BigInteger.One << 64) - 1);

        /// <summary>
        /// A complete v4 operation: [version, target, method, args, nonce,
        /// nonceSubkey, deadline, validatorId, credentialGeneration,
        /// authorityEpoch, configurationNonce, signature, hookProofs].
        /// </summary>
        internal static object[] Operation(DataCache snapshot, UInt160 id, UInt160 target, string method, object[] args,
            BigInteger? nonce = null, BigInteger? deadline = null, bool sign = true,
            BigInteger? validatorId = null, BigInteger? credentialGeneration = null,
            BigInteger? configurationNonce = null, bool prehashed = true, ProtocolSettings settings = null)
        {
            Array control = Account(snapshot, id, settings);
            object[] operation =
            [
                (BigInteger)SmartAccountModuleProtocol.ModuleProtocolVersion, target, method, args,
                nonce ?? Nonce(snapshot, id, settings), new byte[32], deadline ?? int.MaxValue,
                validatorId ?? BigInteger.Zero, credentialGeneration ?? BigInteger.One,
                control[3].GetInteger(), configurationNonce ?? control[4].GetInteger(),
                new byte[] { 0x01 }, new object[0],
            ];
            if (sign) operation[SmartAccountModuleProtocol.OpSignature] = Signature(snapshot, id, operation, prehashed, settings);
            return operation;
        }

        /// <summary>The §8 built-in signature envelope over the operation digest.</summary>
        private static byte[] Signature(DataCache snapshot, UInt160 id, object[] operation, bool prehashed = true,
            ProtocolSettings settings = null)
        {
            byte[] digest = Success(snapshot, "getOperationDigest", [id, operation], settings: settings).GetSpan().ToArray();
            return SignatureOver(id, digest, prehashed);
        }
        /// <summary>
        /// Signs an already-hashed 32-byte digest with the P-256 custody key in
        /// the same IEEE P1363 shape the core verifies with VerifyHash. A key
        /// created from the public point alone cannot sign, so the signer is
        /// built from the private scalar plus the public point.
        /// </summary>
        internal static byte[] SignPrehashed(Neo.Wallets.KeyPair key, byte[] digest)
        {
            byte[] buffer = key.PublicKey.EncodePoint(false);
            using var ecdsa = System.Security.Cryptography.ECDsa.Create(
                new System.Security.Cryptography.ECParameters
                {
                    Curve = System.Security.Cryptography.ECCurve.NamedCurves.nistP256,
                    D = key.PrivateKey.ToArray(),
                    Q = new System.Security.Cryptography.ECPoint
                    {
                        X = buffer[1..33],
                        Y = buffer[33..],
                    },
                });
            return ecdsa.SignHash(digest);
        }

        internal static byte[] SignatureOver(UInt160 id, byte[] digest, bool prehashed = true)
        {
            // The core verifies the built-in route prehashed: the P-256 key signs
            // the 32-byte operation digest exactly once. The historical
            // hash-then-sign shape is not a v4 signature.
            byte[] signature = prehashed
                ? SignPrehashed(CustodyKey, digest)
                : Neo.Cryptography.Crypto.Sign(digest, CustodyKey, Neo.Cryptography.HashAlgorithm.SHA256);
            byte[] script = Contract.CreateSignatureRedeemScript(CustodyKey.PublicKey).ToArray();
            return BinarySerializer.Serialize(new Array([
                new Integer(SmartAccountModuleProtocol.ModuleProtocolVersion),
                new Integer(0),
                new Integer(SubjectRevision(id)),
                new Array([new Array([new ByteString(script), new ByteString(signature)])]),
            ]), 8192, 32);
        }
        private static int SubjectRevision(UInt160 id) => 1; // the registration default
        private static StackItem Stack(object[] values)
        {
            var array = new Array();
            foreach (object value in values) array.Add(Value(value));
            return array;
        }
        private static StackItem Value(object value) => value switch
        {
            object[] items => Stack(items),
            BigInteger number => new Integer(number),
            int number => new Integer(number),
            long number => new Integer(number),
            string text => new ByteString(System.Text.Encoding.UTF8.GetBytes(text)),
            byte[] bytes => new ByteString(bytes),
            bool flag => flag ? StackItem.True : StackItem.False,
            StackItem item => item,
            null => StackItem.Null,
            _ => throw new ArgumentException($"Unsupported value {value.GetType()}."),
        };

        [TestMethod]
        public void DigestQueryEnforcesSignedWireLimitBeforeRemovingSignature()
        {
            var snapshot = Snapshot();
            UInt160 id = Register(snapshot);
            object[] op = Operation(snapshot, id, NativeContract.GAS.Hash, "ping", [new byte[4080]], sign: false);
            op[1] = NativeContract.GAS.Hash.ToArray();
            op[12] = new object[] { new object[] { 1, new byte[4096] } };
            int Size() => BinarySerializer.Serialize(Stack(op), 32768, 32768).Length;
            const int limit = SmartAccountModuleProtocol.OperationEncodedSizeMax;
            op[11] = new byte[8000];
            int length = 8000 + limit - Size();
            Assert.IsTrue(length > 0 && length < 8192);
            op[11] = new byte[length];
            Assert.AreEqual(limit, Size());
            Assert.HasCount(32, Success(snapshot, "getOperationDigest", [id, op]).GetSpan().ToArray());
            op[11] = new byte[length + 1];
            Assert.AreEqual(limit + 1, Size());
            using var oversized = Invoke(snapshot, "getOperationDigest", [id, op]);
            Assert.AreEqual(VMState.FAULT, oversized.State);
            Assert.Contains(SmartAccountModuleProtocol.ErrorOperationMalformed, oversized.FaultException.ToString());
        }

        [TestMethod]
        public void NativeIdentityManifestAndImplementationIdAreStable()
        {
            var native = NativeContract.SmartAccount;
            Assert.AreEqual("SmartAccount", native.Name);
            Assert.AreEqual(UInt160.Parse("0x398dc3f0227d7efac5533ed5ce9937390c158084"), native.Hash);
            Assert.AreEqual(SmartAccountProtocol.ServiceHash, native.Hash);
            Assert.AreEqual(NativeContract.TemporaryStorage.Id - 1, native.Id);
            Assert.IsFalse(native.IsActive(TestProtocolSettings.Default, uint.MaxValue));
            // There is one ABI, independent of the activation height: exactly the
            // 26-entry IDL. The retired native message entry is gone, not merely
            // unmarked, so it is neither in the manifest nor dispatchable.
            ContractState state = native.GetContractState(Settings, 1);
            Assert.HasCount(26, state.Manifest.Abi.Methods, "the ABI must be exactly the IDL");
            Assert.DoesNotContain("isValidSignature", state.Manifest.Abi.Methods.Select(m => m.Name).ToArray());

            using (var retired = Invoke(Snapshot(), "isValidSignature",
                [Custody, new byte[32], new object[0]], signers: [], settings: Settings))
            {
                Assert.AreEqual(VMState.FAULT, retired.State);
                Assert.Contains("doesn't exist in the contract",
                    retired.FaultException.GetBaseException().Message);
            }
            using (var batch = Invoke(Snapshot(), "executeUserOps",
                [Custody, new object[0]], signers: [], settings: Settings))
            {
                Assert.AreEqual(VMState.FAULT, batch.State);
                Assert.Contains("doesn't exist in the contract",
                    batch.FaultException.GetBaseException().Message);
            }
            // The wallet discovery fixture is regenerable evidence: set
            // SMARTACCOUNT_MANIFEST_FIXTURE to a writable path and run this test
            // to pin the manifest emitted by the native build.
            string manifestExport = Environment.GetEnvironmentVariable("SMARTACCOUNT_MANIFEST_FIXTURE");
            if (!string.IsNullOrEmpty(manifestExport))
                System.IO.File.WriteAllText(manifestExport, state.Manifest.ToJson().ToString());
            var fixture = System.IO.Path.Combine(AppContext.BaseDirectory, "native-smartaccount.manifest.json");
            Assert.IsTrue(System.Text.Json.Nodes.JsonNode.DeepEquals(
                System.Text.Json.Nodes.JsonNode.Parse(state.Manifest.ToJson().ToString()),
                System.Text.Json.Nodes.JsonNode.Parse(System.IO.File.ReadAllText(fixture))),
                "The wallet discovery fixture must match the manifest emitted by the native build.");
            string[] methods = state.Manifest.Abi.Methods.Select(m => m.Name).ToArray();
            string[] specifiedMethods =
            {
                "createAccount", "createAccounts", "executeUserOp", "validateUserOp",
                "validateMember", "getOperationDigest", "verify", "getNonce", "getNonceSequence",
                "getAccount", "getAccountAddress", "getProtocolInfo", "getAccountImplementationId",
                "getModules", "getModule", "isModuleInstalled", "getAuthorizedModuleId",
                "freezeAccount", "unfreezeAccount", "installModule", "removeModule", "configureModule",
                "setBuiltinAuthorization", "applyConfigurationActions", "revokeModuleCredentials", "resetAccount",
            };
            Assert.AreSequenceEqual(specifiedMethods.Order(StringComparer.Ordinal).ToArray(), methods.Order(StringComparer.Ordinal).ToArray(), "The active ABI must export exactly the specified entries.");
            // The advanced features live in user-space modules now; their ABI is
            // gone, not merely unmarked.
            foreach (string removed in new[]
            {
                "canonicalP256PublicKey",
                "proposeConfiguration", "confirmConfiguration", "cancelConfiguration",
                "getPendingConfiguration", "getPendingConfigurationIntentIds",
                "getHookOrder", "revokeCredentials", "supportsModuleType", "supportsExecutionMode",
                "beginRecovery", "cancelRecovery", "executeRecovery", "getRecoveryStatus",
                "setRecoveryPolicy", "getMessageSubjects", "getThresholdPolicy",
                "executeUserOps", "isValidSignature",
            })
                Assert.DoesNotContain(removed, methods, removed);

            // Spec §7.1 pins the two administration signatures: the install type
            // is an Integer code, and every install/uninstall carries the module
            // data array.
            static ContractParameterType[] Signature(ContractState state, string method) =>
                state.Manifest.Abi.Methods.Single(m => m.Name == method).Parameters
                    .Select(p => p.Type).ToArray();
            Assert.IsTrue(Signature(state, "installModule").SequenceEqual(new[]
            {
                ContractParameterType.Hash160, ContractParameterType.Integer,
                ContractParameterType.Hash160, ContractParameterType.Array,
            }), "installModule(accountId, moduleType, contractHash, initData)");
            Assert.IsTrue(Signature(state, "removeModule").SequenceEqual(new[]
            {
                ContractParameterType.Hash160, ContractParameterType.Integer,
                ContractParameterType.Array,
            }), "removeModule(accountId, moduleId, deInitData)");
            Assert.IsTrue(Signature(state, "configureModule").SequenceEqual(new[]
            {
                ContractParameterType.Hash160, ContractParameterType.Integer,
                ContractParameterType.Array,
            }), "configureModule(accountId, moduleId, data)");
            Assert.IsTrue(Signature(state, "setBuiltinAuthorization").SequenceEqual(new[]
            {
                ContractParameterType.Hash160, ContractParameterType.Boolean,
                ContractParameterType.Boolean,
            }), "setBuiltinAuthorization(accountId, defaultOperationAuthorization, defaultMessageAuthorization)");
            Assert.IsTrue(Signature(state, "revokeModuleCredentials").SequenceEqual(new[]
            {
                ContractParameterType.Hash160, ContractParameterType.Integer,
            }), "revokeModuleCredentials(accountId, moduleId)");
            Assert.IsTrue(Signature(state, "resetAccount").SequenceEqual(new[]
            {
                ContractParameterType.Hash160, ContractParameterType.Hash160,
            }), "resetAccount(accountId, newCustody)");
            Assert.IsTrue(Signature(state, "unfreezeAccount")
                .SequenceEqual(new[] { ContractParameterType.Hash160 }));
            Assert.AreEqual(SmartAccountModuleProtocol.ModuleProtocolVersion,
                state.Manifest.Extra["smartAccount"]["abiVersion"].GetInt32());
            Assert.AreEqual(SmartAccount.ParameterDigest,
                state.Manifest.Extra["smartAccount"]["profileParameterDigest"].GetString());
            Assert.AreEqual("NativeSmartAccount", Success(Snapshot(), "getAccountImplementationId", []).GetString());
        }

        [TestMethod]
        public void ReceivingAddressGasMatchesTheCanonicalCallAtEachChargeBoundary()
        {
            var snapshot = Snapshot();
            // Block 1, the fixed opcode price table, no fee exemption.
            var settings = Settings with { Hardforks = Settings.Hardforks.SetItem(Hardfork.HF_Huyao, 2) };
            UInt160 id = Custody;
            ApplicationEngine Call(long budget, UInt160 account, CallFlags flags) =>
                Invoke(snapshot, "getAccountAddress", [account], signers: [], flags: flags, gas: budget, settings: settings);
            using var baseline = Call(10_000_000, id, CallFlags.ReadStates);
            Assert.AreEqual(VMState.HALT, baseline.State, baseline.FaultException?.ToString());
            long factor = baseline.ExecFeeFactor;
            Assert.IsGreaterThan(0L, factor);
            // PUSHDATA1(id), PUSH1, PACK, PUSH1(flags), two PUSHDATA1,
            // Contract.Call, wrapper PUSH0, native CPU. RET and SYSCALL opcodes cost zero.
            long[] prices = [8, 1, 2048, 1, 8, 8, 32768, 1, 32768];
            var charges = prices.Select(p => checked(p * factor)).ToArray();
            long total = charges.Sum();
            Assert.AreEqual(total, baseline.FeeConsumed);
            var cases = new List<object>();
            var limits = new SortedSet<long> { 0, total + 1 };
            long sum = 0;
            foreach (var charge in charges) { sum += charge; limits.Add(sum - 1); limits.Add(sum); }
            foreach (long budget in limits)
            {
                using var run = Call(budget, id, CallFlags.ReadStates);
                long charged = 0;
                foreach (var charge in charges) { charged += charge; if (charged > budget) break; }
                Assert.AreEqual(charged, run.FeeConsumed);
                Assert.AreEqual(budget >= total ? VMState.HALT : VMState.FAULT, run.State);
                Assert.IsEmpty(run.Notifications);
                if (run.State == VMState.HALT)
                    Assert.AreSequenceEqual(baseline.ResultStack.Peek().GetSpan().ToArray(), run.ResultStack.Peek().GetSpan().ToArray());
                else
                    Assert.AreEqual("Insufficient GAS.", run.FaultException.GetBaseException().Message);
                cases.Add(new { budget, charged = run.FeeConsumed, state = run.State.ToString() });
            }
            using var invalid = Call(total, UInt160.Zero, CallFlags.ReadStates);
            Assert.AreEqual(VMState.FAULT, invalid.State);
            Assert.IsInstanceOfType<FormatException>(invalid.FaultException.GetBaseException());
            Assert.AreEqual(total, invalid.FeeConsumed);
            using var denied = Call(total, id, CallFlags.None);
            Assert.AreEqual(VMState.FAULT, denied.State);
            Assert.StartsWith("Cannot call this method with the flag", denied.FaultException.GetBaseException().Message);
            Assert.AreEqual(total - charges[^1], denied.FeeConsumed);
            Assert.IsEmpty(invalid.Notifications);
            Assert.IsEmpty(denied.Notifications);
            var huyao = Settings with { Hardforks = Settings.Hardforks.SetItem(Hardfork.HF_Huyao, 0) };
            ApplicationEngine Metered(long budget) => Invoke(snapshot, "getAccountAddress", [id],
                signers: [], flags: CallFlags.ReadStates, gas: budget, settings: huyao);
            using var quote = Metered(10_000_000);
            Assert.AreEqual(VMState.HALT, quote.State, quote.FaultException?.ToString());
            long minimum = quote.FeeConsumed;
            // Huyao charges after each executed opcode; the caller's implicit return has no opcode.
            long[] coefficients = [1685, 2187, 173 + 2649, 2187, 1685, 1685, 32768_000, 2187, 32768_000, 1085];
            long picoFactor = (long)quote.ExecFeePicoFactor;
            long scale = (long)ApplicationEngine.FeeFactor * ApplicationEngine.OpcodePriceMultiplier;
            var thresholds = new List<long>();
            long cumulative = 0;
            foreach (long coefficient in coefficients)
            {
                cumulative = checked(cumulative + coefficient * picoFactor);
                thresholds.Add((cumulative + scale - 1) / scale);
            }
            Assert.AreEqual(thresholds[^1], minimum);
            var meteredCases = new List<object>();
            var meteredLimits = new SortedSet<long> { 0, minimum + 1 };
            foreach (long threshold in thresholds) { meteredLimits.Add(threshold); meteredLimits.Add(threshold - 1); }
            foreach (long budget in meteredLimits)
            {
                using var run = Metered(budget);
                Assert.AreEqual(thresholds.FirstOrDefault(t => t > budget, minimum), run.FeeConsumed);
                Assert.AreEqual(budget < minimum ? VMState.FAULT : VMState.HALT, run.State);
                Assert.IsEmpty(run.Notifications);
                if (budget < minimum) Assert.AreEqual("Insufficient GAS.", run.FaultException.GetBaseException().Message);
                else
                {
                    Assert.AreEqual(quote.FeeConsumed, run.FeeConsumed);
                    Assert.AreSequenceEqual(baseline.ResultStack.Peek().GetSpan().ToArray(), run.ResultStack.Peek().GetSpan().ToArray());
                }
                meteredCases.Add(new { budget, charged = run.FeeConsumed, state = run.State.ToString() });
            }
            string output = Environment.GetEnvironmentVariable("SMARTACCOUNT_ADDRESS_FEES");
            if (!string.IsNullOrEmpty(output))
                System.IO.File.WriteAllText(output, System.Text.Json.JsonSerializer.Serialize(new {
                    assemblySha256 = Convert.ToHexStringLower(SHA256.HashData(System.IO.File.ReadAllBytes(typeof(SmartAccount).Assembly.Location))),
                    script = Convert.ToHexStringLower(Script("getAccountAddress", [id], flags: CallFlags.ReadStates)),
                    account = id.ToString(), core = NativeContract.SmartAccount.Hash.ToString(),
                    factor, prices, total, cases, invalidFee = invalid.FeeConsumed, deniedFee = denied.FeeConsumed,
                    huyao = new { picoFactor, scale, coefficients, minimum, charged = quote.FeeConsumed, cases = meteredCases } }));
        }

        [TestMethod]
        public void NativeReceivingAddressMatchesReadOnlyScriptAcrossAllBitPositions()
        {
            var snapshot = Snapshot();
            var cases = new List<object>();
            for (int bit = 0; bit < 160; bit++)
            {
                foreach (byte fill in new byte[] { 0, 255 })
                {
                    var raw = Enumerable.Repeat(fill, 20).ToArray();
                    raw[bit / 8] ^= (byte)(1 << (bit % 8));
                    var id = new UInt160(raw);
                    byte[] script = [0x0c, 20, .. raw, 0x11, 0xc0, 0x15, 0x0c, 6,
                        .. "verify"u8, 0x0c, 20, .. NativeContract.SmartAccount.Hash.ToArray(),
                        0x41, 0x62, 0x7d, 0x5b, 0x52];
                    Assert.AreSequenceEqual(script, SmartAccountProtocol.CreateVerificationScript(id));
                    using var engine = Invoke(snapshot, "getAccountAddress", [id], signers: [], flags: CallFlags.ReadStates);
                    Assert.AreEqual(VMState.HALT, engine.State, engine.FaultException?.ToString());
                    Assert.AreEqual(1, engine.ResultStack.Count);
                    var result = engine.ResultStack.Peek();
                    Assert.AreEqual(StackItemType.ByteString, result.Type);
                    Assert.AreSequenceEqual(Neo.Cryptography.Crypto.Hash160(script), result.GetSpan().ToArray());
                    Assert.IsEmpty(engine.Notifications);
                    cases.Add(new { accountId = id.ToString(), script = Convert.ToHexStringLower(script),
                        address = new UInt160(result.GetSpan()).ToString() });
                }
            }
            using var invalid = Invoke(snapshot, "getAccountAddress", [UInt160.Zero], signers: [], flags: CallFlags.ReadStates);
            Assert.AreEqual(VMState.FAULT, invalid.State);
            Assert.IsEmpty(invalid.Notifications);
            string output = Environment.GetEnvironmentVariable("SMARTACCOUNT_ADDRESS_VECTORS");
            if (!string.IsNullOrEmpty(output))
                System.IO.File.WriteAllText(output, System.Text.Json.JsonSerializer.Serialize(new {
                    assemblySha256 = Convert.ToHexStringLower(SHA256.HashData(System.IO.File.ReadAllBytes(typeof(SmartAccount).Assembly.Location))),
                    core = NativeContract.SmartAccount.Hash.ToString(), cases }));
        }

        [TestMethod]
        public void EveryNativeWrapperResolvesItsDeclaredHandler()
        {
            var native = NativeContract.SmartAccount;
            var state = native.GetContractState(Settings, 1);
            using var engine = Invoke(Snapshot(), "getProtocolInfo", [], signers: []);
            Assert.AreEqual(VMState.HALT, engine.State);
            var table = native.GetContractMethods(engine);
            var script = state.Nef.Script.ToArray();
            using var wrapper = new ScriptBuilder();
            wrapper.EmitPush(0).EmitSysCall(ApplicationEngine.System_Contract_CallNative).Emit(OpCode.RET);
            var pattern = wrapper.ToArray();
            var methods = state.Manifest.Abi.Methods.OrderBy(m => m.Offset).ToArray();
            Assert.HasCount(methods.Length, table);
            Assert.HasCount(methods.Length * pattern.Length, script);
            var rows = new List<object>();
            int refused = 0;
            int expectedRefusals = 0;
            var snapshot = Snapshot();
            foreach (var (descriptor, index) in methods.Select((m, i) => (m, i)))
            {
                int start = descriptor.Offset;
                Assert.AreEqual(index * pattern.Length, start);
                Assert.AreSequenceEqual(pattern, script[start..(start + pattern.Length)]);
                var method = table[start + 1];
                Assert.AreSame(descriptor, method.Descriptor);
                string expectedHandler = char.ToUpperInvariant(descriptor.Name[0]) + descriptor.Name[1..];
                Assert.AreEqual(expectedHandler, method.Handler.Name);
                Assert.AreEqual(typeof(SmartAccount), method.Handler.DeclaringType);
                var flags = descriptor.Name switch
                {
                    "getProtocolInfo" or "getAccountImplementationId" => CallFlags.None,
                    "verify" => CallFlags.ReadOnly,
                    _ => descriptor.Safe ? CallFlags.ReadStates : CallFlags.All
                };
                Assert.AreEqual(flags, method.RequiredCallFlags);
                expectedRefusals += Enumerable.Range(0, (int)CallFlags.All + 1)
                    .Count(bits => !((CallFlags)bits).HasFlag(flags));
                Assert.AreEqual(32768L, method.CpuFee);
                Assert.AreEqual(0L, method.StorageFee);
                Assert.IsNull(method.ActiveIn);
                Assert.IsNull(method.DeprecatedIn,
                    "no active entry is retired: the surface is the current one only");
                for (int bits = 0; bits <= (int)CallFlags.All; bits++)
                {
                    var requested = (CallFlags)bits;
                    if (requested.HasFlag(flags)) continue;
                    object[] placeholders = Enumerable.Repeat<object>(0, descriptor.Parameters.Length).ToArray();
                    using var denied = Invoke(snapshot, descriptor.Name, placeholders, signers: [], flags: requested);
                    Assert.AreEqual(VMState.FAULT, denied.State, $"{descriptor.Name}/{requested}");
                    Assert.StartsWith("Cannot call this method with the flag ", denied.FaultException.GetBaseException().Message);
                    Assert.IsEmpty(denied.Notifications);
                    refused++;
                }
                rows.Add(new { name = descriptor.Name, offset = start, pc = start + 1,
                    handler = method.Handler.Name, token = method.Handler.MetadataToken, flags = (int)flags,
                    cpu = method.CpuFee, storage = method.StorageFee, arity = method.Parameters.Length,
                    handlerParameters = method.Handler.GetParameters().Select(p => p.ParameterType.ToString()).ToArray(),
                    dispatchParameters = method.Parameters.Select(p => p.Type.ToString()).ToArray(),
                    handlerReturn = method.Handler.ReturnType.ToString(),
                    injectEngine = method.NeedApplicationEngine, injectSnapshot = method.NeedSnapshot });
            }
            Assert.AreEqual(expectedRefusals, refused,
                "every flag set that does not carry the declared requirement is refused exactly once");
            string export = Environment.GetEnvironmentVariable("SMARTACCOUNT_DISPATCH_EVIDENCE");
            if (!string.IsNullOrEmpty(export))
                System.IO.File.WriteAllText(export, System.Text.Json.JsonSerializer.Serialize(new
                {
                    assemblySha256 = Convert.ToHexStringLower(SHA256.HashData(System.IO.File.ReadAllBytes(typeof(SmartAccount).Assembly.Location))),
                    script = Convert.ToHexStringLower(script), deniedRuntimeCases = refused, methods = rows
                }));
        }

        [TestMethod]
        public void NativeDiscoveryReturnsWireValuesForEveryRequestedFlagSet()
        {
            var snapshot = Snapshot();
            for (int bits = 0; bits <= (int)CallFlags.All; bits++)
            {
                foreach (string name in new[] { "getAccountImplementationId", "getProtocolInfo" })
                {
                    using var engine = Invoke(snapshot, name, [], signers: [], flags: (CallFlags)bits);
                    Assert.AreEqual(VMState.HALT, engine.State, $"{name}/{bits}: {engine.FaultException}");
                    Assert.AreEqual(1, engine.ResultStack.Count);
                    Assert.IsEmpty(engine.Notifications);
                    var result = engine.ResultStack.Pop();
                    if (name == "getAccountImplementationId")
                    {
                        Assert.AreEqual(StackItemType.ByteString, result.Type);
                        Assert.AreEqual("NativeSmartAccount", result.GetString());
                    }
                    else
                    {
                        Assert.AreEqual(StackItemType.Array, result.Type);
                        var protocol = (Array)result;
                        Assert.AreEqual(1, protocol.Count);
                        Assert.AreEqual(StackItemType.Integer, protocol[0].Type);
                        Assert.AreEqual(new BigInteger(SmartAccountProtocol.Version), protocol[0].GetInteger());
                    }
                }
            }
        }

        [TestMethod]
        public void CreationStoresTheV4ControlRecordAndRejectsDuplicatesOrForeignCustody()
        {
            var snapshot = Snapshot(); UInt160 id = Register(snapshot);
            var protocol = (Array)Success(snapshot, "getProtocolInfo", []);
            Assert.AreEqual(SmartAccountProtocol.Version, protocol[0].GetInteger());
            Assert.HasCount(1, protocol);
            Assert.HasCount(9, Account(snapshot, id),
                "getAccount is the found flag plus the eight generic control fields");

            Array account = Account(snapshot, id);
            Assert.IsTrue(account[0].GetBoolean());
            Assert.AreEqual((int)SmartAccountStatus.Active, account[1].GetInteger());
            Assert.AreEqual(Custody, new UInt160(account[2].GetSpan()));
            Assert.AreEqual(BigInteger.One, account[3].GetInteger(), "authorityEpoch");
            Assert.AreEqual(BigInteger.Zero, account[4].GetInteger(), "configurationNonce");
            Assert.IsTrue(account[5].GetBoolean(), "defaultOperationAuthorization");
            Assert.IsTrue(account[6].GetBoolean(), "defaultMessageAuthorization");
            Assert.AreEqual(BigInteger.Zero, account[7].GetInteger(), "requiredValidatorId");
            Assert.AreEqual(BigInteger.One, account[8].GetInteger(), "controlRevision");

            using (var duplicate = Invoke(snapshot, "createAccount", [id, Custody, Salt, new object[0]]))
                Assert.AreEqual(VMState.FAULT, duplicate.State);
            UInt160 foreign = SmartAccountProtocol.GetAccountId(NextCustody, Salt);
            using (var unauthorized = Invoke(snapshot, "createAccount", [foreign, NextCustody, Salt, new object[0]]))
                Assert.AreEqual(VMState.FAULT, unauthorized.State, "A foreign custody signature cannot create an account.");
            using (var mismatched = Invoke(snapshot, "createAccount", [id, Custody, new byte[32], new object[0]]))
                Assert.AreEqual(VMState.FAULT, mismatched.State, "The account id must equal the derived id of its own salt.");

            Assert.AreEqual(BigInteger.Zero, Sequence(Nonce(snapshot, id)));
            // §9: the account address is the script hash of the fixed proxy
            // verification script, exposed as a read-only query for modules.
            Assert.AreEqual(SmartAccountProtocol.GetAccountAddress(id),
                new UInt160(Success(snapshot, "getAccountAddress", [id]).GetSpan()),
                "getAccountAddress exposes the deterministic proxy address.");
            using (var zero = Invoke(snapshot, "getAccountAddress", [UInt160.Zero]))
                Assert.AreEqual(VMState.FAULT, zero.State, "A zero account id has no account address.");
            var unknown = (Array)Success(snapshot, "getAccount", [NextCustody]);
            Assert.IsFalse(unknown[0].GetBoolean());
        }

        [TestMethod]
        [DataRow("GAS")]
        [DataRow("NEO")]
        public void BasicAccountReceivesAndTransfersWithoutModules(string asset)
        {
            var snapshot = Snapshot();
            UInt160 id = Register(snapshot), address = SmartAccountProtocol.GetAccountAddress(id);
            var roster = (Array)Success(snapshot, "getModules", [id, "validator", 0, 8]);
            Assert.HasCount(0, (Array)roster[0], "A basic account has no installed signing subject.");
            UInt160 funder = Contract.GetBFTAddress(Settings.StandbyValidators);
            UInt160 token = asset == "GAS" ? NativeContract.GAS.Hash : NativeContract.NEO.Hash;
            BigInteger Balance(UInt160 owner) => Success(snapshot, "balanceOf", [owner], target: token).GetInteger();
            Assert.IsTrue(Success(snapshot, "transfer", [funder, address, 7, null], signers: [funder], target: token).GetBoolean());
            Assert.AreEqual(new BigInteger(7), Balance(address));
            var operation = Operation(snapshot, id, token, "transfer", [address, NextCustody, 3, null]);
            var preview = (Array)Success(snapshot, "validateUserOp", [id, operation], signers: [funder]);
            Assert.IsTrue(preview[0].GetBoolean());
            Assert.AreEqual(BigInteger.Zero, Balance(NextCustody));
            Assert.IsTrue(Success(snapshot, "executeUserOp", [id, operation], signers: [funder]).GetBoolean());
            Assert.AreEqual(new BigInteger(4), Balance(address));
            Assert.AreEqual(new BigInteger(3), Balance(NextCustody));
            Assert.AreEqual(BigInteger.One, Sequence(Nonce(snapshot, id)));
        }

        [TestMethod]
        public void BuiltInRouteRequiresAValidSignatureAndNeverWrapsTheNonce()
        {
            var snapshot = Snapshot(); UInt160 id = Register(snapshot);
            UInt160 target = NativeContract.StdLib.Hash;

            using (var unsigned = Invoke(snapshot, "executeUserOp",
                [id, Operation(snapshot, id, target, "serialize", [7], sign: false)]))
                Assert.AreEqual(VMState.FAULT, unsigned.State, "The built-in route never falls back to custody witness authority.");

            var operation = Operation(snapshot, id, target, "serialize", [7]);
            Assert.IsInstanceOfType<ByteString>(Success(snapshot, "executeUserOp", [id, operation]));
            Assert.AreEqual(BigInteger.One, Sequence(Nonce(snapshot, id)));

            using (var replay = Invoke(snapshot, "executeUserOp", [id, operation]))
                Assert.AreEqual(VMState.FAULT, replay.State, "A consumed nonce can never be replayed.");

            var expired = Operation(snapshot, id, target, "serialize", [7], nonce: Nonce(snapshot, id), deadline: 999);
            using (var late = Invoke(snapshot, "executeUserOp", [id, expired]))
                Assert.AreEqual(VMState.FAULT, late.State, "An expired deadline faults the operation.");

            var gap = Operation(snapshot, id, target, "serialize", [7], nonce: Nonce(snapshot, id) + 5);
            using (var skipped = Invoke(snapshot, "executeUserOp", [id, gap]))
                Assert.AreEqual(VMState.FAULT, skipped.State, "The sequence must be exactly the channel cursor.");

            var staleEpoch = Operation(snapshot, id, target, "serialize", [7], nonce: Nonce(snapshot, id));
            staleEpoch[SmartAccountModuleProtocol.OpAuthorityEpoch] = new BigInteger(9);
            using (var stale = Invoke(snapshot, "executeUserOp", [id, staleEpoch]))
                Assert.AreEqual(VMState.FAULT, stale.State, "A stale authority epoch can never authorize.");
            Assert.AreEqual(BigInteger.One, Sequence(Nonce(snapshot, id)), "No rejected operation may move the cursor.");
        }

        /// <summary>
        /// R-06-04: a channel that reached the 2^64 sentinel is dead. The
        /// sentinel must not be packed into the nonce reply, because packing it
        /// would alias <c>(channel + 1) &lt;&lt; 64</c> — the exact start value of
        /// the next channel. GetNonce answers with the raw sentinel instead,
        /// and consumption of the dead channel keeps refusing on its own path.
        /// </summary>
        [TestMethod]
        public void AnExhaustedNonceChannelNeverAliasesIntoTheNextChannel()
        {
            var snapshot = Snapshot(); UInt160 id = Register(snapshot);
            BigInteger packed = Nonce(snapshot, id);
            BigInteger channel = packed >> 64;

            // Plant the exhaustion sentinel as the channel cursor — exactly the
            // record ConsumeOperationNonce would have written after consuming
            // sequence 2^64 - 1.
            snapshot.Add(NativeContract.SmartAccount.Key(SmartAccountModuleProtocol.PrefixNonceCursor).Add(id).Add(SmartAccountProtocol.EncodeChannel(packed >> 64)),
                new StorageItem(BinarySerializer.Serialize(
                    new Integer(BigInteger.One << 64), 32, 8)));

            BigInteger exhausted = Nonce(snapshot, id);
            Assert.AreEqual(BigInteger.One << 64, exhausted,
                "the dead channel answers with the raw exhaustion sentinel");
            Assert.AreNotEqual((channel + 1) << 64, exhausted,
                "the sentinel must never alias the start value of the next channel");

            using (var dead = Invoke(snapshot, "executeUserOp",
                [id, Operation(snapshot, id, NativeContract.StdLib.Hash, "serialize", [7],
                    nonce: channel << 64)]))
            {
                Assert.AreEqual(VMState.FAULT, dead.State, "An exhausted channel never executes again.");
                Assert.Contains(SmartAccountModuleProtocol.ErrorNonceExhausted,
                    dead.FaultException!.Message);
            }
        }

        [TestMethod]
        public void TheExhaustionSentinelIsTheSameAnswerOnEveryNonceEntry()
        {
            var snapshot = Snapshot(); UInt160 id = Register(snapshot);
            BigInteger packed = Nonce(snapshot, id);
            BigInteger channel = packed >> 64;
            PlantCursor(snapshot, id, channel, BigInteger.One << 64);

            // Both public nonce queries answer with the raw sentinel: 2^64 is a
            // cursor, not an encodable sequence, so it is never packed.
            Assert.AreEqual(BigInteger.One << 64, Nonce(snapshot, id),
                "getNonce answers the exhaustion sentinel unmodified");
            Assert.AreEqual(BigInteger.One << 64,
                Success(snapshot, "getNonceSequence", [id, channel]).GetInteger(),
                "getNonceSequence answers the same sentinel for the same channel");

            // The verified preview is the read-only entry: a dead channel is a
            // rejection, not a fault, and it still writes nothing.
            object[] previewed = Operation(snapshot, id, NativeContract.StdLib.Hash, "serialize", [7],
                nonce: channel << 64);
            var preview = (Array)Success(snapshot, "validateUserOp", [id, previewed]);
            Assert.IsFalse(preview[0].GetBoolean(), "a dead channel never previews as accepted");
            Assert.AreEqual(BigInteger.One << 64, Nonce(snapshot, id), "the preview consumed nothing");

            // The execution entry refuses the dead channel on its own path.
            using (var dead = Invoke(snapshot, "executeUserOp",
                [id, Operation(snapshot, id, NativeContract.StdLib.Hash, "serialize", [7],
                    nonce: channel << 64)]))
            {
                Assert.AreEqual(VMState.FAULT, dead.State);
                Assert.Contains(SmartAccountModuleProtocol.ErrorNonceExhausted, dead.FaultException!.Message);
            }
        }

        /// <summary>
        /// The cursor record domain is exactly [0, 2^64]: a stored negative value
        /// or a value past the sentinel is a corrupt row, and every entry that reads
        /// that channel fails closed instead of decoding it as a sequence. Both
        /// record formats read the same cursor key, so the bound is format-independent.
        /// </summary>
        [TestMethod]
        [DataRow("-1")]
        [DataRow("18446744073709551617")]
        public void AMalformedNonceCursorFailsClosedOnEveryRead(string stored)
        {
            var snapshot = Snapshot(); UInt160 id = Register(snapshot);
            BigInteger packed = Nonce(snapshot, id);
            BigInteger channel = packed >> 64;
            PlantCursor(snapshot, id, channel, BigInteger.Parse(stored));

            foreach (object[] call in new object[][]
                     {
                         ["getNonceSequence", new object[] { id, channel }],
                         ["getNonce", new object[] { id, 0, new byte[32] }],
                     })
            {
                using var read = Invoke(snapshot, (string)call[0], (object[])call[1]);
                Assert.AreEqual(VMState.FAULT, read.State, $"{(string)call[0]} decoded a corrupt cursor");
                Assert.Contains("nonce cursor record is malformed", read.FaultException!.ToString());
            }
            using (var execute = Invoke(snapshot, "executeUserOp",
                [id, Operation(snapshot, id, NativeContract.StdLib.Hash, "serialize", [7], nonce: packed)]))
            {
                Assert.AreEqual(VMState.FAULT, execute.State);
                Assert.Contains("nonce cursor record is malformed", execute.FaultException!.ToString());
            }
        }

        /// <summary>
        /// The cursor row has exactly one canonical encoding: a trailing byte, or an
        /// Integer that re-encodes to fewer bytes, is corruption and fails closed.
        /// </summary>
        [TestMethod]
        [DataRow("trailing")]
        [DataRow("nonminimal")]
        public void ANoncanonicalNonceCursorFailsClosed(string defect)
        {
            var snapshot = Snapshot(); UInt160 id = Register(snapshot);
            BigInteger packed = Nonce(snapshot, id);
            byte[] channel = SmartAccountProtocol.EncodeChannel(packed >> 64);
            byte[] stored = defect switch
            {
                // Integer(1) is [0x21, 0x01, 0x01]; a trailing byte changes the row.
                "trailing" => [.. BinarySerializer.Serialize(new Integer(BigInteger.One), 32, 8), 0x00],
                // A two-byte little-endian 1 decodes to the same Integer, non-minimally.
                "nonminimal" => [0x21, 0x02, 0x01, 0x00],
                _ => throw new ArgumentException(defect),
            };
            snapshot.Add(NativeContract.SmartAccount.Key(SmartAccountModuleProtocol.PrefixNonceCursor).Add(id).Add(channel), new StorageItem(stored));

            using var read = Invoke(snapshot, "getNonceSequence", [id, packed >> 64]);
            Assert.AreEqual(VMState.FAULT, read.State, "a noncanonical cursor row was decoded");
            Assert.Contains("nonce cursor record is malformed", read.FaultException!.ToString());
        }

        /// <summary>
        /// Consumption writes the next sequence as the one canonical Integer, and the
        /// consumed operation can never execute twice.
        /// </summary>
        [TestMethod]
        public void NonceConsumptionStoresTheCanonicalCursorAndReplayFaults()
        {
            var snapshot = Snapshot(); UInt160 id = Register(snapshot);
            BigInteger packed = Nonce(snapshot, id);
            byte[] channel = SmartAccountProtocol.EncodeChannel(packed >> 64);
            object[] operation = Operation(snapshot, id, NativeContract.StdLib.Hash, "serialize", [7]);
            using (var accepted = Invoke(snapshot, "executeUserOp", [id, operation]))
            {
                Assert.AreEqual(VMState.HALT, accepted.State, accepted.FaultException?.ToString());
                accepted.SnapshotCache.Commit();
            }

            byte[] expected = BinarySerializer.Serialize(new Integer(BigInteger.One), 32, 8);
            Assert.IsTrue(snapshot.TryGet(NativeContract.SmartAccount.Key(SmartAccountModuleProtocol.PrefixNonceCursor).Add(id).Add(channel), out StorageItem cursor));
            Assert.AreSequenceEqual(expected, cursor!.Value.ToArray(),
                "the consumed cursor is the canonical Integer of the next sequence");
            Assert.AreEqual(BigInteger.One, Sequence(Nonce(snapshot, id)));

            using var replay = Invoke(snapshot, "executeUserOp", [id, operation]);
            Assert.AreEqual(VMState.FAULT, replay.State, "a consumed sequence never executes twice");
            Assert.Contains(SmartAccountModuleProtocol.ErrorNonceInvalid, replay.FaultException!.Message);
        }

        /// <summary>
        /// Sequence 2^64 - 1 is the last admissible step: consuming it writes the
        /// exhaustion sentinel, announces the death of the channel and never wraps.
        /// The very next attempt is an explicit SA_NONCE_EXHAUSTED fault.
        /// </summary>
        [TestMethod]
        public void TheLastSequenceConsumesIntoTheSentinelAndKillsTheChannel()
        {
            var snapshot = Snapshot(); UInt160 id = Register(snapshot);
            BigInteger packed = Nonce(snapshot, id);
            BigInteger channel = packed >> 64;
            BigInteger last = (BigInteger.One << 64) - 1;
            PlantCursor(snapshot, id, channel, last);

            object[] operation = Operation(snapshot, id, NativeContract.StdLib.Hash, "serialize", [7],
                nonce: (channel << 64) | last);
            using (var accepted = Invoke(snapshot, "executeUserOp", [id, operation]))
            {
                Assert.AreEqual(VMState.HALT, accepted.State, accepted.FaultException?.ToString());
                Assert.HasCount(1, accepted.Notifications.Where(n => n.EventName == "NonceChannelExhausted"),
                    "the last step announces the exhausted channel");
                accepted.SnapshotCache.Commit();
            }
            Assert.AreEqual(BigInteger.One << 64,
                Success(snapshot, "getNonceSequence", [id, channel]).GetInteger(),
                "the cursor is the sentinel, never 0 and never a wrap");
            Assert.AreEqual(BigInteger.One << 64, Nonce(snapshot, id));

            using (var next = Invoke(snapshot, "executeUserOp",
                [id, Operation(snapshot, id, NativeContract.StdLib.Hash, "serialize", [7],
                    nonce: channel << 64)]))
            {
                Assert.AreEqual(VMState.FAULT, next.State, "a dead channel never executes its low sequence again");
                Assert.Contains(SmartAccountModuleProtocol.ErrorNonceExhausted, next.FaultException!.Message);
            }
        }

        /// <summary>Plants one 0x56 cursor row exactly as the core would serialize it.</summary>
        private static void PlantCursor(DataCache snapshot, UInt160 id, BigInteger channel, BigInteger cursor) =>
            snapshot.Add(NativeContract.SmartAccount.Key(SmartAccountModuleProtocol.PrefixNonceCursor).Add(id).Add(SmartAccountProtocol.EncodeChannel(channel)), new StorageItem(BinarySerializer.Serialize(new Integer(cursor), 32, 8)));

        [TestMethod]
        public void ValidateUserOpPreviewsTheDigestWithoutChangingState()
        {
            var snapshot = Snapshot(); UInt160 id = Register(snapshot);
            var operation = Operation(snapshot, id, NativeContract.StdLib.Hash, "serialize", [7]);
            var preview = (Array)Success(snapshot, "validateUserOp", [id, operation]);
            Assert.IsTrue(preview[0].GetBoolean());
            Assert.AreSequenceEqual(Success(snapshot, "getOperationDigest", [id, operation]).GetSpan().ToArray(),
                preview[1].GetSpan().ToArray());
            Assert.AreEqual(BigInteger.Zero, Sequence(Nonce(snapshot, id)), "The preview never consumes the nonce.");

            var forged = Operation(snapshot, id, NativeContract.StdLib.Hash, "serialize", [7]);
            forged[SmartAccountModuleProtocol.OpSignature] = new byte[] { 0x01, 0x02 };
            var rejected = (Array)Success(snapshot, "validateUserOp", [id, forged]);
            Assert.IsFalse(rejected[0].GetBoolean());

            using (var unknown = Invoke(snapshot, "validateUserOp",
                [NextCustody, Operation(snapshot, id, NativeContract.StdLib.Hash, "serialize", [7])]))
                Assert.AreEqual(VMState.FAULT, unknown.State);
        }

        /// <summary>
        /// The single-operation entrypoint is the only one: the removed batch
        /// entrypoint is not dispatchable, and one failed operation writes
        /// nothing at all.
        /// </summary>
        [TestMethod]
        public void SingleOperationIsTheOnlyEntrypoint()
        {
            var snapshot = Snapshot(); UInt160 id = Register(snapshot);
            UInt160 target = NativeContract.StdLib.Hash;
            BigInteger cursor = Nonce(snapshot, id);

            using (var batch = Invoke(snapshot, "executeUserOps",
                [id, new object[] { Operation(snapshot, id, target, "serialize", [7]) }]))
                Assert.AreEqual(VMState.FAULT, batch.State, "the batch entrypoint no longer exists");

            object[] forged = Operation(snapshot, id, target, "serialize", [7], nonce: cursor, sign: false);
            forged[SmartAccountModuleProtocol.OpSignature] = new byte[] { 0x01 };
            using (var failed = Invoke(snapshot, "executeUserOp", [id, forged]))
                Assert.AreEqual(VMState.FAULT, failed.State);
            Assert.AreEqual(cursor, Nonce(snapshot, id), "a faulted operation rolls back its nonce.");

            var executed = Success(snapshot, "executeUserOp", [id,
                Operation(snapshot, id, target, "serialize", [7], nonce: cursor)]);
            Assert.IsInstanceOfType<ByteString>(executed);
            Assert.AreEqual(cursor + 1, Nonce(snapshot, id));
        }

        [TestMethod]
        public void NativeServiceAndAccountProxyNeverBecomeWitnesses()
        {
            var snapshot = Snapshot(); UInt160 id = Register(snapshot);
            UInt160 proxy = SmartAccountProtocol.GetAccountAddress(id);
            snapshot.AddContract(Contract.CreateSignatureRedeemScript(CustodyKey.PublicKey).ToScriptHash(),
                TestUtils.GetContract(new byte[] { (byte)OpCode.RET }, TestUtils.CreateManifest("noop", ContractParameterType.Void)));

            var contract = TestUtils.GetContract(
                new byte[] { (byte)OpCode.SYSCALL, 0, 0, 0, 0, (byte)OpCode.RET },
                TestUtils.CreateManifest("check", ContractParameterType.Boolean, ContractParameterType.Hash160));
            // The target simply forwards Runtime.CheckWitness of its argument.
            using (var builder = new ScriptBuilder())
            {
                builder.EmitSysCall(ApplicationEngine.System_Runtime_CheckWitness).Emit(OpCode.RET);
                contract.Nef.Script = builder.ToArray();
                contract.Nef.CheckSum = NefFile.ComputeChecksum(contract.Nef);
            }
            snapshot.AddContract(contract.Hash, contract);

            var core = Operation(snapshot, id, contract.Hash, "check", [NativeContract.SmartAccount.Hash]);
            Assert.IsFalse(Success(snapshot, "executeUserOp", [id, core]).GetBoolean(),
                "The permissionless native dispatcher is not an authorization identity.");

            var self = Operation(snapshot, id, contract.Hash, "check", [proxy]);
            Assert.IsTrue(Success(snapshot, "executeUserOp", [id, self]).GetBoolean(),
                "The executing account authorizes its own dispatched target.");

            var stranger = Operation(snapshot, id, contract.Hash, "check", [NextCustody]);
            Assert.IsFalse(Success(snapshot, "executeUserOp", [id, stranger]).GetBoolean());
        }

        [TestMethod]
        public void ServiceWitnessRejectionIsHardforkGated()
        {
            foreach (bool active in new[] { false, true })
                foreach (TriggerType trigger in new[] { TriggerType.Application, TriggerType.Verification })
                {
                    var settings = active ? Settings : TestProtocolSettings.Default;
                    var tx = new Transaction { Signers = [new Signer { Account = NativeContract.SmartAccount.Hash, Scopes = WitnessScope.Global }], Attributes = [], Witnesses = [] };
                    using var engine = ApplicationEngine.Create(trigger, tx, Snapshot(), Block(1000), settings);
                    engine.LoadScript(new byte[] { (byte)OpCode.RET }, configureState: state => state.NativeCallingScriptHash = NativeContract.SmartAccount.Hash);
                    Assert.AreEqual(!active, engine.CheckWitnessInternal(NativeContract.SmartAccount.Hash));
                }
        }

        [TestMethod]
        public void FreezeIsImmediateAndThawBelongsToTheGovernanceInstance()
        {
            var snapshot = Snapshot();
            UInt160 id = UT_SmartAccountGovernance.Register(snapshot, 984, out ContractState governor);
            Array before = Account(snapshot, id);

            using (var foreign = Invoke(snapshot, "freezeAccount", [id], signers: [NextCustody]))
                Assert.AreEqual(VMState.FAULT, foreign.State, "Only the custody key can freeze the account.");
            Success(snapshot, "freezeAccount", [id], signers: [Custody]);
            Array frozen = Account(snapshot, id);
            Assert.AreEqual((int)SmartAccountStatus.Frozen, frozen[1].GetInteger());
            Assert.AreEqual(before[3].GetInteger() + 1, frozen[3].GetInteger(), "authorityEpoch");
            Assert.AreEqual(before[4].GetInteger() + 1, frozen[4].GetInteger(),
                "the emergency freeze advances the configuration nonce");
            using (var frozenOp = Invoke(snapshot, "executeUserOp",
                [id, Operation(snapshot, id, NativeContract.StdLib.Hash, "serialize", [7])]))
                Assert.AreEqual(VMState.FAULT, frozenOp.State, "A frozen account executes nothing.");

            // The minimal core holds no thaw timelock and grants no custody thaw:
            // the bound governance instance alone ends the freeze. A user-space
            // governance module owns any delay.
            using (var custodyThaw = Invoke(snapshot, "unfreezeAccount", [id], signers: [Custody]))
                Assert.AreEqual(VMState.FAULT, custodyThaw.State,
                    "The custody witness is not an administration principal.");
            using (var foreignThaw = Invoke(snapshot, "unfreezeAccount", [id], signers: [NextCustody]))
                Assert.AreEqual(VMState.FAULT, foreignThaw.State, "Only the governance instance thaws the account.");
            Assert.AreEqual((int)SmartAccountStatus.Frozen, Account(snapshot, id)[1].GetInteger(),
                "A refused thaw never moves the account.");

            UT_SmartAccountGovernance.Land(snapshot, governor, UT_SmartAccountGovernance.GovThaw, [id]);
            Array thawed = Account(snapshot, id);
            Assert.AreEqual((int)SmartAccountStatus.Active, thawed[1].GetInteger());
            Assert.AreEqual(frozen[3].GetInteger() + 1, thawed[3].GetInteger(),
                "The thaw advances the authority epoch, killing pre-freeze signatures.");
            Assert.AreEqual(frozen[8].GetInteger() + 1, thawed[8].GetInteger(),
                "The freeze and the thaw each advance the control revision once.");
            Assert.AreEqual(frozen[4].GetInteger() + 1, thawed[4].GetInteger(),
                "Freeze and thaw each advance the configuration nonce, so pre-freeze configurations are stale.");

            // The thawed account executes again under the new authority epoch.
            Assert.IsInstanceOfType<ByteString>(Success(snapshot, "executeUserOp",
                [id, Operation(snapshot, id, NativeContract.StdLib.Hash, "serialize", [7])]));

            using (var secondThaw = UT_SmartAccountGovernance.TryLand(snapshot, governor,
                UT_SmartAccountGovernance.GovThaw, [id]))
                Assert.AreEqual(VMState.FAULT, secondThaw.State, "Only a frozen account can be thawed.");
            using (var unknown = Invoke(snapshot, "unfreezeAccount", [NextCustody], signers: [Custody]))
                Assert.AreEqual(VMState.FAULT, unknown.State, "An unregistered account has nothing to thaw.");
        }
    }
}
