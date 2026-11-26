using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo.Persistence;
using Neo.Ledger;
using Neo.Network.P2P;
using Neo.Network.P2P.Payloads;
using Neo.SmartContract;
using Neo.SmartContract.Manifest;
using Neo.SmartContract.Native;
using Neo.UnitTests.Extensions;
using Neo.VM;
using Neo.VM.Types;
using System;
using System.Buffers.Binary;
using System.IO;
using System.Linq;
using System.Numerics;
using System.Security.Cryptography;
using Array = Neo.VM.Types.Array;
using static Neo.UnitTests.SmartContract.Native.UT_SmartAccount;

namespace Neo.UnitTests.SmartContract.Native
{
    /// <summary>
    /// End-to-end behaviour of the standard modules against the v4.1 core:
    /// the closed 26-method IDL, governance-only configuration landings and
    /// module-owned message, threshold, recovery and hook-order policy.
    /// </summary>
    [TestClass]
    public class UT_SmartAccountStandardModules
    {
        private const int Validator = 1, Hook = 4, Recovery = 5;
        private const ulong MaturityMs = 24 * 60 * 60 * 1000;
        private const ulong Timelock = 7UL * 24 * 60 * 60 * 1000;
        private const ulong MaxTimelock = 90UL * 24 * 60 * 60 * 1000;
        private static readonly UInt160 Guardian = UInt160.Parse("0x0505050505050505050505050505050505050505");
        private static readonly UInt160 NewGuardian = UInt160.Parse("0x0606060606060606060606060606060606060606");
        private static readonly UInt160 Incoming = UInt160.Parse("0x0707070707070707070707070707070707070707");
        private static readonly UInt160 Recipient = UInt160.Parse("0x0202020202020202020202020202020202020202");
        private static readonly UInt160 Payer = UInt160.Parse("0x0404040404040404040404040404040404040404");
        private static readonly UInt160 Stranger = UInt160.Parse("0x0909090909090909090909090909090909090909");
        private const string Retired = "doesn't exist in the contract";

        // ---- v4.1 harness ----

        private static ProtocolSettings V41 => Settings;

        private static DataCache Snapshot() => UT_SmartAccount.Snapshot(V41);

        private static ApplicationEngine Invoke(DataCache snapshot, string method, object[] args, ulong time = 1000,
            UInt160[] signers = null, UInt160 target = null) =>
            UT_SmartAccount.Invoke(snapshot, method, args, time, signers, target: target, settings: V41);

        private static StackItem Success(DataCache snapshot, string method, object[] args, ulong time = 1000,
            UInt160[] signers = null, UInt160 target = null) =>
            UT_SmartAccount.Success(snapshot, method, args, time, signers, target: target, settings: V41);

        private static object[] Operation(DataCache snapshot, UInt160 id, UInt160 target, string method, object[] args,
            BigInteger? nonce = null, bool sign = true, BigInteger? validatorId = null, BigInteger? deadline = null) =>
            UT_SmartAccount.Operation(snapshot, id, target, method, args, nonce: nonce, sign: sign,
                validatorId: validatorId, prehashed: true, settings: V41, deadline: deadline);

        private static UInt160 Deploy(DataCache snapshot, string name)
        {
            string prefix = Path.Combine(AppContext.BaseDirectory, "StandardModules", name);
            var contract = (Array)Success(snapshot, "deploy",
                [File.ReadAllBytes(prefix + ".nef"), File.ReadAllBytes(prefix + ".manifest.json"),
                    NativeContract.SmartAccount.Hash], target: NativeContract.ContractManagement.Hash);
            return new UInt160(contract[2].GetSpan());
        }

        /// <summary>Deploys the governance NEF a second time with an altered manifest: the engine answers "Contract Already Exists".</summary>
        private static ApplicationEngine DeployGovernanceWithOtherManifest(DataCache snapshot)
        {
            string prefix = Path.Combine(AppContext.BaseDirectory, "StandardModules", "GovernanceModule");
            var manifest = ContractManifest.Parse(File.ReadAllText(prefix + ".manifest.json"));
            (manifest.Extra ??= new())["Description"] = "test deployment";
            return Invoke(snapshot, "deploy", [File.ReadAllBytes(prefix + ".nef"),
                System.Text.Encoding.UTF8.GetBytes(manifest.ToJson().ToString()), NativeContract.SmartAccount.Hash],
                target: NativeContract.ContractManagement.Hash);
        }

        private static byte[] Profile(DataCache snapshot, UInt160 contract) =>
            SHA256.HashData(Success(snapshot, "getModuleProfile", [], target: contract).GetSpan());

        /// <summary>A registration or governance install action: [1, type, contract, profileDigest, initData].</summary>
        private static object[] Install(DataCache snapshot, UInt160 contract, int type, params object[] initData) =>
            [1, type, contract, Profile(snapshot, contract), initData];

        /// <summary>Registers the account with an install-only initial group (v4.1 creation rule).</summary>
        private static UInt160 Register(DataCache snapshot, object[][] installs)
        {
            UInt160 id = SmartAccountProtocol.GetAccountId(Custody, Salt);
            Success(snapshot, "createAccount", [id, Custody, Salt, installs]);
            return id;
        }

        /// <summary>One reviewed batch out of its action rows.</summary>
        private static object[] Actions(params object[][] rows) => rows;

        private static UInt160 AccountId() => SmartAccountProtocol.GetAccountId(Custody, Salt);

        /// <summary>Every instance id of one contract and type, ascending (ids are allocated in install order).</summary>
        private static BigInteger[] InstancesOf(DataCache snapshot, UInt160 id, string type, UInt160 contract)
        {
            var ids = (Array)((Array)Success(snapshot, "getModules", [id, type, 0, 32]))[0];
            return ids.Select(item => item.GetInteger())
                .Where(moduleId => new UInt160(((Array)Success(snapshot, "getModule", [id, moduleId]))[2].GetSpan()) == contract)
                .ToArray();
        }

        private static BigInteger InstanceOf(DataCache snapshot, UInt160 id, string type, UInt160 contract)
        {
            BigInteger[] found = InstancesOf(snapshot, id, type, contract);
            Assert.HasCount(1, found);
            return found[0];
        }

        private static Array Account(DataCache snapshot, UInt160 id) => (Array)Success(snapshot, "getAccount", [id]);

        private static BigInteger Nonce(DataCache snapshot, UInt160 id, BigInteger validatorId) =>
            Success(snapshot, "getNonce", [id, validatorId, new byte[32]]).GetInteger();

        private static Array Pending(DataCache snapshot, UInt160 id, UInt160 governance) =>
            (Array)Success(snapshot, "getPendingConfigurationIntentIds", [id], target: governance);

        private static StackItem Stack(object value) => value switch
        {
            object[] items => new Array(items.Select(Stack).ToArray()),
            BigInteger number => new Integer(number),
            string text => new ByteString(System.Text.Encoding.UTF8.GetBytes(text)),
            byte[] bytes => new ByteString(bytes),
            bool flag => flag ? StackItem.True : StackItem.False,
            UInt160 hash => new ByteString(hash.GetSpan().ToArray()),
            null => StackItem.Null,
            _ => throw new ArgumentException(value.GetType().Name),
        };

        private static void Refused(ApplicationEngine engine, string symbol)
        {
            Assert.AreEqual(VMState.FAULT, engine.State);
            Assert.Contains(symbol, engine.FaultException!.ToString());
        }

        /// <summary>The signature witness of the fee payer wallet over the transaction as it stands.</summary>
        private static void SignPayer(Transaction tx)
        {
            tx.Witnesses[0] = new Witness
            {
                InvocationScript = new ScriptBuilder().EmitPush(Neo.Cryptography.Crypto.Sign(tx.GetSignData(V41.Network), CustodyKey,
                    Neo.Cryptography.HashAlgorithm.SHA256)).ToArray(),
                VerificationScript = Contract.CreateSignatureRedeemScript(CustodyKey.PublicKey).ToArray(),
            };
        }

        /// <summary>
        /// The read-only preview never faults for a rejected operation: it answers
        /// <c>[false, operationDigest]</c> and leaves every nonce untouched.
        /// The rejection reason itself is only visible on the execution entry.
        /// </summary>
        private static void Rejected(ApplicationEngine engine)
        {
            Assert.AreEqual(VMState.HALT, engine.State, engine.FaultException?.ToString());
            var preview = (Array)engine.ResultStack.Peek();
            Assert.HasCount(2, preview);
            Assert.IsFalse(preview[0].GetBoolean());
            Assert.HasCount(32, preview[1].GetSpan().ToArray());
        }

        /// <summary>Asserts that a method is not part of the closed 26-method v4.1 ABI.</summary>
        private static void RetiredEntry(ApplicationEngine engine)
        {
            Assert.AreEqual(VMState.FAULT, engine.State);
            Assert.Contains(Retired, engine.FaultException!.GetBaseException().Message);
        }

        private static BigInteger Propose(DataCache snapshot, UInt160 id, UInt160 governance, object[] actions, ulong now) =>
            Success(snapshot, "proposeConfiguration", [id, actions, new object[0]], now, target: governance).GetInteger();

        private static ApplicationEngine Confirm(DataCache snapshot, UInt160 id, UInt160 governance,
            BigInteger intent, object[] actions, ulong time, UInt160[] signers = null) =>
            Invoke(snapshot, "confirmConfiguration", [id, intent, actions], time, signers, target: governance);

        /// <summary>Proposes at <paramref name="now"/> and confirms at maturity; the clock moves to the landing.</summary>
        private static BigInteger Land(DataCache snapshot, UInt160 id, UInt160 governance, object[] actions, ref ulong now)
        {
            BigInteger intent = Propose(snapshot, id, governance, actions, now);
            now += MaturityMs;
            using var landed = Confirm(snapshot, id, governance, intent, actions, now);
            Assert.AreEqual(VMState.HALT, landed.State, landed.FaultException?.ToString());
            landed.SnapshotCache.Commit();
            return intent;
        }

        private static void Cancel(DataCache snapshot, UInt160 id, UInt160 governance, BigInteger intent, ulong now,
            UInt160[] signers = null) =>
            Success(snapshot, "cancelConfiguration", [id, intent], now, signers, target: governance);

        // ---- action shapes ----

        private static object[] Configure(BigInteger moduleId, params object[] data) => [3, moduleId, data];
        private static object[] Builtin(bool operation, bool message) => [5, operation, message];
        private static object[] RecoveryData(UInt160[] guardians, ulong timelock) =>
            [guardians.Cast<object>().ToArray(), BigInteger.One, (BigInteger)timelock];
        private static object[] RecoveryData(UInt160[] guardians, ulong timelock, UInt160 authority, BigInteger threshold) =>
            [guardians.Cast<object>().ToArray(), threshold, (BigInteger)timelock, authority];

        /// <summary>Two read-only views of one record carry the same values in every position.</summary>
        private static void AssertSameAccount(Array expected, Array actual)
        {
            Assert.AreEqual(expected.Count, actual.Count);
            for (int i = 0; i < expected.Count; i++)
                Assert.AreEqual(expected[i].ToString(), actual[i].ToString(), $"field {i}");
        }

        /// <summary>
        /// A member approval over <c>D_i = SHA256(memberPreimage)</c>. The platform
        /// hashes the preimage once inside <c>verifyWithECDsa</c>, so the member
        /// signs the already-hashed digest prehashed (SignHash), exactly as the
        /// v4.1 gate verifies it; signing <c>SHA256(D_i)</c> would be a double hash.
        /// </summary>
        private static byte[] MemberSignature(BigInteger member, byte[] operationDigest, Neo.Wallets.KeyPair key) =>
            SignPrehashed(key, SHA256.HashData([
                .. "NeoSmartAccount/ThresholdMember"u8, 4, .. operationDigest,
                .. UInt64Be(member), .. UInt64Be(1)]));

        private static byte[] UInt64Be(BigInteger value) =>
            SmartAccountModuleProtocol.UInt64ToBigEndian(SmartAccountProtocol.UInt64(value));

        private static byte[] UInt32Le(uint value)
        {
            byte[] bytes = new byte[4];
            BinaryPrimitives.WriteUInt32LittleEndian(bytes, value);
            return bytes;
        }

