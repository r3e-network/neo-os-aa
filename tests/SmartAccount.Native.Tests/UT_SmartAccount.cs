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
        internal static DataCache Snapshot()
        {
            var snapshot = TestBlockchain.GetTestSnapshotCache();
            snapshot.AddContract(NativeContract.SmartAccount.Hash, NativeContract.SmartAccount.GetContractState(Settings, 1));
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
        private static byte[] Script(string method, object[] args, UInt160 target = null)
        {
            using var builder = new ScriptBuilder();
            Push(builder, args);
            builder.EmitPush((int)CallFlags.All).EmitPush(method)
                .EmitPush(target ?? NativeContract.SmartAccount.Hash)
                .EmitSysCall(ApplicationEngine.System_Contract_Call);
            return builder.ToArray();
        }
        internal static ApplicationEngine Invoke(DataCache snapshot, string method, object[] args, ulong time = 1000,
            UInt160[] signers = null, TriggerType trigger = TriggerType.Application, UInt160 target = null)
        {
            byte[] script = Script(method, args, target);
            var tx = new Transaction
            {
                Version = 0,
                Script = script,
                Signers = (signers ?? [Custody]).Select(a => new Signer { Account = a, Scopes = WitnessScope.Global }).ToArray(),
                Attributes = [],
                Witnesses = [],
            };
            var engine = ApplicationEngine.Create(trigger, tx, snapshot, Block(time), Settings, gas: 10_000_000_000);
            engine.LoadScript(tx.Script); engine.Execute(); return engine;
        }
        internal static StackItem Success(DataCache snapshot, string method, object[] args, ulong time = 1000,
            UInt160[] signers = null, UInt160 target = null)
        {
            using var engine = Invoke(snapshot, method, args, time, signers, target: target);
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
            Success(snapshot, "createAccount", [id, Custody, Salt, 0, new object[0]]);
            return id;
        }
        private static Array Account(DataCache snapshot, UInt160 id) => (Array)Success(snapshot, "getAccount", [id]);

        /// <summary>The current packed nonce of the account's built-in channel.</summary>
        private static BigInteger Nonce(DataCache snapshot, UInt160 id) =>
            Success(snapshot, "getNonce", [id, 0, new byte[32]]).GetInteger();

        /// <summary>The 64-bit sequence of a packed nonce (the 191-bit channel is the high half).</summary>
        private static BigInteger Sequence(BigInteger nonce) => nonce & ((BigInteger.One << 64) - 1);

        /// <summary>
        /// A complete v4 operation: [version, target, method, args, nonce,
        /// nonceSubkey, deadline, validatorId, credentialGeneration,
        /// authorityEpoch, configurationNonce, signature, hookProofs].
        /// </summary>
        internal static object[] Operation(DataCache snapshot, UInt160 id, UInt160 target, string method, object[] args,
            BigInteger? nonce = null, BigInteger? deadline = null, bool sign = true,
            BigInteger? validatorId = null, BigInteger? credentialGeneration = null)
        {
            Array control = Account(snapshot, id);
            object[] operation =
            [
                (BigInteger)SmartAccountModuleProtocol.ModuleProtocolVersion, target, method, args,
                nonce ?? Nonce(snapshot, id), new byte[32], deadline ?? int.MaxValue,
                validatorId ?? BigInteger.Zero, credentialGeneration ?? BigInteger.One,
                control[4].GetInteger(), control[5].GetInteger(),
                new byte[] { 0x01 }, new object[0],
            ];
            if (sign) operation[SmartAccountModuleProtocol.OpSignature] = Signature(snapshot, id, operation);
            return operation;
        }

        /// <summary>The §8 built-in signature envelope over the operation digest.</summary>
        private static byte[] Signature(DataCache snapshot, UInt160 id, object[] operation)
        {
            byte[] digest = Success(snapshot, "getOperationDigest", [id, operation]).GetSpan().ToArray();
            return SignatureOver(id, digest);
        }
        private static byte[] SignatureOver(UInt160 id, byte[] digest)
        {
            byte[] signature = Neo.Cryptography.Crypto.Sign(digest, CustodyKey, Neo.Cryptography.HashAlgorithm.SHA256);
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
        public void NativeIdentityManifestAndImplementationIdAreStable()
        {
            var native = NativeContract.SmartAccount;
            Assert.AreEqual("SmartAccount", native.Name);
            Assert.AreEqual(UInt160.Parse("0x398dc3f0227d7efac5533ed5ce9937390c158084"), native.Hash);
            Assert.AreEqual(SmartAccountProtocol.ServiceHash, native.Hash);
            Assert.AreEqual(NativeContract.TemporaryStorage.Id - 1, native.Id);
            Assert.IsFalse(native.IsActive(TestProtocolSettings.Default, uint.MaxValue));
            // The ABI carries no method-level hardfork gates: the contract-level
            // Activations gate (IsActive above) is decisive, so the method surface
            // is identical whether or not HF_SmartAccountV1 is configured.
            Assert.AreSequenceEqual(
                native.GetContractState(Settings, 1).Manifest.Abi.Methods.Select(m => m.Name).ToArray(),
                native.GetContractState(TestProtocolSettings.Default, 1).Manifest.Abi.Methods.Select(m => m.Name).ToArray());

            ContractState state = native.GetContractState(Settings, 1);
            string[] methods = state.Manifest.Abi.Methods.Select(m => m.Name).ToArray();
            string[] specifiedMethods =
            {
                "createAccount", "createAccounts", "executeUserOp", "executeUserOps", "validateUserOp",
                "getOperationDigest", "verify", "getNonce", "getNonceSequence",
                "getAccount", "getAccountAddress", "getProtocolInfo", "getAccountImplementationId",
                "getModules", "getModule", "isModuleInstalled", "getAuthorizedModuleId",
                "freezeAccount", "unfreezeAccount", "installModule", "removeModule",
                "setRecoveryPolicy", "setBuiltinAuthorization", "revokeModuleCredentials", "resetAccount",
            };
            Assert.AreSequenceEqual(specifiedMethods.Order(StringComparer.Ordinal).ToArray(), methods.Order(StringComparer.Ordinal).ToArray(), "The active ABI must export exactly the specified entries.");
            // The advanced features live in user-space modules now; their ABI is
            // gone, not merely unmarked.
            foreach (string removed in new[]
            {
                "isValidSignature", "canonicalP256PublicKey",
                "proposeConfiguration", "confirmConfiguration", "cancelConfiguration",
                "getPendingConfiguration", "getPendingConfigurationIntentIds",
                "getHookOrder", "revokeCredentials", "supportsModuleType", "supportsExecutionMode",
                "beginRecovery", "cancelRecovery", "executeRecovery", "getRecoveryStatus",
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
            Assert.IsTrue(Signature(state, "setRecoveryPolicy").SequenceEqual(new[]
            {
                ContractParameterType.Hash160, ContractParameterType.Hash160,
                ContractParameterType.Integer, ContractParameterType.Boolean,
            }), "setRecoveryPolicy(accountId, recoveryAuthority, recoveryTimelockMs, ownerOnlyRecovery)");
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
            Assert.AreEqual("NativeSmartAccount/v4", Success(Snapshot(), "getAccountImplementationId", []).GetString());
        }

        [TestMethod]
        public void CreationStoresTheV4ControlRecordAndRejectsDuplicatesOrForeignCustody()
        {
            var snapshot = Snapshot(); UInt160 id = Register(snapshot);
            var protocol = (Array)Success(snapshot, "getProtocolInfo", []);
            Assert.AreEqual(SmartAccountProtocol.Version, protocol[0].GetInteger());
            Assert.IsFalse(protocol[1].GetBoolean(), "The protocol record carries the migration-mode flag, not an identity.");

            Array account = Account(snapshot, id);
            Assert.IsTrue(account[0].GetBoolean());
            Assert.AreEqual((int)SmartAccountStatus.Active, account[1].GetInteger());
            Assert.AreEqual(Custody, new UInt160(account[2].GetSpan()));
            Assert.AreEqual(UInt160.Zero, new UInt160(account[3].GetSpan()));
            Assert.AreEqual(BigInteger.One, account[4].GetInteger(), "authorityEpoch");
            Assert.AreEqual(BigInteger.Zero, account[5].GetInteger(), "configurationNonce");
            Assert.IsTrue(account[7].GetBoolean(), "defaultOperationAuthorization");
            Assert.IsTrue(account[8].GetBoolean(), "defaultMessageAuthorization");
            Assert.IsFalse(account[9].GetBoolean(), "ownerOnlyRecovery");
            Assert.IsFalse(account[12].GetBoolean(), "recoveryPending");

            using (var duplicate = Invoke(snapshot, "createAccount", [id, Custody, Salt, 0, new object[0]]))
                Assert.AreEqual(VMState.FAULT, duplicate.State);
            UInt160 foreign = SmartAccountProtocol.GetAccountId(NextCustody, Salt);
            using (var unauthorized = Invoke(snapshot, "createAccount", [foreign, NextCustody, Salt, 0, new object[0]]))
                Assert.AreEqual(VMState.FAULT, unauthorized.State, "A foreign custody signature cannot create an account.");
            using (var mismatched = Invoke(snapshot, "createAccount", [id, Custody, new byte[32], 0, new object[0]]))
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
            snapshot.Add(new StorageKey { Id = NativeContract.SmartAccount.Id,
                    Key = SmartAccountProtocol.GetNonceCursorKey(id,
                        SmartAccountProtocol.ChannelFromNonce(packed)) },
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

        [TestMethod]
        public void BatchEnvelopeIsAtomicAndSucceedsInOrder()
        {
            var snapshot = Snapshot(); UInt160 id = Register(snapshot);
            UInt160 target = NativeContract.StdLib.Hash;
            BigInteger cursor = Nonce(snapshot, id);

            var broken = new object[]
            {
                Operation(snapshot, id, target, "serialize", [7], nonce: cursor),
                Operation(snapshot, id, target, "serialize", [8], nonce: cursor + 1, sign: false),
            };
            using (var failed = Invoke(snapshot, "executeUserOps", [id, broken]))
                Assert.AreEqual(VMState.FAULT, failed.State);
            Assert.AreEqual(cursor, Nonce(snapshot, id), "A batch fault rolls back every nonce.");

            var batch = new object[]
            {
                Operation(snapshot, id, target, "serialize", [7], nonce: cursor),
                Operation(snapshot, id, target, "serialize", [8], nonce: cursor + 1),
            };
            var results = (Array)Success(snapshot, "executeUserOps", [id, batch]);
            Assert.HasCount(2, results);
            Assert.IsInstanceOfType<ByteString>(results[0]);
            Assert.AreEqual(cursor + 2, Nonce(snapshot, id));

            using (var empty = Invoke(snapshot, "executeUserOps", [id, new object[0]]))
                Assert.AreEqual(VMState.FAULT, empty.State);
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
        public void FreezeAndUnfreezeAreCustodyGatedAndAdvanceTheEpoch()
        {
            var snapshot = Snapshot(); UInt160 id = Register(snapshot);

            using (var foreign = Invoke(snapshot, "freezeAccount", [id], signers: [NextCustody]))
                Assert.AreEqual(VMState.FAULT, foreign.State, "Only the custody key can freeze the account.");
            Success(snapshot, "freezeAccount", [id], signers: [Custody]);
            Assert.AreEqual((int)SmartAccountStatus.Frozen, Account(snapshot, id)[1].GetInteger());
            Assert.AreEqual(new BigInteger(2), Account(snapshot, id)[4].GetInteger(), "authorityEpoch");
            using (var frozen = Invoke(snapshot, "executeUserOp",
                [id, Operation(snapshot, id, NativeContract.StdLib.Hash, "serialize", [7])]))
                Assert.AreEqual(VMState.FAULT, frozen.State, "A frozen account executes nothing.");

            // The minimal core holds no thaw timelock: a custody witness ends the
            // freeze directly. A user-space governance module owns any delay.
            using (var foreignThaw = Invoke(snapshot, "unfreezeAccount", [id], signers: [NextCustody]))
                Assert.AreEqual(VMState.FAULT, foreignThaw.State, "Only the custody key can thaw the account.");
            Assert.AreEqual((int)SmartAccountStatus.Frozen, Account(snapshot, id)[1].GetInteger(),
                "A refused thaw never moves the account.");

            Success(snapshot, "unfreezeAccount", [id], signers: [Custody]);
            Assert.AreEqual((int)SmartAccountStatus.Active, Account(snapshot, id)[1].GetInteger());
            Assert.AreEqual(new BigInteger(3), Account(snapshot, id)[4].GetInteger(),
                "The thaw advances the authority epoch, killing pre-freeze signatures.");
            Assert.AreEqual(new BigInteger(3), Account(snapshot, id)[11].GetInteger(),
                "The freeze and the thaw each advance the control revision once.");
            Assert.AreEqual(new BigInteger(2), Account(snapshot, id)[5].GetInteger(),
                "Freeze and thaw each advance the configuration nonce, so pre-freeze configurations are stale.");
            Assert.IsFalse(Account(snapshot, id)[12].GetBoolean(), "the recovery slot stays inactive");

            // The thawed account executes again under the new authority epoch.
            Assert.IsInstanceOfType<ByteString>(Success(snapshot, "executeUserOp",
                [id, Operation(snapshot, id, NativeContract.StdLib.Hash, "serialize", [7])]));

            using (var secondThaw = Invoke(snapshot, "unfreezeAccount", [id], signers: [Custody]))
                Assert.AreEqual(VMState.FAULT, secondThaw.State, "Only a frozen account can be thawed.");
            using (var unknown = Invoke(snapshot, "unfreezeAccount", [NextCustody], signers: [Custody]))
                Assert.AreEqual(VMState.FAULT, unknown.State, "An unregistered account has nothing to thaw.");
        }
    }
}
