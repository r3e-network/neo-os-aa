using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo.Persistence;
using Neo.UnitTests.Extensions;
using Neo.Extensions;
using Neo.SmartContract;
using Neo.VM.Types;
using System.Security.Cryptography;
using Neo.SmartContract.Native;
using Neo.VM;
using System;
using System.IO;
using System.Linq;
using System.Numerics;
using Array = Neo.VM.Types.Array;
using static Neo.UnitTests.SmartContract.Native.UT_SmartAccount;

namespace Neo.UnitTests.SmartContract.Native
{
    [TestClass]
    public class UT_SmartAccountStandardModules
    {
        private static UInt160 Deploy(DataCache snapshot, string name)
        {
            string prefix = Path.Combine(AppContext.BaseDirectory, "StandardModules", name);
            var contract = (Array)Success(snapshot, "deploy",
                [File.ReadAllBytes(prefix + ".nef"), File.ReadAllBytes(prefix + ".manifest.json"),
                    NativeContract.SmartAccount.Hash], target: NativeContract.ContractManagement.Hash);
            return new UInt160(contract[2].GetSpan());
        }

        [TestMethod]
        [DataRow(false)]
        [DataRow(true)]
        public void ReviewedModuleConfigurationUsesCorePhaseAndRollsBackOnFault(bool badTail)
        {
            var snapshot = Snapshot();
            var id = Register(snapshot);
            var governance = Deploy(snapshot, "GovernanceModule");
            var hook = Deploy(snapshot, "WhitelistHook");
            Success(snapshot, "installModule", [id, 1, governance, new object[0]]);
            var module = Success(snapshot, "installModule", [id, 4, hook, new object[0]]).GetInteger();
            object[] config = ["allowTarget", NativeContract.GAS.Hash];
            object[] row = [3, module, config];
            object[] actions = badTail ? [row, new object[] { 3, module, new object[] { "unknown" } }] : [row];
            bool Allowed() => Success(snapshot, "isWhitelisted", [id, module, NativeContract.GAS.Hash], target: hook).GetBoolean();
            Assert.IsFalse(Allowed());
            using (var direct = Invoke(snapshot, "applyConfigurationActions", [id, actions]))
                Assert.AreEqual(VMState.FAULT, direct.State);
            var intent = Success(snapshot, "proposeConfiguration", [id, actions, new object[0]], target: governance);
            using (var early = Invoke(snapshot, "confirmConfiguration", [id, intent.GetInteger(), actions], MatureAt - 1, target: governance))
                Assert.AreEqual(VMState.FAULT, early.State);
            Assert.IsFalse(Allowed());
            if (badTail)
            {
                using var denied = Invoke(snapshot, "confirmConfiguration", [id, intent.GetInteger(), actions], MatureAt, target: governance);
                Assert.AreEqual(VMState.FAULT, denied.State);
                Assert.Contains("Unknown config command", denied.FaultException!.ToString());
                Assert.IsFalse(Allowed());
            }
            else
            {
                Success(snapshot, "confirmConfiguration", [id, intent.GetInteger(), actions], MatureAt, target: governance);
                Assert.IsTrue(Allowed());
            }
        }

        [TestMethod]
        public void GovernedSubjectsCommitExactScriptIdentitiesOnlyAfterMaturity()
        {
            var snapshot = Snapshot();
            UInt160 id = Register(snapshot), governance = Deploy(snapshot, "GovernanceModule"), signing = Deploy(snapshot, "SigningModule");
            Success(snapshot, "installModule", [id, 1, governance, new object[0]]);
            var canonical = Contract.CreateSignatureRedeemScript(CustodyKey.PublicKey);
            var subject = SHA256.HashData(canonical);
            object[] subjects = [subject];
            object[] actions = [new object[] { 9, subjects, 1 }];
            var before = (Array)Success(snapshot, "getMessageSubjects", [id]);
            Assert.AreEqual(BigInteger.One, before[2].GetInteger());
            using (var direct = Invoke(snapshot, "applyConfigurationActions", [id, actions]))
                Assert.AreEqual(VMState.FAULT, direct.State);
            using (var obsolete = Invoke(snapshot, "updateMessageSubject", [id, subjects, 1], target: signing))
                Assert.AreEqual(VMState.FAULT, obsolete.State);
            using (var seeded = Invoke(snapshot, "installModule", [id, 1, signing, new object[] { subjects, 1 }]))
                Assert.AreEqual(VMState.FAULT, seeded.State);
            var intent = Success(snapshot, "proposeConfiguration", [id, actions, new object[0]], target: governance).GetInteger();
            using (var early = Invoke(snapshot, "confirmConfiguration", [id, intent, actions], MatureAt - 1, target: governance))
                Assert.AreEqual(VMState.FAULT, early.State);
            object[] altered = [new object[] { 9, new object[] { Custody }, 1 }];
            using (var replaced = Invoke(snapshot, "confirmConfiguration", [id, intent, altered], MatureAt, target: governance))
                Assert.AreEqual(VMState.FAULT, replaced.State);
            Assert.AreEqual(BigInteger.One, ((Array)Success(snapshot, "getMessageSubjects", [id]))[2].GetInteger());
            Success(snapshot, "confirmConfiguration", [id, intent, actions], MatureAt, target: governance);
            var result = (Array)Success(snapshot, "getMessageSubjects", [id], target: signing);
            Assert.AreSequenceEqual(subject, ((Array)result[0])[0].GetSpan().ToArray());
            Assert.AreEqual(new BigInteger(2), result[2].GetInteger());
            using var replay = Invoke(snapshot, "confirmConfiguration", [id, intent, actions], MatureAt, target: governance);
            Assert.AreEqual(VMState.FAULT, replay.State);
        }

        [TestMethod]
        public void DelegatedMessageSignerCannotSpendAndDoesNotChangeTheCustodyChannel()
        {
            var snapshot = Snapshot();
            UInt160 id = Register(snapshot), governance = Deploy(snapshot, "GovernanceModule");
            Success(snapshot, "installModule", [id, 1, governance, new object[0]]);
            var key = new Neo.Wallets.KeyPair(Enumerable.Repeat((byte)0x22, 32).ToArray());
            var script = Contract.CreateSignatureRedeemScript(key.PublicKey);
            object[] actions = [new object[] { 9, new object[] { SHA256.HashData(script) }, 1 }];
            var nonce = Success(snapshot, "getNonce", [id, 0, new byte[32]]).GetInteger();
            var proposal = Success(snapshot, "proposeConfiguration", [id, actions, new object[0]], target: governance);
            Success(snapshot, "confirmConfiguration", [id, proposal.GetInteger(), actions], MatureAt, target: governance);
            Assert.AreEqual(nonce, Success(snapshot, "getNonce", [id, 0, new byte[32]]).GetInteger());
            var operation = Operation(snapshot, id, NativeContract.GAS.Hash, "symbol", []);
            var correct = operation[11];
            var digest = Success(snapshot, "getOperationDigest", [id, operation]).GetSpan().ToArray();
            var signature = Neo.Cryptography.Crypto.Sign(digest, key, Neo.Cryptography.HashAlgorithm.SHA256);
            operation[11] = BinarySerializer.Serialize(new Array([new Integer(4), new Integer(0), new Integer(1),
                new Array([new Array([new ByteString(script), new ByteString(signature)])])]), 8192, 8);
            Assert.IsFalse(((Array)Success(snapshot, "validateUserOp", [id, operation], MatureAt))[0].GetBoolean());
            using (var refused = Invoke(snapshot, "executeUserOp", [id, operation], MatureAt))
                Assert.AreEqual(VMState.FAULT, refused.State);
            operation[11] = correct;
            Assert.AreEqual("GAS", Success(snapshot, "executeUserOp", [id, operation], MatureAt).GetString());
        }

