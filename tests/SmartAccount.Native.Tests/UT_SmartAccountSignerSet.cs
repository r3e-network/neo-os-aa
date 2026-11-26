//
// UT_SmartAccountSignerSet.cs file belongs to the neo project and is free
// software distributed under the MIT software license, see the
// accompanying file LICENSE in the main directory of the
// repository or http://www.opensource.org/licenses/mit-license.php
// for more details.
//
// Redistribution and use in source and binary forms with or without
// modifications are permitted.
//

using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo.Extensions;
using Neo.Ledger;
using Neo.Network.P2P;
using Neo.Network.P2P.Payloads;
using Neo.Network.P2P.Payloads.Conditions;
using Neo.Persistence;
using Neo.SmartContract;
using Neo.SmartContract.Manifest;
using Neo.SmartContract.Native;
using Neo.UnitTests;
using Neo.UnitTests.Extensions;
using Neo.VM;
using Neo.VM.Types;
using System;
using System.Linq;
using System.Numerics;
using Array = Neo.VM.Types.Array;
using static Neo.UnitTests.SmartContract.Native.UT_SmartAccount;

namespace Neo.UnitTests.SmartContract.Native
{
    /// <summary>
    /// The witness verification of a native execution transaction with the
    /// signer set the JS SDK builds (sdk/js/src/native/transaction.js and
    /// shared/proxyWitness.mjs): index 0 the fee payer wallet, index 1 the
    /// account proxy carrying the single Allow/CalledByContract(core) rule and
    /// a witness without a signature. What authorizes the envelope is the
    /// operation signature verified once, inside the core's <c>executeUserOp</c>;
    /// the witness check only admits the envelope. Every witness runs under the
    /// platform's default verification cap (see <see cref="VerificationGas"/>),
    /// through the node's own witness verification path. The tests also pin what
    /// the kernel does with broader or wrong scopes.
    /// </summary>
    [TestClass]
    public class UT_SmartAccountSignerSet
    {
        /// <summary>The cap the platform applies to every witness engine; no test here raises it.</summary>
        private const long VerificationGas = Neo.SmartContract.Helper.MaxVerificationGas;
        private static readonly UInt160 Core = NativeContract.SmartAccount.Hash;
        private static readonly UInt160 Token = NativeContract.GAS.Hash;
        private static readonly UInt160 Next = UInt160.Parse("0x0303030303030303030303030303030303030303");

        /// <summary>
        /// The proxy signer of an execution plan: the scope and rule the SDK
        /// publishes, or a variant of it under test.
        /// </summary>
        private static Signer ProxySigner(UInt160 address, string variant)
        {
            WitnessRule Rule(UInt160 contract) => new()
            {
                Action = WitnessRuleAction.Allow, Condition = new CalledByContractCondition { Hash = contract },
            };
            return variant switch
            {
                "sdk" => new Signer { Account = address, Scopes = WitnessScope.WitnessRules, Rules = [Rule(Core)] },
                "wrong-contract" => new Signer { Account = address, Scopes = WitnessScope.WitnessRules, Rules = [Rule(Token)] },
                "no-rule" => new Signer { Account = address, Scopes = WitnessScope.WitnessRules, Rules = [] },
                "none" => new Signer { Account = address, Scopes = WitnessScope.None },
                "global" => new Signer { Account = address, Scopes = WitnessScope.Global },
                _ => throw new ArgumentOutOfRangeException(nameof(variant)),
            };
        }

