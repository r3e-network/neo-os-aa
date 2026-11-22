using System.ComponentModel;
using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Services;

namespace SmartAccount.Mocks
{
    /// <summary>
    /// Test-only NEP-17 token that models real token accounting: balances keyed by holder, a
    /// boolean <c>transfer</c> and the NEP-17 payment callback for contract recipients.
    /// </summary>
    /// <remarks>
    /// It can additionally be put into one of the adversarial modes a smart-account suite must
    /// survive: move-then-return-false, move-then-fault, and move-then-reenter. The token accepts
    /// a source that is either a witness of the transaction or the configured trusted caller (the
    /// account core), because a virtual account holds its assets at the core-derived proxy
    /// address, which is a contract and can never sign.
    /// </remarks>
    [DisplayName("MockNep17Token")]
    [ContractPermission("*", "*")]
    [ManifestExtra("Description", "Test-only NEP-17 token with adversarial transfer modes")]
    public class MockNep17Token : SmartContract
    {
        /// <summary>Complete NEP-17 behaviour: debit, credit, payment callback, return true.</summary>
        private const int ModeNormal = 0;

        /// <summary>Moves the value but answers false (a business failure, not a rollback).</summary>
        private const int ModeReturnFalse = 1;

        /// <summary>Moves the value and then faults, which reverts the whole sub-call.</summary>
        private const int ModeFault = 2;

        /// <summary>Moves the value, then calls a caller-supplied contract during the transfer.</summary>
        private const int ModeReenter = 3;

        private static StorageMap Balances => new(Storage.CurrentContext, 1);

        private static readonly byte[] Prefix_Admin = new byte[] { 0xF0 };
        private static readonly byte[] Prefix_Mode = new byte[] { 0xF1 };
        private static readonly byte[] Prefix_TrustedCaller = new byte[] { 0xF2 };
        private static readonly byte[] Prefix_PaymentReceiver = new byte[] { 0xF3 };

        public static void _deploy(object data, bool update)
        {
            if (update) return;
            Storage.Put(Storage.CurrentContext, Prefix_Admin, Runtime.Transaction.Sender);
            if (data != null)
            {
                UInt160 seed = (UInt160)data;
                if (seed.IsValid && seed != UInt160.Zero) Balances.Put(seed, 1000);
            }
        }

        // ---- NEP-17 surface ----

        [Safe]
        public static string Symbol() => "MN17";

        [Safe]
        public static BigInteger Decimals() => 8;

        [Safe]
        public static BigInteger TotalSupply() => 0;

        [Safe]
        public static BigInteger BalanceOf(UInt160 account)
        {
            ByteString? value = Balances.Get(account);
            return value == null ? 0 : (BigInteger)value;
        }

        public static bool Transfer(UInt160 from, UInt160 to, BigInteger amount, object data)
        {
            ExecutionEngine.Assert(from != null && from.IsValid && from != UInt160.Zero, "Invalid mock source");
            ExecutionEngine.Assert(to != null && to.IsValid && to != UInt160.Zero, "Invalid mock recipient");
            ExecutionEngine.Assert(amount >= 0, "Negative mock amount");
            ExecutionEngine.Assert(
                Runtime.CheckWitness(from) || Runtime.CallingScriptHash == TrustedCaller(),
                "Mock source witness required");

            BigInteger before = BalanceOf(from);
            ExecutionEngine.Assert(before >= amount, "Insufficient mock balance");
            Balances.Put(from, before - amount);
            Balances.Put(to, BalanceOf(to) + amount);
            NotifyPayment(from, to, amount, data);

            BigInteger mode = Mode();
            if (mode == ModeReturnFalse) return false;
            if (mode == ModeFault) ExecutionEngine.Assert(false, "Mock NEP-17 transfer failed");
            if (mode == ModeReenter) Reenter(data);
            return true;
        }

        // ---- Test configuration (admin = deployer) ----

        public static void Mint(UInt160 to, BigInteger amount)
        {
            RequireAdmin();
            ExecutionEngine.Assert(to != null && to.IsValid && to != UInt160.Zero, "Invalid mock recipient");
            ExecutionEngine.Assert(amount >= 0, "Negative mock amount");
            Balances.Put(to, BalanceOf(to) + amount);
        }

        public static void SetMode(BigInteger mode)
        {
            RequireAdmin();
            ExecutionEngine.Assert(mode >= ModeNormal && mode <= ModeReenter, "Invalid mock mode");
            Storage.Put(Storage.CurrentContext, Prefix_Mode, mode);
        }

        public static void SetTrustedCaller(UInt160 caller)
        {
            RequireAdmin();
            ExecutionEngine.Assert(caller != null && caller.IsValid && caller != UInt160.Zero, "Invalid mock caller");
            Storage.Put(Storage.CurrentContext, Prefix_TrustedCaller, caller);
        }

        public static void SetPaymentReceiver(UInt160 receiver)
        {
            RequireAdmin();
            ExecutionEngine.Assert(receiver != null && receiver.IsValid && receiver != UInt160.Zero, "Invalid mock receiver");
            Storage.Put(Storage.CurrentContext, Prefix_PaymentReceiver, receiver);
        }

        // ---- Internals ----

        private static BigInteger Mode()
        {
            ByteString? value = Storage.Get(Storage.CurrentContext, Prefix_Mode);
            return value == null ? ModeNormal : (BigInteger)value;
        }

        private static UInt160 TrustedCaller()
        {
            ByteString? value = Storage.Get(Storage.CurrentContext, Prefix_TrustedCaller);
            return value == null ? UInt160.Zero : (UInt160)value;
        }

        /// <summary>NEP-17 requires the recipient contract to be told about a payment.</summary>
        private static void NotifyPayment(UInt160 from, UInt160 to, BigInteger amount, object data)
        {
            ByteString? configured = Storage.Get(Storage.CurrentContext, Prefix_PaymentReceiver);
            if (configured == null || (UInt160)configured! != to) return;
            Contract.Call(to, "onNEP17Payment", CallFlags.All, new object[] { from, amount, data });
        }

        /// <summary>
        /// Re-enters a caller-supplied contract in the middle of the transfer. <paramref name="data"/>
        /// carries <c>[target, method, args]</c>, so a suite can aim the re-entry at the very
        /// callback surface the account is currently executing.
        /// </summary>
        private static void Reenter(object data)
        {
            object[] plan = (object[])data;
            ExecutionEngine.Assert(plan != null && plan.Length == 3, "Invalid mock re-entry plan");
            Contract.Call((UInt160)plan[0], (string)plan[1], CallFlags.All, (object[])plan[2]);
        }

        private static void RequireAdmin()
        {
            ByteString? admin = Storage.Get(Storage.CurrentContext, Prefix_Admin);
            ExecutionEngine.Assert(admin != null && (UInt160)admin! != UInt160.Zero, "Mock admin not set");
            ExecutionEngine.Assert(Runtime.CheckWitness((UInt160)admin!), "Mock admin required");
        }
    }
}