        [TestMethod]
        public void GenuineGovernanceCodeWithDifferentManifestCannotSetSubjects()
        {
            var snapshot = Snapshot();
            var id = Register(snapshot);
            string prefix = Path.Combine(AppContext.BaseDirectory, "StandardModules", "GovernanceModule");
            var manifest = Neo.SmartContract.Manifest.ContractManifest.Parse(File.ReadAllText(prefix + ".manifest.json"));
            manifest.Extra!["Description"] = "test deployment";
            var deployed = (Array)Success(snapshot, "deploy", [File.ReadAllBytes(prefix + ".nef"),
                System.Text.Encoding.UTF8.GetBytes(manifest.ToJson().ToString()), NativeContract.SmartAccount.Hash],
                target: NativeContract.ContractManagement.Hash);
            var gov = new UInt160(deployed[2].GetSpan());
            Success(snapshot, "installModule", [id, 1, gov, new object[0]]);
            object[] actions = [new object[] { 9, new object[] { Custody }, 1 }];
            var intent = Success(snapshot, "proposeConfiguration", [id, actions, new object[0]], target: gov).GetInteger();
            using var denied = Invoke(snapshot, "confirmConfiguration", [id, intent, actions], MatureAt, target: gov);
            Assert.AreEqual(VMState.FAULT, denied.State);
            Assert.Contains("SA_UNAUTHORIZED", denied.FaultException!.ToString());
            Assert.AreEqual(BigInteger.One, ((Array)Success(snapshot, "getMessageSubjects", [id]))[2].GetInteger());
        }

        private static UInt160 ConfigureDelayedRecovery(DataCache snapshot, UInt160 id)
        {
            var seat = Deploy(snapshot, "RecoveryModule");
            Success(snapshot, "installModule", [id, 5, seat, new object[0]]);
            Success(snapshot, "setRecoveryPolicy", [id, Guardian, new BigInteger(AccountControl.RecoveryTimelockMinMs), false],
                signers: [Custody, Guardian]);
            return seat;
        }

        [TestMethod]
        public void ThresholdOwnsSpendingUntilPresetRecoveryMatures()
        {
            var snapshot = Snapshot();
            UInt160 id = Register(snapshot), governance = Deploy(snapshot, "GovernanceModule"),
                adapter = Deploy(snapshot, "ThresholdPolicyModule"), member = Deploy(snapshot, "MultiSigValidator");
            var seat = ConfigureDelayedRecovery(snapshot, id);
            var g = Success(snapshot, "installModule", [id, 1, governance, new object[0]]).GetInteger();
            var m = Success(snapshot, "installModule", [id, 1, member, new object[] { "setMemberKey", CustodyKey.PublicKey.EncodePoint(true) }]).GetInteger();
            var otherKey = new Neo.Wallets.KeyPair(Enumerable.Repeat((byte)0x22, 32).ToArray());
            var n = Success(snapshot, "installModule", [id, 1, member, new object[] { "setMemberKey", otherKey.PublicKey.EncodePoint(true) }]).GetInteger();
            object[] actions = [new object[] { 7, 0, 1, new object[] { m, n }, true }];
            using (var direct = Invoke(snapshot, "applyConfigurationActions", [id, actions]))
                Assert.AreEqual(VMState.FAULT, direct.State);
            using (var direct = Invoke(snapshot, "setThresholdPolicy", [id, 1, new object[]{m}], target: adapter))
                Assert.AreEqual(VMState.FAULT, direct.State);
            var proposal = Success(snapshot, "proposeConfiguration", [id, actions, new object[0]], target: governance).GetInteger();
            Success(snapshot, "beginRecovery", [id, UInt160.Zero], 1001, signers: [Guardian], target: seat);
            Success(snapshot, "confirmConfiguration", [id, proposal, actions], MatureAt, target: governance);
            var policyId = n + 1;
            var stored = (Array)Success(snapshot, "getThresholdPolicy", [id, policyId], target: adapter);
            Assert.AreEqual(m, ((Array)stored[1])[0].GetInteger()); Assert.IsTrue(stored[2].GetBoolean());
            Assert.AreEqual(BigInteger.One, stored[3].GetInteger());
            using (var removal = Invoke(snapshot, "removeModule", [id, m, new object[0]]))
                Assert.AreEqual(VMState.FAULT, removal.State);
            var nonce = Success(snapshot, "getNonce", [id, policyId, new byte[32]]).GetInteger();
            object[] operation = Operation(snapshot, id, NativeContract.GAS.Hash, "symbol", [], nonce:nonce, sign:false, validatorId:policyId);
            byte[] digest = Success(snapshot, "getOperationDigest", [id, operation]).GetSpan().ToArray();
            var preimage = SmartAccountProtocol.Concat("NeoSmartAccount/ThresholdMember"u8.ToArray(), [4], digest,
                SmartAccountProtocol.UInt64Be(m), SmartAccountProtocol.UInt64Be(1));
            byte[] signature = Neo.Cryptography.Crypto.Sign(SHA256.HashData(preimage), CustodyKey, Neo.Cryptography.HashAlgorithm.SHA256);
            byte[] EncodeEntries(params Array[] rows) => BinarySerializer.Serialize(new Array(rows), 16384, 128);
            var approved = new Array([new Integer(m), new ByteString(signature)]);
            var absent = new Array([new Integer(n), new ByteString(System.Array.Empty<byte>())]);
            foreach (var malformed in new[] { EncodeEntries(approved), EncodeEntries(absent, approved), EncodeEntries(approved, new Array([new Integer(m), new ByteString(signature)])) })
            {
                operation[11] = malformed;
                using var invalid = Invoke(snapshot, "executeUserOp", [id, operation], MatureAt);
                Assert.AreEqual(VMState.FAULT, invalid.State);
                Assert.Contains("SA_OPERATION_MALFORMED", invalid.FaultException!.ToString());
            }
            var directNonce = Success(snapshot, "getNonce", [id, m, new byte[32]]).GetInteger();
            var directOp = Operation(snapshot, id, NativeContract.GAS.Hash, "symbol", [], nonce: directNonce,
                sign: false, validatorId: m);
            using (var memberRoute = Invoke(snapshot, "executeUserOp", [id, directOp], MatureAt))
            {
                Assert.AreEqual(VMState.FAULT, memberRoute.State);
                Assert.Contains("SA_MODULE_NOT_ROUTABLE", memberRoute.FaultException!.ToString());
            }
            operation[11] = EncodeEntries(approved, absent);
            var preview = (Array)Success(snapshot, "validateUserOp", [id, operation], MatureAt);
            Assert.IsTrue(preview[0].GetBoolean());
            Assert.AreSequenceEqual(digest, preview[1].GetSpan().ToArray());
            Assert.AreEqual(nonce, Success(snapshot, "getNonce", [id, policyId, new byte[32]]).GetInteger());
            Assert.AreEqual("GAS", Success(snapshot, "executeUserOp", [id, operation], MatureAt).GetString());
            object[] disable = [new object[] { 7, policyId, 0, new object[0], false }];
            using (var unilateral = Invoke(snapshot, "proposeConfiguration", [id, disable, new object[0]], MatureAt, target: governance))
                Assert.AreEqual(VMState.FAULT, unilateral.State);
            var effective = (Array)Success(snapshot, "getThresholdPolicy", [id, 0]);
            Assert.AreEqual(policyId, effective[4].GetInteger());
            using (var freeze = Invoke(snapshot, "freezeAccount", [id], MatureAt, signers: [Custody]))
            {
                Assert.AreEqual(VMState.FAULT, freeze.State);
                Assert.Contains("SA_UNAUTHORIZED", freeze.FaultException!.ToString());
            }
            using (var change = Invoke(snapshot, "setRecoveryPolicy",
                [id, Guardian, new BigInteger(AccountControl.RecoveryTimelockMinMs), false], MatureAt, signers: [Custody]))
            {
                Assert.AreEqual(VMState.FAULT, change.State);
                Assert.Contains("SA_UNAUTHORIZED", change.FaultException!.ToString());
            }
            var provider = NativeContract.ContractManagement.GetContract(snapshot, governance)!;
            var policyKey = new StorageKey { Id = provider.Id, Key = SmartAccountProtocol.Concat([5], id.ToArray()) };
            var coreKey = new StorageKey { Id = NativeContract.SmartAccount.Id,
                Key = SmartAccountProtocol.GetThresholdPolicyKey(id, policyId) };
            var commitment = snapshot[coreKey].Value.ToArray();
            Assert.HasCount(36, commitment);
            Assert.AreSequenceEqual(SHA256.HashData(snapshot[policyKey].Value.Span), commitment[4..]);
            snapshot.Delete(policyKey);
            using (var missing = Invoke(snapshot, "getThresholdPolicy", [id, 0]))
                Assert.AreEqual(VMState.FAULT, missing.State);
            using (var reopen = Invoke(snapshot, "setBuiltinAuthorization", [id, true, true]))
                Assert.AreEqual(VMState.FAULT, reopen.State);
            using (var replaceSeat = Invoke(snapshot, "setRecoveryPolicy", [id, Custody, new BigInteger(AccountControl.RecoveryTimelockMinMs), true]))
                Assert.AreEqual(VMState.FAULT, replaceSeat.State);
            var custodyOp = Operation(snapshot, id, NativeContract.GAS.Hash, "symbol", []);
            Assert.IsFalse(((Array)Success(snapshot, "validateUserOp", [id, custodyOp], MatureAt))[0].GetBoolean());
            var started = MatureAt + AccountControl.RecoveryTimelockMinMs;
            using (var stale = Invoke(snapshot, "executeRecovery", [id], started, target: seat))
            {
                Assert.AreEqual(VMState.FAULT, stale.State);
                Assert.Contains("SA_EPOCH_STALE", stale.FaultException!.ToString());
            }
            Success(snapshot, "cancelRecovery", [id], started, signers: [Guardian], target: seat);
            Success(snapshot, "beginRecovery", [id, UInt160.Zero], started, signers: [Guardian], target: seat);
            var mature = started + AccountControl.RecoveryTimelockMinMs;
            using (var earlyReset = Invoke(snapshot, "executeRecovery", [id], mature - 1, target: seat))
                Assert.AreEqual(VMState.FAULT, earlyReset.State);
            Success(snapshot, "executeRecovery", [id], mature, target: seat);
            Assert.IsTrue(((Array)Success(snapshot, "getAccount", [id]))[7].GetBoolean());
            Assert.IsEmpty((Array)Success(snapshot, "getThresholdPolicy", [id, policyId]));
            Assert.IsEmpty((Array)Success(snapshot,"getThresholdPolicy",[id,g]));
        }