        /// <summary>The adapter's module row: <c>0x01 ‖ accountId(20) ‖ UInt64BE(instanceId)</c>.</summary>
        private static byte[] ModuleRowKey(UInt160 accountId, BigInteger instanceId) =>
            [1, .. accountId.GetSpan(), .. UInt64Be(instanceId)];

        /// <summary>The serialized member signature list: strictly ascending [memberId, signature] pairs.</summary>
        private static byte[] MemberEntries(params (BigInteger Member, byte[] Signature)[] rows)
        {
            var entries = new Array();
            foreach (var (member, signature) in rows)
                entries.Add(new Array([new Integer(member), new ByteString(signature)]));
            return BinarySerializer.Serialize(entries, 16384, 128);
        }

        private static Neo.Wallets.KeyPair Key(byte fill) => new(Enumerable.Repeat(fill, 32).ToArray());

        // ------------------------------------------------------------------
        // Governance landings and module configuration
        // ------------------------------------------------------------------

        [TestMethod]
        [DataRow(false)]
        [DataRow(true)]
        public void ReviewedModuleConfigurationUsesCorePhaseAndRollsBackOnFault(bool badTail)
        {
            var snapshot = Snapshot();
            UInt160 governance = Deploy(snapshot, "GovernanceModule"), hookContract = Deploy(snapshot, "WhitelistHook");
            UInt160 id = Register(snapshot, [Install(snapshot, governance, Validator), Install(snapshot, hookContract, Hook)]);
            BigInteger hook = InstanceOf(snapshot, id, "hook", hookContract);
            object[] row = Configure(hook, "allowTarget", NativeContract.GAS.Hash);
            object[] actions = badTail ? [row, Configure(hook, "unknown")] : [row];
            bool Allowed() => Success(snapshot, "isWhitelisted", [id, hook, NativeContract.GAS.Hash], target: hookContract).GetBoolean();
            BigInteger nonce = Account(snapshot, id)[4].GetInteger();

            Assert.IsFalse(Allowed());
            using (var direct = Invoke(snapshot, "applyConfigurationActions", [id, actions])) Refused(direct, "SA_UNAUTHORIZED");
            using (var stranger = Invoke(snapshot, "applyConfigurationActions", [id, actions], signers: [Stranger]))
                Refused(stranger, "SA_UNAUTHORIZED");
            using (var directConfigure = Invoke(snapshot, "configureModule", [id, hook, new object[] { "allowTarget", NativeContract.GAS.Hash }]))
                Refused(directConfigure, "SA_UNAUTHORIZED");
            BigInteger intent = Propose(snapshot, id, governance, actions, 1000);
            using (var early = Confirm(snapshot, id, governance, intent, actions, 1000 + MaturityMs - 1))
                Refused(early, "SA_INTENT_IMMATURE");
            Assert.IsFalse(Allowed());

            if (badTail)
            {
                using var denied = Confirm(snapshot, id, governance, intent, actions, 1000 + MaturityMs);
                Refused(denied, "Unknown config command");
                Assert.IsFalse(Allowed());
                Assert.AreEqual(nonce, Account(snapshot, id)[4].GetInteger(), "a fault rolls the whole landing back");
                Assert.HasCount(1, Pending(snapshot, id, governance), "the intent stays reviewable");
                Assert.IsFalse(Emitted(denied, governance, "ConfigurationConfirmed"));
            }
            else
            {
                Success(snapshot, "confirmConfiguration", [id, intent, actions], 1000 + MaturityMs, target: governance);
                Assert.IsTrue(Allowed());
                Assert.AreEqual(nonce + 1, Account(snapshot, id)[4].GetInteger());
                Assert.IsEmpty(Pending(snapshot, id, governance));
            }
        }

        private static bool Emitted(ApplicationEngine engine, UInt160 contract, string name) =>
            engine.Notifications.Any(n => n.ScriptHash == contract && n.EventName == name);

        [TestMethod]
        public void MessageSubjectsCommitExactScriptIdentitiesOnlyAfterMaturity()
        {
            var snapshot = Snapshot();
            UInt160 governance = Deploy(snapshot, "GovernanceModule"), signing = Deploy(snapshot, "SigningModule");
            UInt160 id = Register(snapshot, [Install(snapshot, governance, Validator), Install(snapshot, signing, Validator)]);
            BigInteger signingId = InstanceOf(snapshot, id, "validator", signing);
            byte[] subject = SHA256.HashData(Contract.CreateSignatureRedeemScript(CustodyKey.PublicKey).ToArray());
            object[] subjects = [subject];
            object[] actions = [Configure(signingId, subjects, 1)];
            Assert.IsEmpty((Array)Success(snapshot, "getMessagePolicy", [id, signingId], target: signing));

            using (var direct = Invoke(snapshot, "applyConfigurationActions", [id, actions])) Refused(direct, "SA_UNAUTHORIZED");
            using (var directConfigure = Invoke(snapshot, "configureModule", [id, signingId, new object[] { subjects, 1 }]))
                Refused(directConfigure, "SA_UNAUTHORIZED");
            using (var obsolete = Invoke(snapshot, "updateMessageSubject", [id, subjects, 1], target: signing))
                RetiredEntry(obsolete);
            using (var nativeRoster = Invoke(snapshot, "getMessageSubjects", [id])) RetiredEntry(nativeRoster);
            using (var seeded = Invoke(snapshot, "installModule", [id, 1, signing, new object[] { subjects, 1 }]))
                Refused(seeded, "SA_UNAUTHORIZED");

            BigInteger intent = Propose(snapshot, id, governance, actions, 1000);
            using (var early = Confirm(snapshot, id, governance, intent, actions, 1000 + MaturityMs - 1))
                Refused(early, "SA_INTENT_IMMATURE");
            object[] altered = [Configure(signingId, new object[] { Custody }, 1)];
            using (var replaced = Confirm(snapshot, id, governance, intent, altered, 1000 + MaturityMs))
                Refused(replaced, "SA_OPERATION_MALFORMED");
            Assert.IsEmpty((Array)Success(snapshot, "getMessagePolicy", [id, signingId], target: signing));

            Success(snapshot, "confirmConfiguration", [id, intent, actions], 1000 + MaturityMs, target: governance);
            var policy = (Array)Success(snapshot, "getMessagePolicy", [id, signingId], target: signing);
            Assert.AreSequenceEqual(subject, ((Array)policy[0])[0].GetSpan().ToArray());
            Assert.AreEqual(BigInteger.One, policy[1].GetInteger());
            Assert.AreEqual(BigInteger.One, policy[2].GetInteger());
            Assert.AreEqual(BigInteger.One, policy[3].GetInteger());
            using var replay = Confirm(snapshot, id, governance, intent, actions, 1000 + MaturityMs);
            Refused(replay, "SA_INTENT_NOT_FOUND");

            // A second instance may only be installed with empty data: the roster
            // is a reviewed configure, never an installation argument.
            BigInteger nonce = Account(snapshot, id)[4].GetInteger();
            object[] second = [Install(snapshot, signing, Validator, subjects, 1)];
            BigInteger seededIntent = Propose(snapshot, id, governance, second, 1000 + MaturityMs);
            using var refused = Confirm(snapshot, id, governance, seededIntent, second, 1000 + 2 * MaturityMs);
            Refused(refused, "SA_OPERATION_MALFORMED");
            Assert.HasCount(2, (Array)((Array)Success(snapshot, "getModules", [id, "validator", 0, 32]))[0]);
            Assert.AreEqual(nonce, Account(snapshot, id)[4].GetInteger());
        }

        [TestMethod]
        public void DelegatedMessageSignerCannotSpendAndDoesNotChangeTheCustodyChannel()
        {
            var snapshot = Snapshot();
            UInt160 governance = Deploy(snapshot, "GovernanceModule"), signing = Deploy(snapshot, "SigningModule");
            UInt160 id = Register(snapshot, [Install(snapshot, governance, Validator), Install(snapshot, signing, Validator)]);
            BigInteger signingId = InstanceOf(snapshot, id, "validator", signing);
            var key = Key(0x22);
            byte[] script = Contract.CreateSignatureRedeemScript(key.PublicKey).ToArray();
            ulong now = 1000;
            Land(snapshot, id, governance, [Configure(signingId, new object[] { SHA256.HashData(script) }, 1)], ref now);
            BigInteger nonce = Nonce(snapshot, id, 0);

            var operation = Operation(snapshot, id, NativeContract.GAS.Hash, "symbol", []);
            object correct = operation[11];
            byte[] digest = Success(snapshot, "getOperationDigest", [id, operation]).GetSpan().ToArray();
            byte[] signature = UT_SmartAccount.SignPrehashed(key, digest);
            operation[11] = BinarySerializer.Serialize(new Array([new Integer(4), new Integer(0), new Integer(1),
                new Array([new Array([new ByteString(script), new ByteString(signature)])])]), 8192, 8);
            using (var preview = Invoke(snapshot, "validateUserOp", [id, operation], now)) Rejected(preview);
            using (var refused = Invoke(snapshot, "executeUserOp", [id, operation], now)) Refused(refused, "SA_VALIDATION_REJECTED");
            Assert.AreEqual(nonce, Nonce(snapshot, id, 0));

            operation[11] = correct;
            Assert.AreEqual("GAS", Success(snapshot, "executeUserOp", [id, operation], now).GetString());
        }

        [TestMethod]
        public void GovernanceCodeIsOneIdentityAndAnAccountWithoutTheSeatHasNoGovernanceRoute()
        {
            var snapshot = Snapshot();
            UInt160 governance = Deploy(snapshot, "GovernanceModule"), hookContract = Deploy(snapshot, "WhitelistHook");
            // A contract's identity is its script: the same governance code under an
            // altered manifest is not a second contract an account could bind.
            using (var again = DeployGovernanceWithOtherManifest(snapshot))
            {
                Assert.AreEqual(VMState.FAULT, again.State);
                Assert.Contains("Contract Already Exists", again.FaultException!.ToString());
            }

            // The account carries a hook but no governance instance: every
            // governance entry is refused before an intent id exists, and the
            // native installation entries stay closed to custody.
            UInt160 id = Register(snapshot, [Install(snapshot, hookContract, Hook)]);
            Assert.IsEmpty((Array)((Array)Success(snapshot, "getModules", [id, "validator", 0, 32]))[0]);
            object[] actions = [Builtin(true, false)];
            using (var unbound = Invoke(snapshot, "proposeConfiguration", [id, actions, new object[0]], target: governance))
                Refused(unbound, "SA_MODULE_NOT_INSTALLED");
            using (var unboundConfirm = Invoke(snapshot, "confirmConfiguration", [id, 1, actions], target: governance))
                Refused(unboundConfirm, "SA_MODULE_NOT_INSTALLED");
            Assert.IsEmpty(Pending(snapshot, id, governance));
            using (var direct = Invoke(snapshot, "installModule", [id, Validator, governance, new object[0]])) Refused(direct, "SA_UNAUTHORIZED");
            Assert.IsEmpty((Array)((Array)Success(snapshot, "getModules", [id, "validator", 0, 32]))[0]);
        }

        // ------------------------------------------------------------------
        // Threshold policy
        // ------------------------------------------------------------------

        /// <summary>Governance, the threshold adapter and <paramref name="members"/> fresh member validators.</summary>
        private static (UInt160 Governance, UInt160 Adapter, BigInteger AdapterId, BigInteger[] Members) ThresholdAccount(
            DataCache snapshot, int members)
        {
            UInt160 governance = Deploy(snapshot, "GovernanceModule"), adapter = Deploy(snapshot, "ThresholdPolicyModule"),
                member = Deploy(snapshot, "MultiSigValidator");
            var group = new System.Collections.Generic.List<object[]> { Install(snapshot, governance, Validator), Install(snapshot, adapter, Validator) };
            for (int i = 0; i < members; i++) group.Add(Install(snapshot, member, Validator, "setMemberKey", Key((byte)(i + 1)).PublicKey.EncodePoint(true)));
            UInt160 id = Register(snapshot, group.ToArray());
            return (governance, adapter, InstanceOf(snapshot, id, "validator", adapter), InstancesOf(snapshot, id, "validator", member));
        }

        private static object[] ThresholdData(BigInteger threshold, BigInteger[] members, bool active = true) =>
            [threshold, members.Cast<object>().ToArray(), members.Select(_ => (object)BigInteger.One).ToArray(), active];