        /// <summary>
        /// The transaction of an execution plan, with the network fee the node
        /// quotes for its two witnesses: the fee payer wallet at index 0 (scope
        /// None when no authority is needed, scoped to the core otherwise), the
        /// proxy at index 1, the canonical envelope as the script. The network
        /// fee is part of the signing data, so the node quotes it first and the
        /// payer wallet signs last, as the SDK does.
        /// </summary>
        private static Transaction Execution(DataCache snapshot, UInt160 id, object[] operation,
            string proxyScope = "sdk", string payerScope = "none")
        {
            UInt160 address = SmartAccountProtocol.GetAccountAddress(id);
            byte[] envelope = SmartAccountTestSupport.ExecuteUserOp(id, (Array)Item(operation));
            var tx = new Transaction
            {
                Version = 0, Script = envelope, Attributes = [],
                Signers =
                [
                    new Signer
                    {
                        Account = Custody,
                        Scopes = payerScope == "none" ? WitnessScope.None
                            : payerScope == "global" ? WitnessScope.Global : WitnessScope.CustomContracts,
                        AllowedContracts = payerScope == "custom" ? [Core] : [],
                    },
                    ProxySigner(address, proxyScope),
                ],
                Witnesses =
                [
                    new Witness(),
                    new Witness
                    {
                        InvocationScript = ReadOnlyMemory<byte>.Empty,
                        VerificationScript = SmartAccountProtocol.CreateVerificationScript(id).ToArray(),
                    },
                ],
            };
            Sign(tx);
            tx.NetworkFee = Neo.Wallets.Helper.CalculateNetworkFee(tx, snapshot, Settings);
            Sign(tx);
            return tx;
        }

        /// <summary>The signature witness of the fee payer wallet over the transaction as it stands.</summary>
        private static void Sign(Transaction tx)
        {
            using var builder = new ScriptBuilder();
            builder.EmitPush(Neo.Cryptography.Crypto.Sign(tx.GetSignData(Settings.Network), CustodyKey, Neo.Cryptography.HashAlgorithm.SHA256));
            tx.Witnesses[0] = new Witness
            {
                InvocationScript = builder.ToArray(),
                VerificationScript = Contract.CreateSignatureRedeemScript(CustodyKey.PublicKey).ToArray(),
            };
        }

        private static StackItem Item(object value) => value switch
        {
            object[] items => new Array(items.Select(Item).ToArray()),
            BigInteger number => new Integer(number),
            int number => new Integer(number),
            string text => new ByteString(System.Text.Encoding.UTF8.GetBytes(text)),
            byte[] bytes => new ByteString(bytes),
            bool flag => flag ? StackItem.True : StackItem.False,
            UInt160 hash => new ByteString(hash.ToArray()),
            StackItem item => item,
            null => StackItem.Null,
            _ => throw new ArgumentException(value.GetType().Name),
        };

        private static UInt160 FundedAccount(DataCache snapshot)
        {
            UInt160 id = Register(snapshot);
            UInt160 address = SmartAccountProtocol.GetAccountAddress(id);
            UInt160 funder = Contract.GetBFTAddress(Settings.StandbyValidators);
            Success(snapshot, "transfer", [funder, address, 7, null], signers: [funder], target: Token);
            return id;
        }

        private static BigInteger Balance(DataCache snapshot, UInt160 owner) =>
            Success(snapshot, "balanceOf", [owner], target: Token).GetInteger();

        private static BigInteger Sequence(DataCache snapshot, UInt160 id) =>
            Success(snapshot, "getNonce", [id, 0, new byte[32]]).GetInteger() & ((BigInteger.One << 64) - 1);

        [TestMethod]
        public void SdkShapedSignerSetPassesWitnessVerificationAndExecutesTheEnvelope()
        {
            var snapshot = Snapshot();
            UInt160 id = FundedAccount(snapshot), address = SmartAccountProtocol.GetAccountAddress(id);
            Transaction tx = Execution(snapshot, id, Operation(snapshot, id, Token, "transfer", [address, Next, 3, null],
                deadline: BigInteger.One << 62));

            Assert.IsTrue(tx.VerifyWitnesses(Settings, snapshot, VerificationGas), "the node accepts both witnesses");
            Assert.AreEqual(VerifyResult.Succeed, tx.VerifyStateIndependent(Settings), "the transaction passes the node's own checks");
            Assert.IsTrue(Neo.SmartContract.Helper.VerifyWitness(tx, Settings, snapshot, address, tx.Witnesses[1], VerificationGas, out long fee));
            Assert.IsGreaterThan(0L, fee, "the proxy witness pays for the core's witness check");
            Assert.IsLessThan(VerificationGas, fee, "the proxy witness fits the platform cap");
            UInt160 other = SmartAccountProtocol.GetAccountAddress(SmartAccountProtocol.GetAccountId(Custody, Enumerable.Repeat((byte)9, 32).ToArray()));
            Assert.IsFalse(Neo.SmartContract.Helper.VerifyWitness(tx, Settings, snapshot, other, tx.Witnesses[1], VerificationGas, out _),
                "a proxy witness is bound to its own account address");

            using var engine = Invoke(snapshot, tx);
            Assert.AreEqual(VMState.HALT, engine.State, engine.FaultException?.ToString());
            Assert.IsTrue(engine.ResultStack.Peek().GetBoolean());
            Assert.AreEqual(3, Balance(snapshot, Next));
            Assert.AreEqual(4, Balance(snapshot, address));
            Assert.AreEqual(1, Sequence(snapshot, id));
        }