        [TestMethod]
        [DataRow(false)]
        [DataRow(true)]
        public void ThresholdEnrollmentRequiresPresetRecoveryAndDistinctKeys(bool installRecovery)
        {
            var snapshot = Snapshot();
            var id = Register(snapshot);
            var gov = Deploy(snapshot, "GovernanceModule");
            var member = Deploy(snapshot, "MultiSigValidator");
            Success(snapshot, "installModule", [id, 1, gov, new object[0]]);
            if (installRecovery) ConfigureDelayedRecovery(snapshot, id);
            byte[] firstKey = CustodyKey.PublicKey.EncodePoint(true);
            byte[] secondKey = installRecovery ? firstKey :
                new Neo.Wallets.KeyPair(Enumerable.Repeat((byte)0x22, 32).ToArray()).PublicKey.EncodePoint(true);
            var first = Success(snapshot, "installModule", [id, 1, member, new object[] { "setMemberKey", firstKey }]).GetInteger();
            var second = Success(snapshot, "installModule", [id, 1, member, new object[] { "setMemberKey", secondKey }]).GetInteger();
            object[] actions = [new object[] { 7, 0, 2, new object[] { first, second }, true }];
            var proposal = Success(snapshot, "proposeConfiguration", [id, actions, new object[0]], target: gov).GetInteger();
            using var refused = Invoke(snapshot, "confirmConfiguration", [id, proposal, actions], MatureAt, target: gov);
            Assert.AreEqual(VMState.FAULT, refused.State);
            Assert.Contains(installRecovery ? "SA_OPERATION_MALFORMED" : "SA_ACCOUNT_STATUS", refused.FaultException!.ToString());
            Assert.IsEmpty((Array)Success(snapshot, "getThresholdPolicy", [id, 0]));
            Assert.IsTrue(((Array)Success(snapshot, "getAccount", [id]))[7].GetBoolean());
        }

        [TestMethod]
        [DataRow(10, 10)]
        [DataRow(2, 3)]
        public void ThresholdSpendingEnforcesTheChosenQuorum(int threshold, int memberCount)
        {
            var snapshot = Snapshot();
            var id = Register(snapshot);
            var gov = Deploy(snapshot, "GovernanceModule");
            var validator = Deploy(snapshot, "MultiSigValidator");
            Success(snapshot, "installModule", [id, 1, gov, new object[0]]);
            ConfigureDelayedRecovery(snapshot, id);
            var keys = Enumerable.Range(1, memberCount).Select(i =>
                new Neo.Wallets.KeyPair(Enumerable.Repeat((byte)i, 32).ToArray())).ToArray();
            var members = keys.Select(k => Success(snapshot, "installModule", [id, 1, validator,
                new object[] { "setMemberKey", k.PublicKey.EncodePoint(true) }]).GetInteger()).ToArray();
            object[] actions = [new object[] { 7, 0, threshold, members.Cast<object>().ToArray(), true }];
            var proposal = Success(snapshot, "proposeConfiguration", [id, actions, new object[0]], target: gov).GetInteger();
            Success(snapshot, "confirmConfiguration", [id, proposal, actions], MatureAt, target: gov);
            var policyId = members[^1] + 1;
            var nonce = Success(snapshot, "getNonce", [id, policyId, new byte[32]]).GetInteger();
            var operation = Operation(snapshot, id, NativeContract.GAS.Hash, "symbol", [], nonce: nonce, sign: false, validatorId: policyId);
            var digest = Success(snapshot, "getOperationDigest", [id, operation]).GetSpan().ToArray();
            var signatures = new Array();
            var shortQuorum = new Array();
            for (int i = 0; i < members.Length; i++)
            {
                var payload = SmartAccountProtocol.Concat("NeoSmartAccount/ThresholdMember"u8.ToArray(), [4], digest,
                    SmartAccountProtocol.UInt64Be(members[i]), SmartAccountProtocol.UInt64Be(1));
                var sig = Neo.Cryptography.Crypto.Sign(SHA256.HashData(payload), keys[i], Neo.Cryptography.HashAlgorithm.SHA256);
                signatures.Add(new Array([new Integer(members[i]), new ByteString(i < threshold ? sig : [])]));
                shortQuorum.Add(new Array([new Integer(members[i]), new ByteString(i < threshold - 1 ? sig : [])]));
            }
            operation[11] = BinarySerializer.Serialize(shortQuorum, 16384, 128);
            using (var refused = Invoke(snapshot, "executeUserOp", [id, operation], MatureAt))
                Assert.AreEqual(VMState.FAULT, refused.State);
            Assert.AreEqual(nonce, Success(snapshot, "getNonce", [id, policyId, new byte[32]]).GetInteger());
            operation[11] = BinarySerializer.Serialize(signatures, 16384, 128);
            Assert.AreEqual("GAS", Success(snapshot, "executeUserOp", [id, operation], MatureAt).GetString());
        }

        [TestMethod]
        [DataRow(false)]
        [DataRow(true)]
        public void DisjointPolicyBatchKeepsTheOtherReceiptAndWait(bool subjectsFirst)
        {
            var snapshot = Snapshot();
            UInt160 id = Register(snapshot), gov = Deploy(snapshot, "GovernanceModule");
            Success(snapshot, "installModule", [id, 1, gov, new object[0]]);
            object[] subjects = [new object[] { 9, new object[] { Custody }, 1 }];
            object[] batch = [BuiltinPolicy()[0], RecoveryPolicy()[0]];
            object[] first = subjectsFirst ? subjects : batch, second = subjectsFirst ? batch : subjects;
            var a = Success(snapshot, "proposeConfiguration", [id, first, new object[0]], target: gov).GetInteger();
            var b = Success(snapshot, "proposeConfiguration", [id, second, new object[0]], 1001, target: gov).GetInteger();
            var original = (Array)Success(snapshot, "getPendingConfiguration", [id, b], target: gov);
            Success(snapshot, "confirmConfiguration", [id, a, first], MatureAt, [Custody, Guardian], target: gov);
            var retained = (Array)Success(snapshot, "getPendingConfiguration", [id, b], MatureAt, target: gov);
            Assert.AreSequenceEqual(original.ToArray(), retained.ToArray());
            using (var early = Invoke(snapshot, "confirmConfiguration", [id, b, second], MatureAt, [Custody, Guardian], target: gov))
                Assert.Contains("SA_INTENT_IMMATURE", early.FaultException!.ToString());
            Success(snapshot, "confirmConfiguration", [id, b, second], MatureAt + 1, [Custody, Guardian], target: gov);
            Assert.AreEqual(new BigInteger(2), ((Array)Success(snapshot, "getMessageSubjects", [id]))[2].GetInteger());
        }