        [TestMethod]
        public void ThresholdPolicyIsModuleOwnedAndTheRequiredPinRoutesEveryOperation()
        {
            var snapshot = Snapshot();
            var (governance, adapter, adapterId, members) = ThresholdAccount(snapshot, 2);
            UInt160 id = AccountId();
            BigInteger m = members[0], n = members[1];
            ulong now = 1000;
            object[] policy = [Configure(adapterId, ThresholdData(2, members))];
            Assert.IsEmpty((Array)Success(snapshot, "getThresholdPolicy", [id, adapterId], target: adapter));

            using (var direct = Invoke(snapshot, "applyConfigurationActions", [id, policy])) Refused(direct, "SA_UNAUTHORIZED");
            using (var directConfigure = Invoke(snapshot, "configureModule", [id, adapterId, ThresholdData(2, members)]))
                Refused(directConfigure, "SA_UNAUTHORIZED");
            using (var retired = Invoke(snapshot, "setThresholdPolicy", [id, 1, new object[] { m }], target: adapter)) RetiredEntry(retired);
            Land(snapshot, id, governance, policy, ref now);

            var stored = (Array)Success(snapshot, "getThresholdPolicy", [id, adapterId], target: adapter);
            Assert.AreEqual((BigInteger)2, stored[0].GetInteger());
            Assert.AreSequenceEqual(members, ((Array)stored[1]).Select(x => x.GetInteger()));
            Assert.AreSequenceEqual(new[] { BigInteger.One, BigInteger.One }, ((Array)stored[2]).Select(x => x.GetInteger()));
            Assert.AreEqual(BigInteger.One, stored[3].GetInteger());
            Assert.IsTrue(stored[4].GetBoolean());
            Assert.AreEqual(BigInteger.One, stored[5].GetInteger());

            using (var removal = Invoke(snapshot, "removeModule", [id, m, new object[0]])) Refused(removal, "SA_UNAUTHORIZED");

            // A leaf member is never a spending route of its own.
            var directMember = Operation(snapshot, id, NativeContract.GAS.Hash, "symbol", [], nonce: Nonce(snapshot, id, m), sign: false, validatorId: m);
            using (var memberRoute = Invoke(snapshot, "executeUserOp", [id, directMember], now)) Refused(memberRoute, "SA_VALIDATION_REJECTED");

            // The module row owns the quorum: two members, both approvals. A
            // listed member without a usable entry approves nothing.
            BigInteger nonce = Nonce(snapshot, id, adapterId);
            var operation = Operation(snapshot, id, NativeContract.GAS.Hash, "symbol", [], nonce: nonce, sign: false, validatorId: adapterId);
            byte[] digest = Success(snapshot, "getOperationDigest", [id, operation]).GetSpan().ToArray();
            byte[] byM = MemberSignature(m, digest, Key(1)), byN = MemberSignature(n, digest, Key(2));
            foreach (var (entries, symbol) in new[]
            {
                (MemberEntries((m, byM)), "SA_VALIDATION_REJECTED"),
                (MemberEntries((m, System.Array.Empty<byte>()), (n, byN)), "SA_VALIDATION_REJECTED"),
                // A member entry approves its own member only.
                (MemberEntries((m, byN), (n, byM)), "SA_VALIDATION_REJECTED"),
                (MemberEntries((n, byN), (m, byM)), "Member signatures not strictly ascending"),
                (MemberEntries((m, byM), (m, byM)), "Member signatures not strictly ascending"),
                (MemberEntries((m, new byte[8])), "SA_VALIDATION_REJECTED"),
            })
            {
                operation[11] = entries;
                using var invalid = Invoke(snapshot, "executeUserOp", [id, operation], now);
                Refused(invalid, symbol);
                Assert.AreEqual(nonce, Nonce(snapshot, id, adapterId));
            }

            operation[11] = MemberEntries((m, byM), (n, byN));
            var preview = (Array)Success(snapshot, "validateUserOp", [id, operation], now);
            Assert.IsTrue(preview[0].GetBoolean());
            Assert.AreSequenceEqual(digest, preview[1].GetSpan().ToArray());
            Assert.AreEqual(nonce, Nonce(snapshot, id, adapterId), "the preview consumes nothing");
            Assert.AreEqual("GAS", Success(snapshot, "executeUserOp", [id, operation], now).GetString());
            Assert.AreEqual(nonce + 1, Nonce(snapshot, id, adapterId));

            // The required-validator pin is a governance action; once pinned,
            // the built-in route is closed for everyone, including custody.
            Land(snapshot, id, governance, Actions([7, adapterId, true]), ref now);
            Assert.AreEqual(adapterId, Account(snapshot, id)[7].GetInteger());
            var custodyOp = Operation(snapshot, id, NativeContract.GAS.Hash, "symbol", []);
            using (var closed = Invoke(snapshot, "executeUserOp", [id, custodyOp], now)) Refused(closed, "SA_MODULE_NOT_ROUTABLE");
            // An operation is reviewed under the configuration nonce it names:
            // one written before the pin is stale and never reaches a route.
            using (var reviewedEarlier = Invoke(snapshot, "executeUserOp", [id, directMember], now))
                Refused(reviewedEarlier, "SA_CONFIGURATION_NONCE_STALE");
            directMember = Operation(snapshot, id, NativeContract.GAS.Hash, "symbol", [], nonce: Nonce(snapshot, id, m), sign: false, validatorId: m);
            using (var rerouted = Invoke(snapshot, "executeUserOp", [id, directMember], now)) Refused(rerouted, "SA_MODULE_NOT_ROUTABLE");
            using (var memberDeclined = Invoke(snapshot, "validateUserOp", [id, directMember], now)) Rejected(memberDeclined);
            using (var declined = Invoke(snapshot, "validateUserOp", [id, custodyOp], now)) Rejected(declined);
            var adapterOp = Operation(snapshot, id, NativeContract.GAS.Hash, "symbol", [], nonce: Nonce(snapshot, id, adapterId), sign: false, validatorId: adapterId);
            // A valid member entry is bound to the digest it was made for: carried
            // to the next operation of the same channel it approves nothing.
            adapterOp[11] = MemberEntries((m, byM));
            using (var replayed = Invoke(snapshot, "executeUserOp", [id, adapterOp], now))
                Refused(replayed, "SA_VALIDATION_REJECTED");

            // The quorum lives in the module row only: without it the adapter
            // fails closed and reports a bare instance.
            var row = new StorageKey
            {
                Id = NativeContract.ContractManagement.GetContract(snapshot, adapter)!.Id,
                Key = ModuleRowKey(id, adapterId),
            };
            Assert.IsGreaterThan(0, snapshot[row].Value.Length);
            snapshot.Delete(row);
            Assert.IsEmpty((Array)Success(snapshot, "getThresholdPolicy", [id, adapterId], target: adapter));
            Assert.AreEqual(adapterId, ((Array)Success(snapshot, "getPolicySnapshot", [id], target: adapter))[0].GetInteger());
            Assert.HasCount(1, (Array)Success(snapshot, "getPolicySnapshot", [id], target: adapter));
            // Two valid approvals over this exact operation: only the missing
            // module row makes the adapter fail closed.
            adapterOp = Operation(snapshot, id, NativeContract.GAS.Hash, "symbol", [], nonce: Nonce(snapshot, id, adapterId), sign: false, validatorId: adapterId);
            byte[] replayDigest = Success(snapshot, "getOperationDigest", [id, adapterOp]).GetSpan().ToArray();
            adapterOp[11] = MemberEntries((m, MemberSignature(m, replayDigest, Key(1))), (n, MemberSignature(n, replayDigest, Key(2))));
            using (var failClosed = Invoke(snapshot, "executeUserOp", [id, adapterOp], now)) Refused(failClosed, "SA_VALIDATION_REJECTED");
            using (var reopen = Invoke(snapshot, "setBuiltinAuthorization", [id, true, true])) Refused(reopen, "SA_UNAUTHORIZED");
            using (var retired = Invoke(snapshot, "setRecoveryPolicy", [id, Guardian, new BigInteger(Timelock), false])) RetiredEntry(retired);

            // Credential revocation is the one immediate custody path.
            Success(snapshot, "revokeModuleCredentials", [id, adapterId], now);
            Assert.AreEqual((BigInteger)2, ((Array)Success(snapshot, "getModule", [id, adapterId]))[8].GetInteger());
            using (var stranger = Invoke(snapshot, "revokeModuleCredentials", [id, adapterId], now, signers: [Stranger]))
                Refused(stranger, "SA_UNAUTHORIZED");
            Success(snapshot, "freezeAccount", [id], now);
            Assert.AreEqual((BigInteger)(int)SmartAccountStatus.Frozen, Account(snapshot, id)[1].GetInteger());
        }

        [TestMethod]
        [DataRow(false)]
        [DataRow(true)]
        public void ThresholdEnrollmentRequiresDistinctEligibleMembers(bool withRecoverySeat)
        {
            var snapshot = Snapshot();
            var (governance, adapter, adapterId, members) = ThresholdAccount(snapshot, 2);
            UInt160 id = AccountId();
            ulong now = 1000;
            if (withRecoverySeat)
            {
                UInt160 seat = Deploy(snapshot, "RecoveryModule");
                Land(snapshot, id, governance, [Install(snapshot, seat, Recovery)], ref now);
            }
            BigInteger m = members[0], n = members[1], governanceId = InstanceOf(snapshot, id, "validator", governance);
            foreach (var (data, symbol) in new[]
            {
                (ThresholdData(1, [m, m]), "SA_OPERATION_MALFORMED"),
                (ThresholdData(1, [governanceId, n]), "SA_OPERATION_MALFORMED"),
                (ThresholdData(1, [99]), "SA_MODULE_NOT_INSTALLED"),
                (ThresholdData(1, [adapterId]), "SA_OPERATION_MALFORMED"),
                (ThresholdData(2, [m]), "SA_MODULE_LIMIT_THRESHOLD"),
            })
            {
                object[] actions = [Configure(adapterId, data)];
                BigInteger intent = Propose(snapshot, id, governance, actions, now);
                using var refused = Confirm(snapshot, id, governance, intent, actions, now + MaturityMs);
                Refused(refused, symbol);
                Assert.IsEmpty((Array)Success(snapshot, "getThresholdPolicy", [id, adapterId], target: adapter));
                Assert.HasCount(1, Pending(snapshot, id, governance));
                Cancel(snapshot, id, governance, intent, now + MaturityMs);
                now += MaturityMs;
            }

            Land(snapshot, id, governance, [Configure(adapterId, ThresholdData(2, members))], ref now);
            Assert.AreEqual((BigInteger)2, ((Array)Success(snapshot, "getThresholdPolicy", [id, adapterId], target: adapter))[0].GetInteger());
            Assert.IsTrue(Account(snapshot, id)[5].GetBoolean(), "a module policy never disables the built-in route by itself");
        }

        [TestMethod]
        [DataRow(5, 5)]
        [DataRow(2, 3)]
        [DataRow(2, 6)]
        [DataRow(4, 4)]
        // The protocol's largest rosters verify as well (composite frame §11).
        [DataRow(6, 6)]
        [DataRow(10, 10)]
        public void ThresholdSpendingEnforcesTheChosenQuorum(int threshold, int memberCount)
        {
            var snapshot = Snapshot();
            var (governance, adapter, adapterId, members) = ThresholdAccount(snapshot, memberCount);
            UInt160 id = AccountId();
            ulong now = 1000;
            Land(snapshot, id, governance, [Configure(adapterId, ThresholdData(threshold, members))], ref now);
            BigInteger nonce = Nonce(snapshot, id, adapterId);
            var operation = Operation(snapshot, id, NativeContract.GAS.Hash, "symbol", [], nonce: nonce, sign: false, validatorId: adapterId);
            byte[] digest = Success(snapshot, "getOperationDigest", [id, operation]).GetSpan().ToArray();
            var full = new System.Collections.Generic.List<(BigInteger, byte[])>();
            var shortQuorum = new System.Collections.Generic.List<(BigInteger, byte[])>();
            for (int i = 0; i < members.Length; i++)
            {
                byte[] signature = MemberSignature(members[i], digest, Key((byte)(i + 1)));
                full.Add((members[i], i < threshold ? signature : System.Array.Empty<byte>()));
                shortQuorum.Add((members[i], i < threshold - 1 ? signature : System.Array.Empty<byte>()));
            }

            operation[11] = MemberEntries(shortQuorum.ToArray());
            using (var refused = Invoke(snapshot, "executeUserOp", [id, operation], now)) Refused(refused, "SA_VALIDATION_REJECTED");
            Assert.AreEqual(nonce, Nonce(snapshot, id, adapterId));
            operation[11] = MemberEntries(full.ToArray());
            Assert.AreEqual("GAS", Success(snapshot, "executeUserOp", [id, operation], now).GetString());
            Assert.AreEqual(nonce + 1, Nonce(snapshot, id, adapterId));
        }