        [TestMethod]
        public void AnUnsignedOperationPassesTheWitnessCheckAndIsRejectedByTheExecution()
        {
            // The witness check admits the envelope only; the signature is
            // verified once, by executeUserOp, which refuses and rolls back.
            var snapshot = Snapshot();
            UInt160 id = FundedAccount(snapshot), address = SmartAccountProtocol.GetAccountAddress(id);
            Transaction tx = Execution(snapshot, id, Operation(snapshot, id, Token, "transfer", [address, Next, 3, null],
                deadline: BigInteger.One << 62, sign: false));

            Assert.IsTrue(Neo.SmartContract.Helper.VerifyWitness(tx, Settings, snapshot, address, tx.Witnesses[1], VerificationGas, out _),
                "the witness check answers admissibility, never the signature");
            Assert.IsTrue(tx.VerifyWitnesses(Settings, snapshot, VerificationGas));
            Assert.AreEqual(VerifyResult.Succeed, tx.VerifyStateIndependent(Settings));
            using var engine = Invoke(snapshot, tx);
            Assert.AreEqual(VMState.FAULT, engine.State);
            Assert.Contains("SA_", engine.FaultException!.ToString());
            Assert.AreEqual(0, Balance(snapshot, Next));
            Assert.AreEqual(0, Sequence(snapshot, id));
        }

        [TestMethod]
        public void TheProxyWitnessMustBeTheProxyVerificationScript()
        {
            var snapshot = Snapshot();
            UInt160 id = FundedAccount(snapshot);
            Transaction tx = Execution(snapshot, id, Operation(snapshot, id, Token, "symbol", [],
                deadline: BigInteger.One << 62));
            // A signature script under the proxy's signer: its hash is not the proxy address.
            tx.Witnesses[1] = new Witness
            {
                InvocationScript = ReadOnlyMemory<byte>.Empty,
                VerificationScript = Contract.CreateSignatureRedeemScript(CustodyKey.PublicKey).ToArray(),
            };
            Assert.IsFalse(tx.VerifyWitnesses(Settings, snapshot, VerificationGas));
        }

        /// <summary>
        /// Under the Application trigger <c>verify</c> is not a witness oracle: it answers only the account's proxy
        /// script, and only when that proxy frame is called directly by the target frame of the account's own
        /// authorized dispatch. The core asked directly, or the proxy run by anyone else, is unauthorized.
        /// </summary>
        [TestMethod]
        public void VerifyUnderTheApplicationTriggerAnswersOnlyTheProxyInsideItsOwnDispatch()
        {
            var snapshot = Snapshot();
            UInt160 id = Register(snapshot), address = SmartAccountProtocol.GetAccountAddress(id);
            // The proxy script deployed as a contract, so a target can call it: its hash is the proxy address.
            var proxy = TestUtils.GetContract(SmartAccountProtocol.CreateVerificationScript(id),
                TestUtils.CreateManifest("verify", ContractParameterType.Boolean));
            Assert.AreEqual(address, proxy.Hash);
            snapshot.AddContract(proxy.Hash, proxy);

            // The core asked directly: the caller is not the proxy script.
            using (var direct = Invoke(snapshot, "verify", [id]))
            {
                Assert.AreEqual(VMState.FAULT, direct.State);
                Assert.Contains(SmartAccountModuleProtocol.ErrorUnauthorized, direct.FaultException!.ToString());
            }
            // The proxy script run by the transaction: the right caller, but no dispatch of this account behind it.
            using (var outside = Invoke(snapshot, "verify", [], target: address))
            {
                Assert.AreEqual(VMState.FAULT, outside.State);
                Assert.Contains(SmartAccountModuleProtocol.ErrorUnauthorized, outside.FaultException!.ToString());
            }
            // The same proxy, called as the target of the account's own signed operation.
            Assert.IsTrue(Success(snapshot, "executeUserOp",
                [id, Operation(snapshot, id, address, "verify", [])]).GetBoolean());
        }