        [TestMethod]
        [DataRow(false)]
        [DataRow(true)]
        public void MessageSignaturesBindScriptIdentityCallerRevisionAndAccountState(bool useSha256)
        {
            var snapshot = Snapshot();
            UInt160 id = Register(snapshot), gov = Deploy(snapshot, "GovernanceModule");
            Success(snapshot, "installModule", [id, 1, gov, new object[0]]);
            var script = Contract.CreateSignatureRedeemScript(CustodyKey.PublicKey);
            byte[] subject = useSha256 ? SHA256.HashData(script) : Custody.ToArray();
            object[] actions = [new object[] { 9, new object[] { subject }, 1 }];
            var intent = Success(snapshot, "proposeConfiguration", [id, actions, new object[0]], target: gov).GetInteger();
            Success(snapshot, "confirmConfiguration", [id, intent, actions], MatureAt, target: gov);
            using var sb = new ScriptBuilder();
            sb.Emit(OpCode.INITSLOT, new byte[] { 0, 3 });
            sb.Emit(OpCode.LDARG2).Emit(OpCode.LDARG1).Emit(OpCode.LDARG0).EmitPush(3).Emit(OpCode.PACK)
                .EmitPush((int)CallFlags.ReadOnly).EmitPush("isValidSignature").EmitPush(NativeContract.SmartAccount.Hash)
                .EmitSysCall(ApplicationEngine.System_Contract_Call).Emit(OpCode.RET);
            var relay = TestUtils.GetContract(sb.ToArray(), TestUtils.CreateManifest("check", ContractParameterType.ByteArray,
                ContractParameterType.Hash160, ContractParameterType.ByteArray, ContractParameterType.Array));
            snapshot.AddContract(relay.Hash, relay);
            byte[] hash = SHA256.HashData("test message"u8.ToArray());
            var account = (Array)Success(snapshot, "getAccount", [id]);
            byte[] preimage = SmartAccountProtocol.Concat("NeoSmartAccount/Message"u8.ToArray(), [4],
                SmartAccountProtocol.UInt32Le(Settings.Network), NativeContract.SmartAccount.Hash.ToArray(), id.ToArray(),
                relay.Hash.ToArray(), SmartAccountProtocol.UInt64Be(0), SmartAccountProtocol.UInt64Be(2),
                SmartAccountProtocol.UInt64Be(account[4].GetInteger()), hash);
            var sig = Neo.Cryptography.Crypto.Sign(SHA256.HashData(preimage), CustodyKey, Neo.Cryptography.HashAlgorithm.SHA256);
            object[] pair = [script, sig];
            string Check(int revision, object[] pairs) => Convert.ToHexString(Success(snapshot, "check",
                [id, hash, new object[] { 4, 0, revision, pairs }], MatureAt, signers: [], target: relay.Hash).GetSpan());
            Assert.AreEqual("1626BA7E", Check(2, [pair]));
            Assert.AreEqual("FFFFFFFF", Check(1, [pair]));
            Assert.AreEqual("FFFFFFFF", Check(2, [pair, pair]));
            Assert.AreEqual("FFFFFFFF", Convert.ToHexString(Success(snapshot, "isValidSignature",
                [id, hash, new object[] { 4, 0, 2, new object[] { pair } }], signers: []).GetSpan()));
            Success(snapshot, "freezeAccount", [id]);
            Assert.AreEqual("FFFFFFFF", Check(2, [pair]));
        }

        [TestMethod]
        public void RemovingGovernancePreservesCommittedMessagePolicyButDiscardsPendingChange()
        {
            var snapshot = Snapshot();
            var id = Register(snapshot);
            var governance = Deploy(snapshot, "GovernanceModule");
            var adapter = Deploy(snapshot, "SigningModule");
            var first = Success(snapshot, "installModule", [id, 1, governance, new object[0]]).GetInteger();
            object[] change = [new object[] { 9, new object[] { Guardian }, 1 }];
            object[] restore = [new object[] { 9, new object[] { Custody }, 1 }];
            var confirmed = Success(snapshot, "proposeConfiguration", [id, change, new object[0]], target: governance).GetInteger();
            Success(snapshot, "confirmConfiguration", [id, confirmed, change], MatureAt, target: governance);
            var pending = Success(snapshot, "proposeConfiguration", [id, restore, new object[0]], MatureAt, target: governance).GetInteger();
            Success(snapshot, "removeModule", [id, first, new object[0]], MatureAt);

            void AssertEffectiveRoster()
            {
                var row = (Array)Success(snapshot, "getMessageSubjects", [id], MatureAt, target: adapter);
                var subjects = (Array)row[0];
                Assert.HasCount(1, subjects);
                Assert.AreSequenceEqual(Guardian.ToArray(), subjects[0].GetSpan().ToArray());
                Assert.AreEqual(BigInteger.One, row[1].GetInteger());
                Assert.AreEqual(new BigInteger(2), row[2].GetInteger());
            }

            AssertEffectiveRoster();
            var next = Success(snapshot, "installModule", [id, 1, governance, new object[0]], MatureAt).GetInteger();
            Assert.IsGreaterThan(first, next);
            var outstanding = (Array)Success(snapshot, "getPendingConfigurationIntentIds", [id], MatureAt, target: governance);
            Assert.IsEmpty(outstanding);
            using var stale = Invoke(snapshot, "confirmConfiguration", [id, pending, restore], 2 * MatureAt, target: governance);
            Assert.AreEqual(VMState.FAULT, stale.State);
            AssertEffectiveRoster();
        }

        [TestMethod]
        [DataRow(true)]
        [DataRow(false)]
        public void CommittedMessageRosterIsModuleOwnedAndCannotBlockRecovery(bool removeBody)
        {
            var snapshot = Snapshot();
            var id = Register(snapshot);
            var seat = ConfigureDelayedRecovery(snapshot, id);
            var governance = Deploy(snapshot, "GovernanceModule");
            Success(snapshot, "installModule", [id, 1, governance, new object[0]]);
            object[] actions = [new object[] { 9, new object[] { Guardian }, 1 }];
            var intent = Success(snapshot, "proposeConfiguration", [id, actions, new object[0]], target: governance).GetInteger();
            Success(snapshot, "confirmConfiguration", [id, intent, actions], MatureAt, target: governance);
            var key = new StorageKey { Id = NativeContract.SmartAccount.Id, Key = SmartAccountProtocol.GetMessageSubjectKey(id) };
            var reference = snapshot[key].Value.ToArray();
            var provider = NativeContract.ContractManagement.GetContract(snapshot, governance)!;
            var bodyKey = new StorageKey { Id = provider.Id, Key = SmartAccountProtocol.Concat([0x04], id.ToArray()) };
            var body = snapshot[bodyKey].Value.ToArray();
            Assert.HasCount(44, reference);
            Assert.AreEqual(provider.Id, System.Buffers.Binary.BinaryPrimitives.ReadInt32BigEndian(reference.AsSpan(8)));
            Assert.AreSequenceEqual(SHA256.HashData(body), reference[12..]);
            using (var direct = Invoke(snapshot, "storeGovernedPolicy", [id, 4, body], target: governance))
                Assert.AreEqual(VMState.FAULT, direct.State);
            if (removeBody) snapshot.Delete(bodyKey);
            else snapshot.GetAndChange(bodyKey)!.Value = new byte[] { 0 };
            using (var unavailable = Invoke(snapshot, "getMessageSubjects", [id]))
                Assert.AreEqual(VMState.FAULT, unavailable.State);
            Success(snapshot, "beginRecovery", [id, UInt160.Zero], MatureAt, [Guardian], target: seat);
            Success(snapshot, "executeRecovery", [id], MatureAt + AccountControl.RecoveryTimelockMinMs, target: seat);
            var restored = (Array)Success(snapshot, "getMessageSubjects", [id]);
            Assert.AreSequenceEqual(Custody.ToArray(), ((Array)restored[0])[0].GetSpan().ToArray());
            Assert.AreEqual(new BigInteger(3), restored[2].GetInteger());
            Assert.HasCount(8, snapshot[key].Value.ToArray());
        }