        /// <summary>
        /// v4.1 verifies a composite quorum through one nested member callback per
        /// roster entry, all paid from the declared system fee of the transaction
        /// and the execution frame of the routed adapter: a roster is decided by
        /// its quorum alone. The proxy witness admits every legal roster under the
        /// platform's default verification cap, the public validation entry
        /// answers [true, digest] or [false, digest] and never faults, a short
        /// quorum is a plain rejection on the execution entry as well, and
        /// nothing moves.
        /// </summary>
        [TestMethod]
        [DataRow(1, 1, 1)]
        [DataRow(3, 2, 2)]
        [DataRow(3, 2, 1)]
        [DataRow(10, 10, 10)]
        [DataRow(10, 10, 5)]
        [DataRow(10, 10, 0)]
        [DataRow(7, 4, 4)]
        [DataRow(6, 5, 5)]
        [DataRow(7, 7, 7)]
        public void AFullCompositeRosterIsDecidedByItsQuorum(int roster, int threshold, int verified)
        {
            var snapshot = Snapshot();
            var (governance, adapter, adapterId, members) = ThresholdAccount(snapshot, roster);
            UInt160 id = AccountId();
            ulong now = 1000;
            Land(snapshot, id, governance, [Configure(adapterId, ThresholdData(threshold, members))], ref now);
            var policy = (Array)Success(snapshot, "getThresholdPolicy", [id, adapterId], target: adapter);
            Assert.AreEqual((BigInteger)threshold, policy[0].GetInteger());
            Assert.HasCount(roster, (Array)policy[1]);
            BigInteger nonce = Nonce(snapshot, id, adapterId);
            BigInteger configurationNonce = Account(snapshot, id)[4].GetInteger();
            // The deadline is far in the future: the witness engines of the node see no block.
            var operation = Operation(snapshot, id, NativeContract.GAS.Hash, "symbol", [], nonce: nonce, sign: false, validatorId: adapterId,
                deadline: BigInteger.One << 62);
            byte[] digest = Success(snapshot, "getOperationDigest", [id, operation]).GetSpan().ToArray();
            // Every member is listed in ascending order; only the first <verified> carry a signature.
            operation[11] = MemberEntries(members.Select((member, i) =>
                (member, i < verified ? MemberSignature(member, digest, Key((byte)(i + 1))) : System.Array.Empty<byte>())).ToArray());
            bool quorum = verified >= threshold;

            // The node's own witness verification of the envelope, under the default cap.
            UInt160 address = SmartAccountProtocol.GetAccountAddress(id);
            var tx = new Transaction
            {
                Version = 0, Attributes = [],
                Script = SmartAccountTestSupport.ExecuteUserOp(id, (Array)Stack(operation)),
                Signers = [new Signer { Account = Custody, Scopes = WitnessScope.None }, new Signer { Account = address, Scopes = WitnessScope.Global }],
                Witnesses = [new Witness(), new Witness
                {
                    InvocationScript = ReadOnlyMemory<byte>.Empty, VerificationScript = SmartAccountProtocol.CreateVerificationScript(id).ToArray(),
                }],
            };
            // The network fee is quoted by executing the witnesses, and it is part of the signing data.
            SignPayer(tx);
            tx.NetworkFee = Neo.Wallets.Helper.CalculateNetworkFee(tx, snapshot, V41);
            SignPayer(tx);
            Assert.IsTrue(tx.VerifyWitnesses(V41, snapshot, Neo.SmartContract.Helper.MaxVerificationGas), "the node accepts both witnesses under the default cap");
            Assert.AreEqual(VerifyResult.Succeed, tx.VerifyStateIndependent(V41));
            Assert.IsTrue(Neo.SmartContract.Helper.VerifyWitness(tx, V41, snapshot, address, tx.Witnesses[1], Neo.SmartContract.Helper.MaxVerificationGas, out long witness),
                "the proxy witness admits the roster under the platform cap");
            Assert.IsLessThan(Neo.SmartContract.Helper.MaxVerificationGas, witness);

            // The public validation entry is read-only and answers every legal roster.
            using (var preview = Invoke(snapshot, "validateUserOp", [id, operation], now))
            {
                Assert.AreEqual(VMState.HALT, preview.State, preview.FaultException?.ToString());
                var reply = (Array)preview.ResultStack[0];
                Assert.AreEqual(quorum, reply[0].GetBoolean());
                Assert.AreSequenceEqual(digest, reply[1].GetSpan().ToArray());
            }
            Assert.AreEqual(nonce, Nonce(snapshot, id, adapterId), "the validation entry consumes nothing");

            if (quorum)
            {
                using var executed = UT_SmartAccount.Invoke(snapshot, tx, now);
                Assert.AreEqual(VMState.HALT, executed.State, executed.FaultException?.ToString());
                Assert.AreEqual("GAS", executed.ResultStack.Peek().GetString());
                Assert.HasCount(1, executed.Notifications.Where(n => n.EventName == "UserOpExecuted"));
                Console.WriteLine($"Composite {threshold}-of-{roster}: witness {witness} datoshi, execution {executed.FeeConsumed} datoshi");
                executed.SnapshotCache.Commit();
                Assert.AreEqual(nonce + 1, Nonce(snapshot, id, adapterId));
                return;
            }
            using var refused = Invoke(snapshot, "executeUserOp", [id, operation], now);
            Refused(refused, "SA_VALIDATION_REJECTED");
            Assert.AreEqual(nonce, Nonce(snapshot, id, adapterId));
            Assert.AreEqual(configurationNonce, Account(snapshot, id)[4].GetInteger());
            Assert.AreEqual((BigInteger)1, ((Array)Success(snapshot, "getModule", [id, adapterId]))[8].GetInteger(), "nothing was revoked");
            Assert.HasCount(roster, (Array)((Array)Success(snapshot, "getThresholdPolicy", [id, adapterId], target: adapter))[1], "the account keeps its roster");
        }

        // ------------------------------------------------------------------
        // Review semantics
        // ------------------------------------------------------------------

        [TestMethod]
        [DataRow(false)]
        [DataRow(true)]
        public void DisjointIntentsDoNotConflictButASiblingCommitInvalidatesTheRest(bool subjectsFirst)
        {
            var snapshot = Snapshot();
            UInt160 governance = Deploy(snapshot, "GovernanceModule"), signing = Deploy(snapshot, "SigningModule"), seat = Deploy(snapshot, "RecoveryModule");
            UInt160 id = Register(snapshot, [Install(snapshot, governance, Validator), Install(snapshot, signing, Validator), Install(snapshot, seat, Recovery)]);
            BigInteger signingId = InstanceOf(snapshot, id, "validator", signing), seatId = InstanceOf(snapshot, id, "recovery", seat);
            object[] subjects = [Configure(signingId, new object[] { Custody }, 1)];
            object[] batch = [Builtin(true, false), Configure(seatId, RecoveryData([Guardian], Timelock))];
            object[] first = subjectsFirst ? subjects : batch, second = subjectsFirst ? batch : subjects;
            BigInteger initialNonce = Account(snapshot, id)[4].GetInteger();

            BigInteger a = Propose(snapshot, id, governance, first, 1000);
            BigInteger b = Propose(snapshot, id, governance, second, 1001);
            Assert.AreEqual(BigInteger.One, a);
            Assert.AreEqual((BigInteger)2, b);

            using var landed = Confirm(snapshot, id, governance, a, first, 1000 + MaturityMs);
            Assert.AreEqual(VMState.HALT, landed.State, landed.FaultException?.ToString());
            // Every v4.1 landing advances the configuration nonce a confirmation
            // must match, so the sibling can never land and is retired.
            var invalidation = landed.Notifications.Single(n => n.EventName == "ConfigurationInvalidated");
            Assert.AreEqual(b, invalidation.State[1].GetInteger());
            Assert.AreEqual(BigInteger.One, invalidation.State[2].GetInteger());
            landed.SnapshotCache.Commit();
            Assert.IsEmpty(Pending(snapshot, id, governance));
            using var stale = Confirm(snapshot, id, governance, b, second, 1000 + MaturityMs);
            Refused(stale, "SA_INTENT_NOT_FOUND");

            // The retired decision has to be reviewed again from scratch.
            ulong now = 1000 + MaturityMs;
            BigInteger again = Propose(snapshot, id, governance, second, now);
            Assert.IsGreaterThan(b, again);
            using (var stillEarly = Confirm(snapshot, id, governance, again, second, now + MaturityMs - 1))
                Refused(stillEarly, "SA_INTENT_IMMATURE");
            Success(snapshot, "confirmConfiguration", [id, again, second], now + MaturityMs, target: governance);
            Assert.AreEqual(initialNonce + 2, Account(snapshot, id)[4].GetInteger());
            Assert.IsFalse(Account(snapshot, id)[6].GetBoolean());
            var policy = (Array)Success(snapshot, "getMessagePolicy", [id, signingId], target: signing);
            Assert.AreSequenceEqual(Custody.GetSpan().ToArray(), ((Array)policy[0])[0].GetSpan().ToArray());
        }

        [TestMethod]
        [DataRow(false)]
        [DataRow(true)]
        public void MessageSignaturesBindScriptIdentitySenderGenerationAndAccountState(bool useSha256)
        {
            var snapshot = Snapshot();
            UInt160 governance = Deploy(snapshot, "GovernanceModule"), signing = Deploy(snapshot, "SigningModule");
            UInt160 id = Register(snapshot, [Install(snapshot, governance, Validator), Install(snapshot, signing, Validator)]);
            BigInteger signingId = InstanceOf(snapshot, id, "validator", signing);
            ulong now = 1000;
            byte[] script = Contract.CreateSignatureRedeemScript(CustodyKey.PublicKey).ToArray();
            byte[] subject = useSha256 ? SHA256.HashData(script) : Custody.GetSpan().ToArray();
            Land(snapshot, id, governance, [Configure(signingId, new object[] { subject }, 1)], ref now);

            byte[] hash = SHA256.HashData("test message"u8.ToArray());
            UInt160 sender = UInt160.Parse("0x0808080808080808080808080808080808080808");
            var account = Account(snapshot, id);
            byte[] preimage =
            [
                .. "NeoSmartAccount/Message"u8, 4, .. UInt32Le(V41.Network),
                .. NativeContract.SmartAccount.Hash.GetSpan(), .. id.GetSpan(), .. sender.GetSpan(),
                .. UInt64Be(signingId), .. UInt64Be(1), .. UInt64Be(account[3].GetInteger()), .. hash,
            ];
            // The platform hashes the preimage exactly once inside the
            // verification syscall, so the signed digest is SHA-256(preimage).
            byte[] signature = UT_SmartAccount.SignPrehashed(CustodyKey, SHA256.HashData(preimage));
            object[] pair = [script, signature];
            string Check(UInt160 origin, BigInteger generation, object[] pairs) => Convert.ToHexString(Success(snapshot, "validateMessageSignature",
                [id, origin, signingId, generation, hash, pairs], signers: [], target: signing).GetSpan());
            // The module's boolean twin of the ERC-1271 answer is a module entry, not the retired native one.
            bool ModuleAccepts(UInt160 origin, BigInteger generation, object[] pairs) => Success(snapshot, "isValidSignature",
                [id, origin, signingId, generation, hash, pairs], signers: [], target: signing).GetBoolean();

            Assert.AreEqual("1626BA7E", Check(sender, 1, pair));
            Assert.IsTrue(ModuleAccepts(sender, 1, pair));
            Assert.AreEqual("FFFFFFFF", Check(sender, 2, pair));
            Assert.IsFalse(ModuleAccepts(sender, 2, pair), "another generation");
            Assert.AreEqual("FFFFFFFF", Check(Recipient, 1, pair));
            Assert.IsFalse(ModuleAccepts(Recipient, 1, pair), "another original sender");
            Assert.AreEqual("FFFFFFFF", Check(sender, 1, [pair, pair]));
            Assert.IsFalse(ModuleAccepts(sender, 1, [pair, pair]), "a repeated subject");
            Assert.AreEqual("FFFFFFFF", Check(sender, 1, [script, new byte[64]]));
            Assert.IsFalse(ModuleAccepts(sender, 1, [script, new byte[64]]), "a signature that verifies nothing");
            Assert.AreEqual("FFFFFFFF", Check(sender, 1, [Custody.GetSpan().ToArray(), new byte[64]]));
            Assert.IsFalse(ModuleAccepts(sender, 1, [Custody.GetSpan().ToArray(), new byte[64]]), "a subject that is not the canonical script");
            Assert.AreEqual("FFFFFFFF", Check(sender, 1, [script]));
            Assert.IsFalse(ModuleAccepts(sender, 1, [script]), "an odd pair list");
            using (var retired = Invoke(snapshot, "isValidSignature", [id, hash, new object[] { 4, 0, 2, new object[] { pair } }], signers: []))
                RetiredEntry(retired);

            Success(snapshot, "freezeAccount", [id], now);
            Assert.AreEqual("FFFFFFFF", Check(sender, 1, pair));
        }