        [TestMethod]
        [DataRow("sdk")]
        [DataRow("wrong-contract")]
        [DataRow("no-rule")]
        [DataRow("none")]
        [DataRow("global")]
        public void TheProxyScopeIsNotWhatAuthorizesTheEnvelope(string proxyScope)
        {
            // The kernel never answers a proxy CheckWitness through scopes: the
            // witness is the core's verify of the signed envelope. A wrong or
            // broader scope therefore neither helps nor hurts the shaped script.
            var snapshot = Snapshot();
            UInt160 id = FundedAccount(snapshot), address = SmartAccountProtocol.GetAccountAddress(id);
            Transaction tx = Execution(snapshot, id, Operation(snapshot, id, Token, "transfer", [address, Next, 3, null],
                deadline: BigInteger.One << 62), proxyScope);
            Assert.IsTrue(tx.VerifyWitnesses(Settings, snapshot, VerificationGas), proxyScope);
            using var engine = Invoke(snapshot, tx);
            Assert.AreEqual(VMState.HALT, engine.State, proxyScope);
            Assert.AreEqual(3, Balance(snapshot, Next), proxyScope);
            Assert.AreEqual(1, Sequence(snapshot, id), proxyScope);
        }

        [TestMethod]
        [DataRow("none")]
        [DataRow("custom")]
        [DataRow("global")]
        public void TheFeePayerScopeDoesNotAffectAnExecutionSignedInsideTheOperation(string payerScope)
        {
            var snapshot = Snapshot();
            UInt160 id = FundedAccount(snapshot), address = SmartAccountProtocol.GetAccountAddress(id);
            Transaction tx = Execution(snapshot, id, Operation(snapshot, id, Token, "transfer", [address, Next, 3, null],
                deadline: BigInteger.One << 62), payerScope: payerScope);
            Assert.IsTrue(tx.VerifyWitnesses(Settings, snapshot, VerificationGas), payerScope);
            using var engine = Invoke(snapshot, tx);
            Assert.AreEqual(VMState.HALT, engine.State, payerScope);
            Assert.AreEqual(3, Balance(snapshot, Next), payerScope);
        }

        [TestMethod]
        [DataRow("sdk")]
        [DataRow("global")]
        public void TheProxyScopeNeverAuthorizesADirectTransferFromTheProxyAddress(string proxyScope)
        {
            // Outside a shaped envelope the proxy is not a witness of anything:
            // the token asks, the kernel answers false, and nothing moves.
            var snapshot = Snapshot();
            UInt160 id = FundedAccount(snapshot), address = SmartAccountProtocol.GetAccountAddress(id);
            Transaction tx = Execution(snapshot, id, Operation(snapshot, id, Token, "transfer", [address, Next, 3, null],
                deadline: BigInteger.One << 62), proxyScope);
            using var direct = new ScriptBuilder();
            direct.Emit(OpCode.PUSHNULL).EmitPush(3).EmitPush(Next).EmitPush(address).EmitPush(4).Emit(OpCode.PACK)
                .EmitPush((int)CallFlags.All).EmitPush("transfer").EmitPush(Token).EmitSysCall(ApplicationEngine.System_Contract_Call);
            tx.Script = direct.ToArray();
            tx.Witnesses[0] = new Witness
            {
                InvocationScript = new ScriptBuilder().EmitPush(Neo.Cryptography.Crypto.Sign(tx.GetSignData(Settings.Network), CustodyKey,
                    Neo.Cryptography.HashAlgorithm.SHA256)).ToArray(),
                VerificationScript = Contract.CreateSignatureRedeemScript(CustodyKey.PublicKey).ToArray(),
            };

            using var engine = Invoke(snapshot, tx);
            Assert.AreEqual(VMState.HALT, engine.State, proxyScope);
            Assert.IsFalse(engine.ResultStack.Peek().GetBoolean(), proxyScope);
            Assert.AreEqual(0, Balance(snapshot, Next), proxyScope);
            Assert.AreEqual(7, Balance(snapshot, address), proxyScope);
            Assert.AreEqual(0, Sequence(snapshot, id), proxyScope);
        }
    }
}