        [TestMethod]
        public void FrozenAccountRecoversThroughDeployedSeatAfterTimelock()
        {
            var snapshot = Snapshot();
            UInt160 id = Register(snapshot), seat = Deploy(snapshot, "RecoveryModule");
            UInt160 recipient = UInt160.Parse("0x0202020202020202020202020202020202020202");
            UInt160 guardian = UInt160.Parse("0x0303030303030303030303030303030303030303");
            Success(snapshot, "installModule", [id, 5, seat, new object[0]]);
            ulong delay = AccountControl.RecoveryTimelockMinMs;
            Success(snapshot, "setRecoveryPolicy", [id, guardian, new BigInteger(delay), false],
                signers: [Custody, guardian]);
            Success(snapshot, "freezeAccount", [id]);
            var proposal = Success(snapshot, "beginRecovery", [id, recipient], signers: [guardian, recipient], target: seat).GetInteger();
            var config = ((Array)Success(snapshot, "getAccount", [id]))[5].GetInteger();
            using (var replaced = Invoke(snapshot, "cancelReviewedRecovery", [id, proposal + 1, config], signers: [guardian], target: seat))
                Assert.AreEqual(VMState.FAULT, replaced.State);
            using (var early = Invoke(snapshot, "executeRecovery", [id], 1000 + delay - 1, [guardian], target: seat))
                Assert.AreEqual(VMState.FAULT, early.State);
            var payer = UInt160.Parse("0x0404040404040404040404040404040404040404");
            Success(snapshot, "executeReviewedRecovery", [id, proposal, config], 1000 + delay, [payer], target: seat);
            var state = (Array)Success(snapshot, "getAccount", [id]);
            Assert.AreEqual((int)SmartAccountStatus.Active, state[1].GetInteger());
            Assert.AreEqual(recipient, new UInt160(state[2].GetSpan()));
            Assert.AreEqual(UInt160.Zero, new UInt160(state[3].GetSpan()));
        }

        [TestMethod]
        public void RecoveryAuthorityChangeRetiresPendingRequest()
        {
            var snapshot = Snapshot();
            UInt160 id = Register(snapshot), seat = Deploy(snapshot, "RecoveryModule");
            UInt160 oldGuardian = UInt160.Parse("0x0505050505050505050505050505050505050505");
            UInt160 newGuardian = UInt160.Parse("0x0606060606060606060606060606060606060606");
            UInt160 recipient = UInt160.Parse("0x0202020202020202020202020202020202020202");
            ulong delay = AccountControl.RecoveryTimelockMinMs;
            Success(snapshot, "installModule", [id, 5, seat, new object[0]]);
            Success(snapshot, "setRecoveryPolicy",
                [id, oldGuardian, new BigInteger(delay), false], signers: [Custody, oldGuardian]);
            BigInteger proposal = Success(snapshot, "beginRecovery", [id, recipient], 1000,
                [oldGuardian, recipient], target: seat).GetInteger();
            BigInteger oldConfig = ((Array)Success(snapshot, "getAccount", [id]))[5].GetInteger();
            Success(snapshot, "setRecoveryPolicy",
                [id, newGuardian, new BigInteger(delay), false], signers: [Custody, newGuardian]);
            BigInteger newConfig = ((Array)Success(snapshot, "getAccount", [id]))[5].GetInteger();
            Assert.IsTrue(newConfig > oldConfig, "the policy write is a configuration commit");

            using (var stale = Invoke(snapshot, "executeRecovery", [id], 1000 + delay, target: seat))
            {
                Assert.AreEqual(VMState.FAULT, stale.State);
                Assert.Contains("SA_EPOCH_STALE", stale.FaultException!.ToString());
            }
            foreach (BigInteger config in new[] { oldConfig, newConfig })
                using (var reviewed = Invoke(snapshot, "executeReviewedRecovery",
                           [id, proposal, config], 1000 + delay, target: seat))
                    Assert.AreEqual(VMState.FAULT, reviewed.State);

            Success(snapshot, "cancelRecovery", [id], 1000 + delay, [newGuardian], target: seat);
            BigInteger fresh = Success(snapshot, "beginRecovery", [id, recipient], 1000 + delay,
                [newGuardian, recipient], target: seat).GetInteger();
            Assert.IsTrue(fresh > proposal, "a fresh decision gets a fresh nonce");
            Success(snapshot, "executeRecovery", [id], 1000 + delay + delay, target: seat);
            Assert.AreEqual(recipient, new UInt160(((Array)Success(snapshot, "getAccount", [id]))[2].GetSpan()));
        }

        [TestMethod]
        public void RecoveryTimelockChangeRetiresPendingRequest()
        {
            var snapshot = Snapshot();
            UInt160 id = Register(snapshot), seat = Deploy(snapshot, "RecoveryModule");
            UInt160 guardian = UInt160.Parse("0x0505050505050505050505050505050505050505");
            ulong min = AccountControl.RecoveryTimelockMinMs, max = AccountControl.RecoveryTimelockMaxMs;
            Success(snapshot, "installModule", [id, 5, seat, new object[0]]);
            Success(snapshot, "setRecoveryPolicy",
                [id, guardian, new BigInteger(min), false], signers: [Custody, guardian]);
            BigInteger proposal = Success(snapshot, "beginRecovery", [id, UInt160.Zero], 1000,
                [guardian], target: seat).GetInteger();
            BigInteger config = ((Array)Success(snapshot, "getAccount", [id]))[5].GetInteger();
            Success(snapshot, "setRecoveryPolicy", [id, guardian, new BigInteger(max), false], signers: [Custody]);

            using (var stale = Invoke(snapshot, "executeRecovery", [id], 1000 + min, target: seat))
            {
                Assert.AreEqual(VMState.FAULT, stale.State);
                Assert.Contains("SA_EPOCH_STALE", stale.FaultException!.ToString());
            }
            BigInteger newConfig = ((Array)Success(snapshot, "getAccount", [id]))[5].GetInteger();
            using (var reviewed = Invoke(snapshot, "executeReviewedRecovery",
                       [id, proposal, newConfig], 1000 + min, target: seat))
                Assert.AreEqual(VMState.FAULT, reviewed.State);

            Success(snapshot, "beginRecovery", [id, UInt160.Zero], 1000 + min, [guardian], target: seat);
            Success(snapshot, "executeRecovery", [id], 1000 + min + max, target: seat);
            Assert.AreEqual(Custody, new UInt160(((Array)Success(snapshot, "getAccount", [id]))[2].GetSpan()));
        }