        [TestMethod]
        public void RemovingGovernancePreservesCommittedMessagePolicyAndStrandsThePendingChange()
        {
            var snapshot = Snapshot();
            UInt160 governance = Deploy(snapshot, "GovernanceModule"), signing = Deploy(snapshot, "SigningModule");
            UInt160 id = Register(snapshot, [Install(snapshot, governance, Validator), Install(snapshot, signing, Validator)]);
            BigInteger governanceId = InstanceOf(snapshot, id, "validator", governance), signingId = InstanceOf(snapshot, id, "validator", signing);
            ulong now = 1000;
            Land(snapshot, id, governance, [Configure(signingId, new object[] { Guardian }, 1)], ref now);
            object[] restore = [Configure(signingId, new object[] { Custody }, 1)];
            BigInteger pending = Propose(snapshot, id, governance, restore, now);

            // The account's last governance seat leaves through its own review.
            // The module seat stays, but its intent table leaves with the
            // instance, and no caller can reinstall it.
            Land(snapshot, id, governance, Actions([2, governanceId, new object[0]]), ref now);

            void AssertEffectiveRoster()
            {
                var row = (Array)Success(snapshot, "getMessagePolicy", [id, signingId], target: signing);
                Assert.HasCount(1, (Array)row[0]);
                Assert.AreSequenceEqual(Guardian.GetSpan().ToArray(), ((Array)row[0])[0].GetSpan().ToArray());
                Assert.AreEqual(BigInteger.One, row[1].GetInteger());
                Assert.AreEqual(BigInteger.One, row[2].GetInteger());
            }

            AssertEffectiveRoster();
            Assert.IsEmpty((Array)Success(snapshot, "getModule", [id, governanceId]));
            Assert.IsEmpty(Pending(snapshot, id, governance), "the leaving seat takes its intent table with it");
            using (var stranded = Confirm(snapshot, id, governance, pending, restore, now + MaturityMs))
                Refused(stranded, "SA_MODULE_NOT_INSTALLED");
            using (var reinstall = Invoke(snapshot, "installModule", [id, Validator, governance, new object[0]], now + MaturityMs))
                Refused(reinstall, "SA_UNAUTHORIZED");
            AssertEffectiveRoster();
        }

        [TestMethod]
        [DataRow(true)]
        [DataRow(false)]
        public void CommittedMessageRosterIsModuleOwnedAndCannotBlockRecovery(bool removeBody)
        {
            var snapshot = Snapshot();
            UInt160 governance = Deploy(snapshot, "GovernanceModule"), signing = Deploy(snapshot, "SigningModule"), seat = Deploy(snapshot, "RecoveryModule");
            UInt160 id = Register(snapshot, [Install(snapshot, governance, Validator), Install(snapshot, signing, Validator), Install(snapshot, seat, Recovery)]);
            BigInteger signingId = InstanceOf(snapshot, id, "validator", signing), seatId = InstanceOf(snapshot, id, "recovery", seat);
            ulong now = 1000;
            Land(snapshot, id, governance, [Configure(signingId, new object[] { Guardian }, 1)], ref now);
            Land(snapshot, id, governance, [Configure(seatId, RecoveryData([Guardian], Timelock))], ref now);

            var row = new StorageKey
            {
                Id = NativeContract.ContractManagement.GetContract(snapshot, signing)!.Id,
                Key = ModuleRowKey(id, signingId),
            };
            Assert.IsGreaterThan(0, snapshot[row].Value.Length);
            using (var retired = Invoke(snapshot, "storeGovernedPolicy", [id, 4, snapshot[row].Value.ToArray()], target: governance))
                RetiredEntry(retired);
            if (removeBody) snapshot.Delete(row);
            else snapshot.GetAndChange(row)!.Value = new byte[] { 0 };
            if (removeBody)
            {
                Assert.IsEmpty((Array)Success(snapshot, "getMessagePolicy", [id, signingId], target: signing));
                Assert.AreEqual("FFFFFFFF", Convert.ToHexString(Success(snapshot, "validateMessageSignature",
                    [id, Recipient, signingId, 1, new byte[32], new object[] { Custody.GetSpan().ToArray(), new byte[64] }], target: signing).GetSpan()));
            }
            else
            {
                // A damaged row is not a roster: the module reads it as "no policy"
                // and fails closed, it never faults the caller or the governance.
                Assert.IsEmpty((Array)Success(snapshot, "getMessagePolicy", [id, signingId], target: signing));
                Assert.IsEmpty(Pending(snapshot, id, governance));
                Assert.AreEqual("FFFFFFFF", Convert.ToHexString(Success(snapshot, "validateMessageSignature",
                    [id, Recipient, signingId, 1, new byte[32], new object[] { Custody.GetSpan().ToArray(), new byte[64] }], target: signing).GetSpan()));
            }

            // The roster is the signing module's own state: the native reset
            // never reads it, so a damaged row cannot delay the recovery.
            Success(snapshot, "beginRecovery", [id, UInt160.Zero], now, signers: [Guardian], target: seat);
            Success(snapshot, "executeRecovery", [id], now + Timelock, signers: [Stranger], target: seat);
            Assert.IsEmpty((Array)Success(snapshot, "getModule", [id, signingId]));
            Assert.IsEmpty((Array)Success(snapshot, "getModule", [id, seatId]));
            Assert.IsEmpty((Array)Success(snapshot, "getRecoveryStatus", [id], target: seat));
            Assert.IsEmpty((Array)Success(snapshot, "getRecoveryPolicySnapshot", [id], target: seat));
            Assert.AreEqual("FFFFFFFF", Convert.ToHexString(Success(snapshot, "validateMessageSignature",
                [id, Recipient, signingId, 1, new byte[32], new object[] { Custody.GetSpan().ToArray(), new byte[64] }], target: signing).GetSpan()));
        }

        // ------------------------------------------------------------------
        // Recovery
        // ------------------------------------------------------------------

        [TestMethod]
        public void FrozenAccountRecoversThroughDeployedSeatAfterTimelock()
        {
            var snapshot = Snapshot();
            UInt160 governance = Deploy(snapshot, "GovernanceModule"), seat = Deploy(snapshot, "RecoveryModule");
            UInt160 id = Register(snapshot, [Install(snapshot, governance, Validator), Install(snapshot, seat, Recovery)]);
            BigInteger seatId = InstanceOf(snapshot, id, "recovery", seat);
            BigInteger governanceId = InstanceOf(snapshot, id, "validator", governance);
            ulong now = 1000;
            Land(snapshot, id, governance, [Configure(seatId, RecoveryData([Guardian], Timelock))], ref now);
            Assert.AreEqual(Custody, new UInt160(Account(snapshot, id)[2].GetSpan()));

            Success(snapshot, "freezeAccount", [id], now);
            Assert.AreEqual((BigInteger)(int)SmartAccountStatus.Frozen, Account(snapshot, id)[1].GetInteger());
            using (var noConsent = Invoke(snapshot, "beginRecovery", [id, Recipient], now, signers: [Guardian], target: seat))
                Refused(noConsent, "SA_UNAUTHORIZED");
            using (var stranger = Invoke(snapshot, "beginRecovery", [id, Recipient], now, signers: [Stranger, Recipient], target: seat))
                Refused(stranger, "SA_UNAUTHORIZED");
            using (var retiredCancel = Invoke(snapshot, "cancelReviewedRecovery", [id, 1, 0], signers: [Guardian], target: seat)) RetiredEntry(retiredCancel);
            using (var retiredExecute = Invoke(snapshot, "executeReviewedRecovery", [id, 1, 0], signers: [Guardian], target: seat)) RetiredEntry(retiredExecute);
            using (var noRequest = Invoke(snapshot, "executeRecovery", [id], now + Timelock, target: seat)) Refused(noRequest, "SA_RECOVERY_PENDING");
            Assert.IsEmpty((Array)Success(snapshot, "getRecoveryStatus", [id], target: seat));

            Assert.AreEqual(BigInteger.One, Success(snapshot, "beginRecovery", [id, Recipient], now, signers: [Guardian, Recipient], target: seat).GetInteger());
            using (var again = Invoke(snapshot, "beginRecovery", [id, Recipient], now, signers: [Guardian, Recipient], target: seat))
                Refused(again, "SA_RECOVERY_PENDING");
            using (var early = Invoke(snapshot, "executeRecovery", [id], now + Timelock - 1, signers: [Payer], target: seat))
                Refused(early, "SA_RECOVERY_LOCKED");
            Assert.AreEqual((BigInteger)1, ((Array)Success(snapshot, "getRecoveryStatus", [id], target: seat))[4].GetInteger());

            // Completion is permissionless once the timelock elapsed.
            BigInteger epoch = Account(snapshot, id)[3].GetInteger();
            BigInteger nonce = Account(snapshot, id)[4].GetInteger();
            BigInteger revision = Account(snapshot, id)[8].GetInteger();
            BigInteger channel = Nonce(snapshot, id, governanceId) >> 64;
            using var executed = Invoke(snapshot, "executeRecovery", [id], now + Timelock, signers: [Payer], target: seat);
            Assert.AreEqual(VMState.HALT, executed.State, executed.FaultException?.ToString());
            executed.SnapshotCache.Commit();
            // The executed nonce is carried by the module event: the reset retires
            // the seat in the same frame, so the seat-resolved read answers zero.
            var completed = executed.Notifications.Single(n => n.EventName == "RecoveryExecuted");
            Assert.AreEqual(seat, completed.ScriptHash);
            Assert.AreEqual(id, new UInt160(completed.State[0].GetSpan()));
            Assert.AreEqual(BigInteger.One, completed.State[1].GetInteger());
            Assert.AreEqual(Recipient, new UInt160(completed.State[2].GetSpan()));
            var state = Account(snapshot, id);
            Assert.AreEqual((BigInteger)(int)SmartAccountStatus.Active, state[1].GetInteger());
            Assert.AreEqual(Recipient, new UInt160(state[2].GetSpan()));
            Assert.IsTrue(state[5].GetBoolean());
            Assert.IsTrue(state[6].GetBoolean());
            Assert.AreEqual(BigInteger.Zero, state[7].GetInteger());
            Assert.AreEqual(epoch + 1, state[3].GetInteger(), "the reset advanced the authority epoch exactly once");
            Assert.AreEqual(nonce + 1, state[4].GetInteger(), "the reset advanced the configuration nonce exactly once");
            Assert.AreEqual(revision + 1, state[8].GetInteger(), "the reset advanced the control revision exactly once");
            Assert.IsEmpty((Array)Success(snapshot, "getModule", [id, seatId]));
            Assert.IsEmpty((Array)Success(snapshot, "getModule", [id, governanceId]));
            Assert.IsEmpty((Array)Success(snapshot, "getRecoveryStatus", [id], target: seat));
            // The reset removed the seat: the module's seat-resolved read has no instance to resolve.
            Assert.AreEqual(BigInteger.Zero, Success(snapshot, "getExecutedRecoveryNonce", [id], target: seat).GetInteger());
            // Old nonce channels are gone: the retired governance channel restarts at sequence 0.
            Assert.AreEqual(BigInteger.Zero, Success(snapshot, "getNonceSequence", [id, channel]).GetInteger(),
                "the reset deleted every nonce cursor row");

            // The same atomic transaction restored a usable composition under fresh ids:
            // a new recovery seat and a new governance validator, each bound and live.
            BigInteger newSeatId = InstanceOf(snapshot, id, "recovery", seat);
            BigInteger newGovernanceId = InstanceOf(snapshot, id, "validator", governance);
            Assert.IsGreaterThan(seatId, newSeatId, "the reinstalled seat got a fresh instance id");
            Assert.IsGreaterThan(governanceId, newGovernanceId, "the reinstalled governance got a fresh instance id");
            Assert.AreEqual(BigInteger.One, ((Array)Success(snapshot, "getModule", [id, newGovernanceId]))[8].GetInteger(),
                "a reinstalled instance starts at credential generation 1");
            Assert.IsTrue(((Array)Success(snapshot, "getModule", [id, newGovernanceId]))[13].GetBoolean(),
                "the restored governance keeps its capability");
            Assert.IsEmpty(Pending(snapshot, id, governance), "no intent survives under the retired instance");

            // Governance is immediately usable again through the new custody: the recovered
            // account lands one ordinary configuration against the freshly bound instance.
            object[] configure = [Configure(newSeatId, RecoveryData([NewGuardian], Timelock))];
            BigInteger intent = Success(snapshot, "proposeConfiguration", [id, configure, new object[0]], now,
                signers: [Recipient], target: governance).GetInteger();
            using (var landed = Confirm(snapshot, id, governance, intent, configure, now + MaturityMs, [Recipient]))
            {
                Assert.AreEqual(VMState.HALT, landed.State, landed.FaultException?.ToString());
                landed.SnapshotCache.Commit();
            }
            Assert.AreEqual(nonce + 2, Account(snapshot, id)[4].GetInteger(),
                "the restored governance lands one ordinary configuration step");
            var policy = (Array)Success(snapshot, "getRecoveryPolicySnapshot", [id], target: seat);
            Assert.AreEqual(NewGuardian, new UInt160(((Array)policy[0])[0].GetSpan()));
        }

