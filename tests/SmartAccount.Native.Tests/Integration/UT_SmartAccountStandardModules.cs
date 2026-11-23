using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo.Persistence;
using Neo.SmartContract.Native;
using Neo.VM;
using System;
using System.IO;
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