        [TestMethod]
        [DataRow(true)]
        [DataRow(false)]
        public void IdempotentPolicyRewriteKeepsPendingRequestButStalesReviewedTransaction(bool reviewed)
        {
            var snapshot = Snapshot();
            UInt160 id = Register(snapshot), seat = Deploy(snapshot, "RecoveryModule");
            UInt160 guardian = UInt160.Parse("0x0505050505050505050505050505050505050505");
            UInt160 recipient = UInt160.Parse("0x0202020202020202020202020202020202020202");
            ulong delay = AccountControl.RecoveryTimelockMinMs;
            Success(snapshot, "installModule", [id, 5, seat, new object[0]]);
            Success(snapshot, "setRecoveryPolicy",
                [id, guardian, new BigInteger(delay), false], signers: [Custody, guardian]);
            BigInteger proposal = Success(snapshot, "beginRecovery", [id, recipient], 1000,
                [guardian, recipient], target: seat).GetInteger();
            BigInteger config = ((Array)Success(snapshot, "getAccount", [id]))[5].GetInteger();
            Success(snapshot, "setRecoveryPolicy",
                [id, guardian, new BigInteger(delay), false], signers: [Custody]);
            BigInteger rewritten = ((Array)Success(snapshot, "getAccount", [id]))[5].GetInteger();
            Assert.IsTrue(rewritten > config, "even an idempotent rewrite is a configuration commit");

            var snapshotFields = (Array)Success(snapshot, "getRecoveryPolicySnapshot", [id], target: seat);
            Assert.AreEqual(guardian, new UInt160(snapshotFields[0].GetSpan()));
            Assert.AreEqual(new BigInteger(delay), snapshotFields[1].GetInteger());

            if (reviewed)
            {
                using var stale = Invoke(snapshot, "executeReviewedRecovery",
                    [id, proposal, config], 1000 + delay, target: seat);
                Assert.AreEqual(VMState.FAULT, stale.State, "the reviewed transaction must be re-reviewed");
                Success(snapshot, "executeReviewedRecovery",
                    [id, proposal, rewritten], 1000 + delay, target: seat);
            }
            else
            {
                Success(snapshot, "executeRecovery", [id], 1000 + delay, target: seat);
            }
            Assert.AreEqual(recipient, new UInt160(((Array)Success(snapshot, "getAccount", [id]))[2].GetSpan()));
        }

        [TestMethod]
        public void GovernedBatchRecoveryPolicyChangeRetiresPendingRequest()
        {
            var snapshot = Snapshot();
            UInt160 id = Register(snapshot), seat = Deploy(snapshot, "RecoveryModule");
            UInt160 oldGuardian = UInt160.Parse("0x0505050505050505050505050505050505050505");
            UInt160 newGuardian = UInt160.Parse("0x0707070707070707070707070707070707070707");
            ulong delay = AccountControl.RecoveryTimelockMinMs;
            Success(snapshot, "installModule", [id, 5, seat, new object[0]]);
            Success(snapshot, "setRecoveryPolicy",
                [id, oldGuardian, new BigInteger(delay), false], signers: [Custody, oldGuardian]);
            Success(snapshot, "beginRecovery", [id, UInt160.Zero], 1000, [oldGuardian], target: seat);
            object[] actions = [new object[] { 8, newGuardian, new BigInteger(delay), false }];
            Success(snapshot, "applyConfigurationActions", [id, actions], signers: [Custody, newGuardian]);

            using (var stale = Invoke(snapshot, "executeRecovery", [id], 1000 + delay, target: seat))
            {
                Assert.AreEqual(VMState.FAULT, stale.State);
                Assert.Contains("SA_EPOCH_STALE", stale.FaultException!.ToString());
            }
        }

        [TestMethod]
        public void GovernanceCanApplyReviewedRecoveryPolicyOnlyAfterMaturityAndRecipientConsent()
        {
            var snapshot = Snapshot();
            UInt160 id = Register(snapshot), governance = Deploy(snapshot, "GovernanceModule");
            Success(snapshot, "installModule", [id, 1, governance, new object[0]]);
            UInt160 incoming = UInt160.Parse("0x0505050505050505050505050505050505050505");
            var actions = new object[] { new object[] { 8, incoming, new BigInteger(AccountControl.RecoveryTimelockMinMs), false } };
            BigInteger intent = Success(snapshot, "proposeConfiguration", [id, actions, new object[0]],
                signers: [Custody], target: governance).GetInteger();
            ulong matureAt = 1000 + (ulong)Success(snapshot, "configurationMaturity", [], target: governance).GetInteger();
            using (var early = Invoke(snapshot, "confirmConfiguration", [id, intent, actions], matureAt - 1,
                [Custody, incoming], target: governance))
                Assert.AreEqual(VMState.FAULT, early.State);
            using (var missing = Invoke(snapshot, "confirmConfiguration", [id, intent, actions], matureAt,
                [Custody], target: governance))
                Assert.AreEqual(VMState.FAULT, missing.State);
            Assert.AreEqual(UInt160.Zero, new UInt160(((Array)Success(snapshot, "getAccount", [id]))[3].GetSpan()));
            Success(snapshot, "confirmConfiguration", [id, intent, actions], matureAt, [Custody, incoming], target: governance);
            Assert.AreEqual(incoming, new UInt160(((Array)Success(snapshot, "getAccount", [id]))[3].GetSpan()));
        }

        private static readonly UInt160 Guardian = UInt160.Parse("0x0505050505050505050505050505050505050505");
        private static object[] BuiltinPolicy() => [new object[] { 5, true, false }];
        private static object[] RecoveryPolicy() =>
            [new object[] { 8, Guardian, new BigInteger(AccountControl.RecoveryTimelockMinMs), false }];
        private const ulong MatureAt = 1000 + 24 * 60 * 60 * 1000;

        [TestMethod]
        [DataRow(false)]
        [DataRow(true)]
        public void DisjointCorePoliciesConfirmInEitherOrderWithoutChangingProposal(bool recoveryFirst)
        {
            var snapshot = Snapshot();
            UInt160 id = Register(snapshot), governance = Deploy(snapshot, "GovernanceModule");
            Success(snapshot, "installModule", [id, 1, governance, new object[0]]);
            object[] first = recoveryFirst ? RecoveryPolicy() : BuiltinPolicy();
            object[] second = recoveryFirst ? BuiltinPolicy() : RecoveryPolicy();
            BigInteger a = Success(snapshot, "proposeConfiguration", [id, first, new object[0]], target: governance).GetInteger();
            BigInteger b = Success(snapshot, "proposeConfiguration", [id, second, new object[0]], 1001, target: governance).GetInteger();
            var original = (Array)Success(snapshot, "getPendingConfiguration", [id, b], target: governance);
            Success(snapshot, "confirmConfiguration", [id, a, first], MatureAt, [Custody, Guardian], target: governance);
            var pending = (Array)Success(snapshot, "getPendingConfiguration", [id, b], MatureAt, target: governance);
            Assert.AreEqual(9, pending.Count);
            for (int i = 0; i < pending.Count; i++) Assert.AreEqual(original[i], pending[i]);
            using (var early = Invoke(snapshot, "confirmConfiguration", [id, b, second], MatureAt, [Custody, Guardian], target: governance))
            {
                Assert.AreEqual(VMState.FAULT, early.State);
                Assert.Contains("SA_INTENT_IMMATURE", early.FaultException!.ToString());
            }
            Success(snapshot, "confirmConfiguration", [id, b, second], MatureAt + 1, [Custody, Guardian], target: governance);
            var state = (Array)Success(snapshot, "getAccount", [id], MatureAt + 1);
            Assert.AreEqual(original[6].GetInteger() + 2, state[5].GetInteger());
            Assert.IsFalse(state[8].GetBoolean());
            Assert.AreEqual(Guardian, new UInt160(state[3].GetSpan()));
            Assert.IsEmpty((Array)Success(snapshot, "getPendingConfigurationIntentIds", [id], target: governance));
        }

        [TestMethod]
        public void OutOfBandConfigurationCannotBeCarriedByALaterGovernanceCommit()
        {
            var snapshot = Snapshot();
            UInt160 id = Register(snapshot), governance = Deploy(snapshot, "GovernanceModule");
            Success(snapshot, "installModule", [id, 1, governance, new object[0]]);
            object[] first = RecoveryPolicy(), second = BuiltinPolicy();
            BigInteger a = Success(snapshot, "proposeConfiguration", [id, first, new object[0]], target: governance).GetInteger();
            Success(snapshot, "setBuiltinAuthorization", [id, true, true]);
            BigInteger b = Success(snapshot, "proposeConfiguration", [id, second, new object[0]], target: governance).GetInteger();
            Success(snapshot, "confirmConfiguration", [id, b, second], MatureAt, target: governance);
            using var stale = Invoke(snapshot, "confirmConfiguration", [id, a, first], MatureAt, [Custody, Guardian], target: governance);
            Assert.AreEqual(VMState.FAULT, stale.State);
            Assert.Contains("SA_EPOCH_STALE", stale.FaultException!.ToString());
            Assert.AreEqual(UInt160.Zero, new UInt160(((Array)Success(snapshot, "getAccount", [id]))[3].GetSpan()));
        }