        [TestMethod]
        public void RecoveryAuthorityChangeRetiresPendingRequest()
        {
            var snapshot = Snapshot();
            UInt160 governance = Deploy(snapshot, "GovernanceModule"), seat = Deploy(snapshot, "RecoveryModule");
            UInt160 id = Register(snapshot, [Install(snapshot, governance, Validator), Install(snapshot, seat, Recovery)]);
            BigInteger seatId = InstanceOf(snapshot, id, "recovery", seat);
            ulong now = 1000;
            Land(snapshot, id, governance, [Configure(seatId, RecoveryData([Guardian], Timelock))], ref now);
            BigInteger proposal = Success(snapshot, "beginRecovery", [id, Recipient], now, signers: [Guardian, Recipient], target: seat).GetInteger();
            BigInteger nonce = Account(snapshot, id)[4].GetInteger();

            Land(snapshot, id, governance, [Configure(seatId, RecoveryData([NewGuardian], Timelock))], ref now);
            Assert.IsGreaterThan(nonce, Account(snapshot, id)[4].GetInteger(), "the policy write is a configuration commit");
            using (var stale = Invoke(snapshot, "executeRecovery", [id], now + Timelock, target: seat))
                Refused(stale, "SA_CONFIGURATION_NONCE_STALE");
            Assert.AreEqual((BigInteger)1, ((Array)Success(snapshot, "getRecoveryStatus", [id], target: seat))[4].GetInteger(), "the request stays pending");

            using (var oldGuardian = Invoke(snapshot, "cancelRecovery", [id], now + Timelock, signers: [Guardian], target: seat))
                Refused(oldGuardian, "SA_UNAUTHORIZED");
            Success(snapshot, "cancelRecovery", [id], now + Timelock, signers: [NewGuardian], target: seat);
            Assert.IsEmpty((Array)Success(snapshot, "getRecoveryStatus", [id], target: seat));
            BigInteger fresh = Success(snapshot, "beginRecovery", [id, Recipient], now + Timelock, signers: [NewGuardian, Recipient], target: seat).GetInteger();
            Assert.IsGreaterThan(proposal, fresh, "a fresh decision gets a fresh nonce");
            Success(snapshot, "executeRecovery", [id], now + 2 * Timelock, target: seat);
            Assert.AreEqual(Recipient, new UInt160(Account(snapshot, id)[2].GetSpan()));
        }

        [TestMethod]
        public void RecoveryTimelockChangeRetiresPendingRequest()
        {
            var snapshot = Snapshot();
            UInt160 governance = Deploy(snapshot, "GovernanceModule"), seat = Deploy(snapshot, "RecoveryModule");
            UInt160 id = Register(snapshot, [Install(snapshot, governance, Validator), Install(snapshot, seat, Recovery)]);
            BigInteger seatId = InstanceOf(snapshot, id, "recovery", seat);
            ulong now = 1000;
            Land(snapshot, id, governance, [Configure(seatId, RecoveryData([Guardian], Timelock))], ref now);
            Success(snapshot, "beginRecovery", [id, UInt160.Zero], now, signers: [Guardian], target: seat);

            Land(snapshot, id, governance, [Configure(seatId, RecoveryData([Guardian], MaxTimelock))], ref now);
            Assert.AreEqual((BigInteger)MaxTimelock, ((Array)Success(snapshot, "getRecoveryPolicySnapshot", [id], target: seat))[2].GetInteger());
            using (var stale = Invoke(snapshot, "executeRecovery", [id], now + Timelock, target: seat))
                Refused(stale, "SA_CONFIGURATION_NONCE_STALE");
            Success(snapshot, "cancelRecovery", [id], now + Timelock, signers: [Guardian], target: seat);
            Success(snapshot, "beginRecovery", [id, UInt160.Zero], now + Timelock, signers: [Guardian], target: seat);
            using (var early = Invoke(snapshot, "executeRecovery", [id], now + 2 * Timelock, target: seat)) Refused(early, "SA_RECOVERY_LOCKED");
            Success(snapshot, "executeRecovery", [id], now + Timelock + MaxTimelock, target: seat);
            Assert.AreEqual(Custody, new UInt160(Account(snapshot, id)[2].GetSpan()));
        }

        [TestMethod]
        public void IdempotentPolicyRewriteStillRetiresThePendingRequest()
        {
            var snapshot = Snapshot();
            UInt160 governance = Deploy(snapshot, "GovernanceModule"), seat = Deploy(snapshot, "RecoveryModule");
            UInt160 id = Register(snapshot, [Install(snapshot, governance, Validator), Install(snapshot, seat, Recovery)]);
            BigInteger seatId = InstanceOf(snapshot, id, "recovery", seat);
            ulong now = 1000;
            Land(snapshot, id, governance, [Configure(seatId, RecoveryData([Guardian], Timelock))], ref now);
            Success(snapshot, "beginRecovery", [id, Recipient], now, signers: [Guardian, Recipient], target: seat);
            BigInteger nonce = Account(snapshot, id)[4].GetInteger();

            Land(snapshot, id, governance, [Configure(seatId, RecoveryData([Guardian], Timelock))], ref now);
            Assert.AreEqual(nonce + 1, Account(snapshot, id)[4].GetInteger(), "even an idempotent rewrite is a configuration commit");
            var policy = (Array)Success(snapshot, "getRecoveryPolicySnapshot", [id], target: seat);
            Assert.AreEqual(new UInt160(((Array)policy[0])[0].GetSpan()), Guardian);
            Assert.AreEqual((BigInteger)Timelock, policy[2].GetInteger());
            Assert.AreEqual((BigInteger)2, policy[4].GetInteger(), "the rewrite is a new revision");

            // A reviewed decision is bound to the policy it saw; there is no
            // second native landing under v4.1, so the request simply retires.
            using (var stale = Invoke(snapshot, "executeRecovery", [id], now + Timelock, target: seat))
                Refused(stale, "SA_CONFIGURATION_NONCE_STALE");
            Assert.AreEqual(Recipient, new UInt160(((Array)Success(snapshot, "getRecoveryStatus", [id], target: seat))[5].GetSpan()));
            Assert.AreEqual(BigInteger.Zero, Success(snapshot, "getExecutedRecoveryNonce", [id], target: seat).GetInteger());
        }

        [TestMethod]
        public void GovernedBatchRecoveryPolicyChangeRetiresPendingRequest()
        {
            var snapshot = Snapshot();
            UInt160 governance = Deploy(snapshot, "GovernanceModule"), seat = Deploy(snapshot, "RecoveryModule");
            UInt160 id = Register(snapshot, [Install(snapshot, governance, Validator), Install(snapshot, seat, Recovery)]);
            BigInteger seatId = InstanceOf(snapshot, id, "recovery", seat);
            ulong now = 1000;
            Land(snapshot, id, governance, [Configure(seatId, RecoveryData([Guardian], Timelock))], ref now);
            Success(snapshot, "beginRecovery", [id, UInt160.Zero], now, signers: [Guardian], target: seat);
            object[] actions = [Builtin(false, true), Configure(seatId, RecoveryData([NewGuardian], Timelock))];

            using (var direct = Invoke(snapshot, "applyConfigurationActions", [id, actions], signers: [Custody, NewGuardian]))
                Refused(direct, "SA_UNAUTHORIZED");
            Land(snapshot, id, governance, actions, ref now);
            Assert.IsFalse(Account(snapshot, id)[5].GetBoolean());
            Assert.AreEqual(NewGuardian, new UInt160(((Array)((Array)Success(snapshot, "getRecoveryPolicySnapshot", [id], target: seat))[0])[0].GetSpan()));
            using (var stale = Invoke(snapshot, "executeRecovery", [id], now + Timelock, target: seat))
                Refused(stale, "SA_CONFIGURATION_NONCE_STALE");
        }

        [TestMethod]
        public void RecoveryConsentIsCheckedWhenTheRequestBeginsNotWhenThePolicyLands()
        {
            var snapshot = Snapshot();
            UInt160 governance = Deploy(snapshot, "GovernanceModule"), seat = Deploy(snapshot, "RecoveryModule");
            UInt160 id = Register(snapshot, [Install(snapshot, governance, Validator), Install(snapshot, seat, Recovery)]);
            BigInteger seatId = InstanceOf(snapshot, id, "recovery", seat);
            UInt160 otherGuardian = UInt160.Parse("0x0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a");
            ulong now = 1000;
            object[] actions = [Configure(seatId, RecoveryData([Guardian, otherGuardian], Timelock, Incoming, 2))];
            BigInteger intent = Propose(snapshot, id, governance, actions, now);
            using (var early = Confirm(snapshot, id, governance, intent, actions, now + MaturityMs - 1, [Custody, Incoming]))
                Refused(early, "SA_INTENT_IMMATURE");

            // v4.1 keeps no recovery field in the account record: the landing
            // is a module configure and needs the custody witness only.
            Success(snapshot, "confirmConfiguration", [id, intent, actions], now + MaturityMs, target: governance);
            Assert.AreEqual(BigInteger.Zero, Account(snapshot, id)[7].GetInteger());
            var policy = (Array)Success(snapshot, "getRecoveryPolicySnapshot", [id], target: seat);
            Assert.AreEqual(Incoming, new UInt160(policy[3].GetSpan()));
            now += MaturityMs;

            // Two guardians are configured with a quorum of two, so one guardian is not the authority.
            using (var single = Invoke(snapshot, "beginRecovery", [id, Recipient], now, signers: [Guardian, Recipient], target: seat))
                Refused(single, "SA_UNAUTHORIZED");
            Assert.AreEqual(BigInteger.One, Success(snapshot, "beginRecovery", [id, Recipient], now, signers: [Guardian, otherGuardian, Recipient], target: seat).GetInteger());
            Success(snapshot, "cancelRecovery", [id], now, signers: [Incoming], target: seat);
            Assert.AreEqual((BigInteger)2, Success(snapshot, "beginRecovery", [id, Recipient], now, signers: [Incoming, Recipient], target: seat).GetInteger());
            // The recipient's witness is checked before the pending record
            // answers: the authority alone names a recipient nobody consented to be.
            using (var consentless = Invoke(snapshot, "beginRecovery", [id, Recipient], now + 1, signers: [Incoming], target: seat))
                Refused(consentless, "SA_UNAUTHORIZED");
            // With that witness the pending request is the refusal.
            using (var crowded = Invoke(snapshot, "beginRecovery", [id, Recipient], now + 1, signers: [Incoming, Recipient], target: seat))
                Refused(crowded, "SA_RECOVERY_PENDING");
            var pending = (Array)Success(snapshot, "getRecoveryStatus", [id], target: seat);
            Assert.AreEqual((BigInteger)2, pending[0].GetInteger(), "the pending request is untouched");
            Assert.AreEqual(BigInteger.One, pending[4].GetInteger());
            Assert.AreEqual(Recipient, new UInt160(pending[5].GetSpan()));
            Success(snapshot, "cancelRecovery", [id], now + 1, signers: [Incoming], target: seat);
            Assert.IsEmpty((Array)Success(snapshot, "getRecoveryStatus", [id], target: seat));

            // Custody is an authority too and is held to the same consent; a
            // recovery that keeps custody needs no recipient witness.
            using (var custodyAlone = Invoke(snapshot, "beginRecovery", [id, Recipient], now + 1, signers: [Custody], target: seat))
                Refused(custodyAlone, "SA_UNAUTHORIZED");
            Assert.AreEqual((BigInteger)3, Success(snapshot, "beginRecovery", [id, UInt160.Zero], now + 1, signers: [Custody], target: seat).GetInteger());
        }