        [TestMethod]
        public void IndependentConfirmationKeepsOriginalExpiryAndRecipientConsent()
        {
            var snapshot = Snapshot();
            UInt160 id = Register(snapshot), governance = Deploy(snapshot, "GovernanceModule");
            Success(snapshot, "installModule", [id, 1, governance, new object[0]]);
            object[] policy = RecoveryPolicy(), builtin = BuiltinPolicy();
            BigInteger a = Success(snapshot, "proposeConfiguration", [id, policy, new object[0]], target: governance).GetInteger();
            BigInteger b = Success(snapshot, "proposeConfiguration", [id, builtin, new object[0]], target: governance).GetInteger();
            ulong expires = (ulong)((Array)Success(snapshot, "getPendingConfiguration", [id, a], target: governance))[4].GetInteger();
            Success(snapshot, "confirmConfiguration", [id, b, builtin], expires - 1, target: governance);
            using (var missing = Invoke(snapshot, "confirmConfiguration", [id, a, policy], expires, [Custody], target: governance))
            {
                Assert.AreEqual(VMState.FAULT, missing.State);
                Assert.Contains("SA_UNAUTHORIZED", missing.FaultException!.ToString());
            }
            using var expired = Invoke(snapshot, "confirmConfiguration", [id, a, policy], expires + 1, [Custody, Guardian], target: governance);
            Assert.AreEqual(VMState.FAULT, expired.State);
            Assert.Contains("SA_INTENT_EXPIRED", expired.FaultException!.ToString());
            Assert.AreEqual(UInt160.Zero, new UInt160(((Array)Success(snapshot, "getAccount", [id]))[3].GetSpan()));
        }

        [TestMethod]
        public void GovernanceInstallationDoesNotCarryAnIndependentPendingPolicy()
        {
            var snapshot = Snapshot();
            UInt160 id = Register(snapshot), governance = Deploy(snapshot, "GovernanceModule"), hook = Deploy(snapshot, "WhitelistHook");
            Success(snapshot, "installModule", [id, 1, governance, new object[0]]);
            byte[] profile = System.Security.Cryptography.SHA256.HashData(Success(snapshot, "getModuleProfile", [], target: hook).GetSpan());
            object[] install = [new object[] { 1, 4, hook, profile, new object[] { "allowTarget", NativeContract.GAS.Hash } }];
            object[] policy = BuiltinPolicy();
            BigInteger a = Success(snapshot, "proposeConfiguration", [id, policy, new object[0]], target: governance).GetInteger();
            BigInteger b = Success(snapshot, "proposeConfiguration", [id, install, new object[0]], target: governance).GetInteger();
            Success(snapshot, "confirmConfiguration", [id, b, install], MatureAt, target: governance);
            using var stale = Invoke(snapshot, "confirmConfiguration", [id, a, policy], MatureAt, target: governance);
            Assert.AreEqual(VMState.FAULT, stale.State);
            Assert.Contains("SA_EPOCH_STALE", stale.FaultException!.ToString());
        }

        [TestMethod]
        public void DeclaredPolicyDependencyStillConflictsAtProposal()
        {
            var snapshot = Snapshot();
            UInt160 id = Register(snapshot), governance = Deploy(snapshot, "GovernanceModule");
            Success(snapshot, "installModule", [id, 1, governance, new object[0]]);
            Success(snapshot, "proposeConfiguration", [id, RecoveryPolicy(), new object[] { "builtinPolicy" }], target: governance);
            using var conflict = Invoke(snapshot, "proposeConfiguration", [id, BuiltinPolicy(), new object[0]], target: governance);
            Assert.AreEqual(VMState.FAULT, conflict.State);
            Assert.Contains("SA_INTENT_CONFLICT", conflict.FaultException!.ToString());
        }

        [TestMethod]
        public void UnavailableLandingRefusesTheWholeProposalBeforeAllocatingAnId()
        {
            var snapshot = Snapshot();
            UInt160 id = Register(snapshot), governance = Deploy(snapshot, "GovernanceModule");
            Success(snapshot, "installModule", [id, 1, governance, new object[0]]);
            foreach (var (unavailable, expectedError) in new[] {
                (new object[] { 6, 1, new byte[32] }, "SA_PHASE_VIOLATION"),
                (new object[] { 10, new byte[32], "standard" }, "SA_OPERATION_MALFORMED") })
            {
                object[] mixed = [BuiltinPolicy()[0], unavailable];
                using var refused = Invoke(snapshot, "proposeConfiguration", [id, mixed, new object[0]], target: governance);
                Assert.AreEqual(VMState.FAULT, refused.State);
                Assert.Contains(expectedError, refused.FaultException!.ToString());
            }
            Assert.IsEmpty((Array)Success(snapshot, "getPendingConfigurationIntentIds", [id], target: governance));
            Assert.AreEqual(BigInteger.One, Success(snapshot, "proposeConfiguration", [id, BuiltinPolicy(), new object[0]], target: governance).GetInteger());
        }

        [TestMethod]
        [DataRow(false)]
        [DataRow(true)]
        public void OneIntentCommitsBothPoliciesOnceAndFaultRetainsTheOriginalApproval(bool recoveryFirst)
        {
            var snapshot = Snapshot();
            UInt160 id = Register(snapshot), governance = Deploy(snapshot, "GovernanceModule");
            Success(snapshot, "installModule", [id, 1, governance, new object[0]]);
            object[] actions = recoveryFirst ? [RecoveryPolicy()[0], BuiltinPolicy()[0]] : [BuiltinPolicy()[0], RecoveryPolicy()[0]];
            var initial = (Array)Success(snapshot, "getAccount", [id]);
            var intent = Success(snapshot, "proposeConfiguration", [id, actions, new object[0]], target: governance).GetInteger();
            var proposal = (Array)Success(snapshot, "getPendingConfiguration", [id, intent], target: governance);
            using (var early = Invoke(snapshot, "confirmConfiguration", [id, intent, actions], MatureAt - 1, [Custody, Guardian], target: governance))
            {
                Assert.AreEqual(VMState.FAULT, early.State);
                Assert.Contains("SA_INTENT_IMMATURE", early.FaultException!.ToString());
            }
            using (var refused = Invoke(snapshot, "confirmConfiguration", [id, intent, actions], MatureAt, [Custody], target: governance))
            {
                Assert.AreEqual(VMState.FAULT, refused.State);
                Assert.Contains("SA_UNAUTHORIZED", refused.FaultException!.ToString());
            }
            var untouched = (Array)Success(snapshot, "getAccount", [id]);
            for (int i = 0; i < initial.Count; i++) Assert.AreEqual(initial[i], untouched[i]);
            var retained = (Array)Success(snapshot, "getPendingConfiguration", [id, intent], MatureAt, target: governance);
            for (int i = 0; i < proposal.Count; i++) Assert.AreEqual(proposal[i], retained[i]);
            using var completed = Invoke(snapshot, "confirmConfiguration", [id, intent, actions], MatureAt, [Custody, Guardian], target: governance);
            Assert.AreEqual(VMState.HALT, completed.State, completed.FaultException?.ToString());
            var ordered = completed.Notifications.Select(n => n.EventName).ToArray();
            Assert.AreSequenceEqual(recoveryFirst
                ? new string[] { "RecoveryPolicySet", "BuiltinAuthorizationSet", "ConfigurationConfirmed" }
                : new string[] { "BuiltinAuthorizationSet", "RecoveryPolicySet", "ConfigurationConfirmed" }, ordered);
            completed.SnapshotCache.Commit();
            var state = (Array)Success(snapshot, "getAccount", [id], MatureAt);
            Assert.AreEqual(initial[5].GetInteger() + 1, state[5].GetInteger());
            Assert.AreEqual(initial[11].GetInteger() + 1, state[11].GetInteger());
            Assert.AreEqual(Guardian, new UInt160(state[3].GetSpan()));
            Assert.IsFalse(state[8].GetBoolean());
            Assert.IsEmpty((Array)Success(snapshot, "getPendingConfigurationIntentIds", [id], MatureAt, target: governance));
        }