        [TestMethod]
        [DataRow(false)]
        [DataRow(true)]
        public void DisjointCorePoliciesLandInEitherOrderAndTheOtherIsInvalidated(bool recoveryFirst)
        {
            var snapshot = Snapshot();
            UInt160 governance = Deploy(snapshot, "GovernanceModule"), seat = Deploy(snapshot, "RecoveryModule");
            UInt160 id = Register(snapshot, [Install(snapshot, governance, Validator), Install(snapshot, seat, Recovery)]);
            BigInteger seatId = InstanceOf(snapshot, id, "recovery", seat);
            object[] recovery = [Configure(seatId, RecoveryData([Guardian], Timelock))];
            object[] builtin = [Builtin(true, false)];
            object[] first = recoveryFirst ? recovery : builtin, second = recoveryFirst ? builtin : recovery;
            BigInteger a = Propose(snapshot, id, governance, first, 1000);
            BigInteger b = Propose(snapshot, id, governance, second, 1001);
            var original = (Array)Success(snapshot, "getPendingConfiguration", [id, b], target: governance);
            Assert.AreEqual(9, original.Count);
            BigInteger initialNonce = Account(snapshot, id)[4].GetInteger();

            using var landed = Confirm(snapshot, id, governance, a, first, 1000 + MaturityMs);
            Assert.AreEqual(VMState.HALT, landed.State, landed.FaultException?.ToString());
            landed.SnapshotCache.Commit();
            Assert.AreEqual(b, landed.Notifications.Single(n => n.EventName == "ConfigurationInvalidated").State[1].GetInteger());
            Assert.IsEmpty(Pending(snapshot, id, governance));
            Assert.IsEmpty((Array)Success(snapshot, "getPendingConfiguration", [id, b], target: governance));
            using var stale = Confirm(snapshot, id, governance, b, second, 1000 + MaturityMs + 1);
            Refused(stale, "SA_INTENT_NOT_FOUND");

            ulong now = 1000 + MaturityMs;
            Success(snapshot, "confirmConfiguration", [id, Propose(snapshot, id, governance, second, now), second], now + MaturityMs, target: governance);
            var state = Account(snapshot, id);
            Assert.AreEqual(initialNonce + 2, state[4].GetInteger());
            Assert.IsFalse(state[6].GetBoolean());
            Assert.AreEqual(BigInteger.Zero, state[7].GetInteger());
            Assert.AreEqual(Guardian, new UInt160(((Array)((Array)Success(snapshot, "getRecoveryPolicySnapshot", [id], target: seat))[0])[0].GetSpan()));
            Assert.IsEmpty(Pending(snapshot, id, governance));
        }

        [TestMethod]
        public void OutOfBandCredentialRevocationCannotBeCarriedByALaterGovernanceCommit()
        {
            var snapshot = Snapshot();
            UInt160 governance = Deploy(snapshot, "GovernanceModule");
            UInt160 id = Register(snapshot, [Install(snapshot, governance, Validator)]);
            BigInteger governanceId = InstanceOf(snapshot, id, "validator", governance);
            object[] first = [Builtin(true, false)], second = [Builtin(true, true)];
            BigInteger a = Propose(snapshot, id, governance, first, 1000);
            using (var direct = Invoke(snapshot, "setBuiltinAuthorization", [id, true, true])) Refused(direct, "SA_UNAUTHORIZED");
            using (var directBatch = Invoke(snapshot, "applyConfigurationActions", [id, second])) Refused(directBatch, "SA_UNAUTHORIZED");
            Success(snapshot, "revokeModuleCredentials", [id, governanceId]);
            // The revocation advanced the configuration nonce out of band: the
            // approval custody already gave is stale and cannot be landed.
            using var stale = Confirm(snapshot, id, governance, a, first, 1000 + MaturityMs);
            Refused(stale, "SA_CONFIGURATION_NONCE_STALE");
            Assert.HasCount(1, Pending(snapshot, id, governance));
            Assert.IsTrue(Account(snapshot, id)[5].GetBoolean(), "the default operation authorization is untouched");
            Assert.IsTrue(Account(snapshot, id)[6].GetBoolean(), "so is the default message authorization");

            // The stale approval still owns the builtin resource: a different
            // policy cannot be queued behind it.
            using (var crowded = Invoke(snapshot, "proposeConfiguration", [id, second, new object[0]], 1000 + MaturityMs, target: governance))
                Refused(crowded, "SA_INTENT_CONFLICT");
            Assert.HasCount(1, Pending(snapshot, id, governance));

            // The policy lands only as a fresh approval taken under the new nonce.
            Cancel(snapshot, id, governance, a, 1000 + MaturityMs);
            using var gone = Confirm(snapshot, id, governance, a, first, 1000 + 2 * MaturityMs);
            Refused(gone, "SA_INTENT_NOT_FOUND");
            BigInteger b = Propose(snapshot, id, governance, second, 1000 + MaturityMs);
            Success(snapshot, "confirmConfiguration", [id, b, second], 1000 + 2 * MaturityMs, target: governance);
            Assert.IsEmpty(Pending(snapshot, id, governance));
            Assert.IsTrue(Account(snapshot, id)[5].GetBoolean());
            Assert.IsTrue(Account(snapshot, id)[6].GetBoolean());
        }

        [TestMethod]
        public void TheConfirmationWindowClosesAtExpiryAndAnyoneMayCleanAnExpiredIntent()
        {
            {
                var snapshot = Snapshot();
                UInt160 governance = Deploy(snapshot, "GovernanceModule");
                UInt160 id = Register(snapshot, [Install(snapshot, governance, Validator)]);
                object[] policy = [Builtin(true, false)];
                BigInteger a = Propose(snapshot, id, governance, policy, 1000);
                ulong expires = (ulong)((Array)Success(snapshot, "getPendingConfiguration", [id, a], target: governance))[4].GetInteger();
                Assert.AreEqual(1000 + MaturityMs + (ulong)Success(snapshot, "configurationExpiryWindow", [], target: governance).GetInteger(), expires);

                using (var stranger = Confirm(snapshot, id, governance, a, policy, expires, [Stranger])) Refused(stranger, "SA_UNAUTHORIZED");
                using var lastMoment = Confirm(snapshot, id, governance, a, policy, expires);
                Assert.AreEqual(VMState.HALT, lastMoment.State, lastMoment.FaultException?.ToString());
                Assert.IsFalse(Account(snapshot, id)[6].GetBoolean());
            }
            {
                var snapshot = Snapshot();
                UInt160 governance = Deploy(snapshot, "GovernanceModule");
                UInt160 id = Register(snapshot, [Install(snapshot, governance, Validator)]);
                object[] policy = [Builtin(true, false)];
                BigInteger a = Propose(snapshot, id, governance, policy, 1000);
                ulong expires = (ulong)((Array)Success(snapshot, "getPendingConfiguration", [id, a], target: governance))[4].GetInteger();
                using var expired = Confirm(snapshot, id, governance, a, policy, expires + 1);
                Refused(expired, "SA_INTENT_EXPIRED");
                Assert.IsTrue(Account(snapshot, id)[6].GetBoolean(), "nothing landed");
                Success(snapshot, "cancelConfiguration", [id, a], expires + 1, [Stranger], target: governance);
                Assert.IsEmpty(Pending(snapshot, id, governance));
            }
        }

        [TestMethod]
        public void GovernanceInstallationDoesNotCarryAnIndependentPendingPolicy()
        {
            var snapshot = Snapshot();
            UInt160 governance = Deploy(snapshot, "GovernanceModule"), hookContract = Deploy(snapshot, "WhitelistHook");
            UInt160 id = Register(snapshot, [Install(snapshot, governance, Validator)]);
            object[] install = [Install(snapshot, hookContract, Hook)];
            object[] policy = [Builtin(false, false)];
            BigInteger a = Propose(snapshot, id, governance, policy, 1000);
            BigInteger b = Propose(snapshot, id, governance, install, 1000);

            using var landed = Confirm(snapshot, id, governance, b, install, 1000 + MaturityMs);
            Assert.AreEqual(VMState.HALT, landed.State, landed.FaultException?.ToString());
            landed.SnapshotCache.Commit();
            Assert.AreEqual(a, landed.Notifications.Single(n => n.EventName == "ConfigurationInvalidated").State[1].GetInteger());
            Assert.HasCount(1, (Array)((Array)Success(snapshot, "getModules", [id, "hook", 0, 8]))[0]);
            using var stale = Confirm(snapshot, id, governance, a, policy, 1000 + MaturityMs);
            Refused(stale, "SA_INTENT_NOT_FOUND");
            Assert.IsTrue(Account(snapshot, id)[5].GetBoolean());
            Assert.IsTrue(Account(snapshot, id)[6].GetBoolean());
        }

        [TestMethod]
        public void DeclaredPolicyDependencyStillConflictsAtProposal()
        {
            var snapshot = Snapshot();
            UInt160 governance = Deploy(snapshot, "GovernanceModule"), seat = Deploy(snapshot, "RecoveryModule");
            UInt160 id = Register(snapshot, [Install(snapshot, governance, Validator), Install(snapshot, seat, Recovery)]);
            Success(snapshot, "proposeConfiguration", [id, new object[] { Configure(InstanceOf(snapshot, id, "recovery", seat), RecoveryData([Guardian], Timelock)) },
                new object[] { "builtinPolicy" }], target: governance);
            using var conflict = Invoke(snapshot, "proposeConfiguration", [id, new object[] { Builtin(true, false) }, new object[0]], target: governance);
            Refused(conflict, "SA_INTENT_CONFLICT");
            Assert.HasCount(1, Pending(snapshot, id, governance));
        }

        [TestMethod]
        public void RetiredAndMalformedActionsAreRefusedBeforeAllocatingAnId()
        {
            var snapshot = Snapshot();
            UInt160 governance = Deploy(snapshot, "GovernanceModule");
            UInt160 id = Register(snapshot, [Install(snapshot, governance, Validator)]);
            foreach (object[] action in new object[][]
            {
                new object[] { 4, new object[] { 1 } }, new object[] { 6, 1, new byte[32] },
                new object[] { 8, Guardian, new BigInteger(Timelock), false }, new object[] { 9, new object[] { Guardian }, 1 },
                new object[] { 10, new byte[32], "standard" }, new object[] { 11, 1 }, new object[] { 5, true }, new object[] { 5, 1, false },
                new object[] { 3, 0, new object[0] }, new object[] { 1, 9, governance, new byte[32], new object[0] }, new object[] { 7, 0, true },
                new object[0],
            })
            {
                using var refused = Invoke(snapshot, "proposeConfiguration", [id, new object[] { action, Builtin(true, false) }, new object[0]], target: governance);
                Refused(refused, "SA_OPERATION_MALFORMED");
            }
            Assert.IsEmpty(Pending(snapshot, id, governance));
            Assert.AreEqual(BigInteger.One, Propose(snapshot, id, governance, [Builtin(true, false)], 1000));
        }