        [TestMethod]
        public void LastRouteIsCheckedAtTheEndOfTheAtomicConfiguration()
        {
            var snapshot = Snapshot();
            UInt160 id = Register(snapshot), governance = Deploy(snapshot, "GovernanceModule");
            var module = Success(snapshot, "installModule", [id, 1, governance, new object[0]]).GetInteger();
            Success(snapshot, "setBuiltinAuthorization", [id, false, true]);
            var before = (Array)Success(snapshot, "getAccount", [id]);
            using (var removal = Invoke(snapshot, "removeModule", [id, module, new object[0]]))
            {
                Assert.AreEqual(VMState.FAULT, removal.State);
                Assert.Contains("SA_BUILTIN_ROUTE_REQUIRED", removal.FaultException!.ToString());
            }
            object[] remove = [2, module, new object[0]];
            using (var invalid = Invoke(snapshot, "applyConfigurationActions", [id, new object[] { remove, new object[] { 5, false, false } }]))
            {
                Assert.AreEqual(VMState.FAULT, invalid.State);
                Assert.Contains("SA_BUILTIN_ROUTE_REQUIRED", invalid.FaultException!.ToString());
            }
            Assert.IsNotEmpty((Array)Success(snapshot, "getModule", [id, module]));
            Success(snapshot, "applyConfigurationActions", [id, new object[] { remove, BuiltinPolicy()[0] }]);
            var final = (Array)Success(snapshot, "getAccount", [id]);
            Assert.IsTrue(final[7].GetBoolean());
            Assert.AreEqual(before[5].GetInteger() + 1, final[5].GetInteger());
            Assert.IsEmpty((Array)Success(snapshot, "getModule", [id, module]));
        }

        [TestMethod]
        public void GovernanceInstallsReviewedHookAndRecoveryPolicyTogether()
        {
            var snapshot = Snapshot();
            UInt160 id = Register(snapshot), governance = Deploy(snapshot, "GovernanceModule"), hook = Deploy(snapshot, "WhitelistHook");
            Success(snapshot, "installModule", [id, 1, governance, new object[0]]);
            byte[] profile = System.Security.Cryptography.SHA256.HashData(Success(snapshot, "getModuleProfile", [], target: hook).GetSpan());
            var prior = (Array)Success(snapshot, "getAccount", [id]);
            object[] actions = [new object[] { 1, 4, hook, profile, new object[] { "allowTarget", NativeContract.GAS.Hash } }, RecoveryPolicy()[0]];
            var intent = Success(snapshot, "proposeConfiguration", [id, actions, new object[0]], target: governance).GetInteger();
            using (var refused = Invoke(snapshot, "confirmConfiguration", [id, intent, actions], MatureAt, [Custody], target: governance))
            {
                Assert.AreEqual(VMState.FAULT, refused.State);
                Assert.Contains("SA_UNAUTHORIZED", refused.FaultException!.ToString());
            }
            var page = (Array)Success(snapshot, "getModules", [id, "hook", 0, 8]);
            Assert.IsEmpty((Array)page[0]);
            Success(snapshot, "confirmConfiguration", [id, intent, actions], MatureAt, [Custody, Guardian], target: governance);
            var state = (Array)Success(snapshot, "getAccount", [id], MatureAt);
            Assert.AreEqual(prior[5].GetInteger() + 1, state[5].GetInteger());
            Assert.AreEqual(Guardian, new UInt160(state[3].GetSpan()));
            var ids = (Array)((Array)Success(snapshot, "getModules", [id, "hook", 0, 8]))[0];
            Assert.HasCount(1, ids);
            Assert.AreEqual(hook, new UInt160(((Array)Success(snapshot, "getModule", [id, ids[0].GetInteger()]))[2].GetSpan()));
        }

        [TestMethod]
        public void ConfigurationBatchChecksItsLimitsAndDoesNotExpandRegistration()
        {
            var snapshot = Snapshot();
            UInt160 id = Register(snapshot);
            object[] actions = Enumerable.Repeat(BuiltinPolicy()[0], 16).ToArray();
            var before = ((Array)Success(snapshot, "getAccount", [id]))[5].GetInteger();
            UInt160 stranger = UInt160.Parse("0x0909090909090909090909090909090909090909");
            using (var denied = Invoke(snapshot, "applyConfigurationActions", [id, actions], signers: [stranger]))
            {
                Assert.AreEqual(VMState.FAULT, denied.State);
                Assert.Contains("SA_UNAUTHORIZED", denied.FaultException!.ToString());
            }
            foreach (object[] invalid in new[] { new object[0], actions.Append(BuiltinPolicy()[0]).ToArray(),
                new object[] { new object[] { 11 } }, new object[] { new object[] { 5, 1, false } } })
            {
                using var denied = Invoke(snapshot, "applyConfigurationActions", [id, invalid]);
                Assert.AreEqual(VMState.FAULT, denied.State);
            }
            Success(snapshot, "applyConfigurationActions", [id, actions]);
            Assert.AreEqual(before + 1, ((Array)Success(snapshot, "getAccount", [id]))[5].GetInteger());
            byte[] salt = Enumerable.Repeat((byte)7, 32).ToArray();
            var other = SmartAccountProtocol.GetAccountId(Custody, salt);
            using var registration = Invoke(snapshot, "createAccount", [other, Custody, salt, 0, BuiltinPolicy()]);
            Assert.AreEqual(VMState.FAULT, registration.State);
        }

        [TestMethod]
        public void ProposalCannotSilentlyReorderCoreWritesAcrossAModuleCallback()
        {
            var snapshot = Snapshot();
            UInt160 id = Register(snapshot), governance = Deploy(snapshot, "GovernanceModule");
            Success(snapshot, "installModule", [id, 1, governance, new object[0]]);
            // Hook-order confirmation still runs outside the native action group.
            object[] ordered = [BuiltinPolicy()[0], new object[] { 4, new object[] { 1 } }, RecoveryPolicy()[0]];
            using var refused = Invoke(snapshot, "proposeConfiguration", [id, ordered, new object[0]], target: governance);
            Assert.AreEqual(VMState.FAULT, refused.State);
            Assert.Contains("separate core action groups", refused.FaultException!.ToString());
            Assert.IsEmpty((Array)Success(snapshot, "getPendingConfigurationIntentIds", [id], target: governance));
        }

        [TestMethod]
        public void GovernanceDoesNotSignOperationsAndInstalledWhitelistGatesCustody()
        {
            var snapshot = Snapshot();
            UInt160 id = Register(snapshot), governance = Deploy(snapshot, "GovernanceModule");
            BigInteger validator = Success(snapshot, "installModule", [id, 1, governance, new object[0]]).GetInteger();
            BigInteger nonce = Success(snapshot, "getNonce", [id, validator, new byte[32]]).GetInteger();
            // The administration module is not an operation signer, even for a valid account query.
            var govOp = Operation(snapshot, id, NativeContract.GAS.Hash, "symbol", [],
                nonce: nonce, validatorId: validator);
            var preview = (Array)Success(snapshot, "validateUserOp", [id, govOp]);
            Assert.IsFalse(preview[0].GetBoolean());
            UInt160 hook = Deploy(snapshot, "WhitelistHook");
            Success(snapshot, "installModule", [id, 4, hook, new object[] { "allowTarget", NativeContract.GAS.Hash }]);
            var accepted = Operation(snapshot, id, NativeContract.GAS.Hash, "symbol", []);
            Assert.AreEqual("GAS", Success(snapshot, "executeUserOp", [id, accepted]).GetString());
            var other = Operation(snapshot, id, NativeContract.NEO.Hash, "symbol", []);
            using var refused = Invoke(snapshot, "executeUserOp", [id, other]);
            Assert.AreEqual(VMState.FAULT, refused.State);
            Assert.Contains("whitelist", refused.FaultException!.ToString().ToLowerInvariant());
        }
    }
}