        [TestMethod]
        [DataRow(false)]
        [DataRow(true)]
        public void OneIntentCommitsBothPoliciesOnceAndFaultRetainsTheOriginalApproval(bool recoveryFirst)
        {
            var snapshot = Snapshot();
            UInt160 governance = Deploy(snapshot, "GovernanceModule"), seat = Deploy(snapshot, "RecoveryModule");
            UInt160 id = Register(snapshot, [Install(snapshot, governance, Validator), Install(snapshot, seat, Recovery)]);
            BigInteger seatId = InstanceOf(snapshot, id, "recovery", seat);
            object[] recovery = Configure(seatId, RecoveryData([Guardian], Timelock)), builtin = Builtin(true, false);
            object[] actions = recoveryFirst ? [recovery, builtin] : [builtin, recovery];
            var initial = Account(snapshot, id);
            BigInteger intent = Propose(snapshot, id, governance, actions, 1000);
            var proposal = (Array)Success(snapshot, "getPendingConfiguration", [id, intent], target: governance);
            using (var early = Confirm(snapshot, id, governance, intent, actions, 1000 + MaturityMs - 1)) Refused(early, "SA_INTENT_IMMATURE");
            using (var refused = Confirm(snapshot, id, governance, intent, actions, 1000 + MaturityMs, [Stranger])) Refused(refused, "SA_UNAUTHORIZED");

            AssertSameAccount(initial, Account(snapshot, id));
            AssertSameAccount(proposal, (Array)Success(snapshot, "getPendingConfiguration", [id, intent], 1000 + MaturityMs, target: governance));

            using var completed = Confirm(snapshot, id, governance, intent, actions, 1000 + MaturityMs);
            Assert.AreEqual(VMState.HALT, completed.State, completed.FaultException?.ToString());
            var names = new[] { "RecoveryPolicyUpdated", "BuiltinAuthorizationSet", "ConfigurationConfirmed" };
            Assert.AreSequenceEqual(recoveryFirst ? names : new[] { names[1], names[0], names[2] },
                completed.Notifications.Select(n => n.EventName).Where(names.Contains).ToArray());
            completed.SnapshotCache.Commit();
            var state = Account(snapshot, id);
            Assert.AreEqual(initial[4].GetInteger() + 1, state[4].GetInteger());
            Assert.AreEqual(initial[8].GetInteger() + 1, state[8].GetInteger());
            Assert.AreEqual(initial[3].GetInteger(), state[3].GetInteger());
            Assert.AreEqual(Custody, new UInt160(state[2].GetSpan()));
            Assert.IsTrue(state[5].GetBoolean());
            Assert.IsFalse(state[6].GetBoolean());
            Assert.IsEmpty(Pending(snapshot, id, governance));
            Assert.AreEqual(Guardian, new UInt160(((Array)((Array)Success(snapshot, "getRecoveryPolicySnapshot", [id], target: seat))[0])[0].GetSpan()));
        }

        [TestMethod]
        public void LastRouteIsCheckedAtTheEndOfTheAtomicConfiguration()
        {
            var snapshot = Snapshot();
            UInt160 governance = Deploy(snapshot, "GovernanceModule");
            UInt160 id = Register(snapshot, [Install(snapshot, governance, Validator)]);
            BigInteger governanceId = InstanceOf(snapshot, id, "validator", governance);
            ulong now = 1000;
            using (var direct = Invoke(snapshot, "setBuiltinAuthorization", [id, false, true])) Refused(direct, "SA_UNAUTHORIZED");
            using (var removal = Invoke(snapshot, "removeModule", [id, governanceId, new object[0]])) Refused(removal, "SA_UNAUTHORIZED");
            Land(snapshot, id, governance, [Builtin(false, true)], ref now);
            BigInteger nonce = Account(snapshot, id)[4].GetInteger();

            object[] invalid = Actions([2, governanceId, new object[0]], Builtin(false, false));
            BigInteger intent = Propose(snapshot, id, governance, invalid, now);
            using (var refused = Confirm(snapshot, id, governance, intent, invalid, now + MaturityMs)) Refused(refused, "SA_BUILTIN_ROUTE_REQUIRED");
            Assert.IsNotEmpty((Array)Success(snapshot, "getModule", [id, governanceId]));
            Assert.IsTrue(Account(snapshot, id)[6].GetBoolean());
            Assert.AreEqual(nonce, Account(snapshot, id)[4].GetInteger());
            Assert.HasCount(1, Pending(snapshot, id, governance), "the refused landing leaves the intent pending");
            Cancel(snapshot, id, governance, intent, now + MaturityMs);

            Land(snapshot, id, governance, Actions([2, governanceId, new object[0]], Builtin(true, false)), ref now);
            Assert.IsEmpty((Array)Success(snapshot, "getModule", [id, governanceId]));
            Assert.IsTrue(Account(snapshot, id)[5].GetBoolean());
            Assert.AreEqual(nonce + 1, Account(snapshot, id)[4].GetInteger());
        }

        [TestMethod]
        public void GovernanceInstallsReviewedHookAndRecoveryPolicyTogether()
        {
            var snapshot = Snapshot();
            UInt160 governance = Deploy(snapshot, "GovernanceModule"), hookContract = Deploy(snapshot, "WhitelistHook"), seat = Deploy(snapshot, "RecoveryModule");
            UInt160 id = Register(snapshot, [Install(snapshot, governance, Validator), Install(snapshot, seat, Recovery)]);
            BigInteger seatId = InstanceOf(snapshot, id, "recovery", seat);
            var prior = Account(snapshot, id);
            object[] actions = [Install(snapshot, hookContract, Hook, "allowTarget", NativeContract.GAS.Hash), Configure(seatId, RecoveryData([Guardian], Timelock))];
            BigInteger intent = Propose(snapshot, id, governance, actions, 1000);
            using (var refused = Confirm(snapshot, id, governance, intent, actions, 1000 + MaturityMs, [Stranger])) Refused(refused, "SA_UNAUTHORIZED");
            Assert.IsEmpty((Array)((Array)Success(snapshot, "getModules", [id, "hook", 0, 8]))[0]);
            Assert.IsEmpty((Array)Success(snapshot, "getRecoveryPolicySnapshot", [id], target: seat));

            Success(snapshot, "confirmConfiguration", [id, intent, actions], 1000 + MaturityMs, target: governance);
            var state = Account(snapshot, id);
            Assert.AreEqual(prior[4].GetInteger() + 1, state[4].GetInteger());
            Assert.AreEqual(BigInteger.Zero, state[7].GetInteger());
            BigInteger hook = InstanceOf(snapshot, id, "hook", hookContract);
            Assert.IsTrue(Success(snapshot, "isWhitelisted", [id, hook, NativeContract.GAS.Hash], target: hookContract).GetBoolean());
            Assert.AreEqual(Guardian, new UInt160(((Array)((Array)Success(snapshot, "getRecoveryPolicySnapshot", [id], target: seat))[0])[0].GetSpan()));
        }

        [TestMethod]
        public void ConfigurationBatchChecksItsLimitsAndDoesNotExpandRegistration()
        {
            var snapshot = Snapshot();
            UInt160 governance = Deploy(snapshot, "GovernanceModule");
            UInt160 id = Register(snapshot, [Install(snapshot, governance, Validator)]);
            object[] actions = Enumerable.Repeat(Builtin(true, false), 16).ToArray();
            var before = Account(snapshot, id);
            using (var stranger = Invoke(snapshot, "proposeConfiguration", [id, actions, new object[0]], signers: [Stranger], target: governance))
                Refused(stranger, "SA_UNAUTHORIZED");
            using (var tooMany = Invoke(snapshot, "proposeConfiguration", [id, actions.Append(Builtin(true, false)).ToArray(), new object[0]], target: governance))
                Refused(tooMany, "SA_MODULE_LIMIT_ACTIONS");
            foreach (object[] invalid in new[] { new object[0], actions.Append(Builtin(true, false)).ToArray(), new object[] { new object[] { 11 } }, new object[] { new object[] { 5, 1, false } } })
            {
                using var denied = Invoke(snapshot, "applyConfigurationActions", [id, invalid]);
                Assert.AreEqual(VMState.FAULT, denied.State, denied.FaultException?.ToString());
            }
            using (var nativeStranger = Invoke(snapshot, "applyConfigurationActions", [id, actions], signers: [Stranger])) Refused(nativeStranger, "SA_UNAUTHORIZED");
            Assert.IsEmpty(Pending(snapshot, id, governance));

            Success(snapshot, "proposeConfiguration", [id, actions, new object[0]], target: governance);
            Success(snapshot, "confirmConfiguration", [id, 1, actions], 1000 + MaturityMs, target: governance);
            Assert.AreEqual(before[4].GetInteger() + 1, ((Array)Success(snapshot, "getAccount", [id]))[4].GetInteger());

            byte[] salt = Enumerable.Repeat((byte)7, 32).ToArray();
            UInt160 other = SmartAccountProtocol.GetAccountId(Custody, salt);
            foreach (object[] group in new[] { new object[] { Builtin(true, false) }, new object[] { Configure(1, new object[0]) },
                new object[] { new object[] { 2, 1, new object[0] } }, new object[] { new object[] { 7, 1, true } } })
            {
                using var registration = Invoke(snapshot, "createAccount", [other, Custody, salt, group]);
                Refused(registration, "SA_OPERATION_MALFORMED");
                Assert.IsFalse(((Array)Success(snapshot, "getAccount", [other]))[0].GetBoolean());
            }
        }

        [TestMethod]
        public void CustodyProposalOfTheBuiltinSwitchesReturnsAnIntentAndLandsIt()
        {
            var snapshot = Snapshot();
            UInt160 governance = Deploy(snapshot, "GovernanceModule");
            UInt160 id = Register(snapshot, [Install(snapshot, governance, Validator)]);
            object[] actions = [Builtin(true, true)];
            BigInteger intent = Propose(snapshot, id, governance, actions, 1000);
            Assert.IsGreaterThan(BigInteger.Zero, intent);
            Assert.AreEqual(intent, Pending(snapshot, id, governance)[0].GetInteger());
            Success(snapshot, "confirmConfiguration", [id, intent, actions], 1000 + MaturityMs, target: governance);
            var account = Account(snapshot, id);
            Assert.IsTrue(account[5].GetBoolean());
            Assert.IsTrue(account[6].GetBoolean());
            Assert.IsEmpty(Pending(snapshot, id, governance));
        }

        [TestMethod]
        public void GovernanceDoesNotSignOperationsAndGovernanceInstalledWhitelistGatesCustody()
        {
            var snapshot = Snapshot();
            UInt160 governance = Deploy(snapshot, "GovernanceModule"), hookContract = Deploy(snapshot, "WhitelistHook");
            UInt160 id = Register(snapshot, [Install(snapshot, governance, Validator)]);
            BigInteger governanceId = InstanceOf(snapshot, id, "validator", governance);
            // The administration module is not an operation signer, even for a valid account query.
            var governanceOp = Operation(snapshot, id, NativeContract.GAS.Hash, "symbol", [], nonce: Nonce(snapshot, id, governanceId), validatorId: governanceId);
            using (var unsigned = Invoke(snapshot, "validateUserOp", [id, governanceOp])) Rejected(unsigned);
            using var unexecutable = Invoke(snapshot, "executeUserOp", [id, governanceOp], 1000);
            Refused(unexecutable, "SA_VALIDATION_REJECTED");

            ulong now = 1000;
            Land(snapshot, id, governance, [Install(snapshot, hookContract, Hook, "allowTarget", NativeContract.GAS.Hash)], ref now);
            var accepted = Operation(snapshot, id, NativeContract.GAS.Hash, "symbol", []);
            Assert.AreEqual("GAS", Success(snapshot, "executeUserOp", [id, accepted], now).GetString());
            var other = Operation(snapshot, id, NativeContract.NEO.Hash, "symbol", []);
            using var refused = Invoke(snapshot, "executeUserOp", [id, other], now);
            Assert.AreEqual(VMState.FAULT, refused.State);
            Assert.Contains("whitelist", refused.FaultException!.ToString().ToLowerInvariant());
        }
    }
}
