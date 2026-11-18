using System.Numerics;
using Neo;
using Neo.SmartContract;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;

namespace SmartAccount
{
    /// <summary>
    /// v4 account registration (spec §16.1: registration identity is
    /// custody+salt, the full initial configuration installs atomically).
    ///
    /// The legacy single-pointer registration surfaces (RegisterAccount with
    /// verifier/hook pointers, UpdateHook/UpdateVerifier/Confirm*Update, the
    /// composite dependency registry, CallVerifier/CallHook and the pending
    /// module-call machinery) are removed with this rework: new code never
    /// routes through the old Verifier/HookId pointers (spec §7.4), and every
    /// module-model change now travels through the 24h configuration intents
    /// in SmartAccount.Intents.cs. The legacy registration identity helper is
    /// kept only because the platform registrar reuses it for deterministic
    /// platform-account ids that must survive the upgrade unchanged.
    /// </summary>
    public partial class SmartAccount
    {
        // ========================================================================
        // 1. Registration identity (spec §16.1: custody + salt)
        // ========================================================================

        // v4 account identity domain.
        private static readonly byte[] AccountIdentityDomainV4 = new byte[] { 0xAA, 0x52, 0x47, 0x04 };
        // Legacy (pre-v4) registration identity domain — retained for the
        // platform registrar's deterministic account ids only.
        private static readonly byte[] RegistrationAccountIdDomain = new byte[] { 0xAA, 0x52, 0x47, 0x01 };

        // 128 bytes covers both the user-chosen registration salt and the
        // platform registrar's app binding (which doubles as the salt).
        private static readonly BigInteger RegistrationSaltMinBytes = 1;
        private static readonly BigInteger RegistrationSaltMaxBytes = 128;

        /// <summary>
        /// Deterministic v4 account identity: RIPEMD160(SHA256(domain ||
        /// custody || salt)). The salt is attacker-free uniqueness material
        /// chosen by the custody; the identity binds the custody at creation.
        /// </summary>
        [Safe]
        public static UInt160 ComputeAccountIdentity(UInt160 custody, ByteString salt)
        {
            ExecutionEngine.Assert(custody != null && custody != UInt160.Zero, "Custody required");
            ExecutionEngine.Assert(salt != null && salt.Length >= RegistrationSaltMinBytes
                && salt.Length <= RegistrationSaltMaxBytes, "Invalid registration salt");
            byte[] payload = AccountIdentityDomainV4;
            payload = Helper.Concat(payload, (byte[])custody!);
            payload = Helper.Concat(payload, (byte[])salt!);
            byte[] hash = (byte[])CryptoLib.Ripemd160((ByteString)CryptoLib.Sha256((ByteString)payload));
            return (UInt160)(ByteString)ReverseBytes(hash);
        }

        /// <summary>
        /// Legacy registration identity (pre-v4). Retained ONLY for the
        /// platform registrar: registered platform account ids must remain
        /// stable across the v4 upgrade. Not a v4 authorization source.
        /// </summary>
        [Safe]
        public static UInt160 ComputeRegistrationAccountId(UInt160 verifier, ByteString verifierParams, UInt160 hookId, UInt160 backupOwner, uint escapeTimelock)
        {
            byte[] payload = RegistrationAccountIdDomain;
            payload = Helper.Concat(payload, ToRegistrationHashBytes(backupOwner));
            payload = Helper.Concat(payload, ToRegistrationHashBytes(verifier));
            payload = Helper.Concat(payload, ToRegistrationHashBytes(hookId));
            payload = Helper.Concat(payload, UInt32ToLittleEndianBytes(escapeTimelock));
            if (verifierParams != null && verifierParams.Length > 0)
            {
                payload = Helper.Concat(payload, (byte[])verifierParams);
            }

            byte[] hash = (byte[])CryptoLib.Ripemd160((ByteString)CryptoLib.Sha256((ByteString)payload));
            return (UInt160)(ByteString)ReverseBytes(hash);
        }

        private static byte[] UInt32ToLittleEndianBytes(uint value)
        {
            return new byte[]
            {
                (byte)(value & 0xFF),
                (byte)((value >> 8) & 0xFF),
                (byte)((value >> 16) & 0xFF),
                (byte)((value >> 24) & 0xFF)
            };
        }

        private static byte[] ToRegistrationHashBytes(UInt160 value)
        {
            return ReverseBytes((byte[])value);
        }

        private static byte[] ReverseBytes(byte[] source)
        {
            byte[] reversed = new byte[source.Length];
            for (int i = 0; i < source.Length; i++)
            {
                reversed[i] = source[source.Length - 1 - i];
            }
            return reversed;
        }

        // ========================================================================
        // 2. v4 registration (atomic initial install, spec §10 exception list)
        // ========================================================================

        /// <summary>
        /// Creates a fresh v4 account. Identity is custody+salt (spec §16.1);
        /// the initial configuration (module installs, hook order, threshold
        /// policies, message subjects, recovery policy) installs atomically
        /// with no timelock — a fresh account has no assets and no prior
        /// policy to protect. After registration every further change
        /// travels through the 24h intent path.
        /// </summary>
        public static void createAccount(UInt160 accountId, UInt160 custody, ByteString salt, BigInteger recoveryTimelockMs, object[] actions)
        {
            CreateAccountCore(accountId, custody, salt, recoveryTimelockMs, actions, true, null);
        }

        /// <summary>
        /// Batch v4 registration of plain accounts for a single custody: each
        /// salt becomes its own deterministic account with the default
        /// built-in route and no modules — module configuration afterwards
        /// always travels the 24h intent path. Atomic; one malformed entry
        /// reverts the whole batch.
        /// </summary>
        public static void createAccounts(UInt160[] accountIds, UInt160 custody, ByteString[] salts, BigInteger recoveryTimelockMs)
        {
            ExecutionEngine.Assert(accountIds != null && salts != null, "Account batch required");
            UInt160[] ids = accountIds!;
            ByteString[] saltList = salts!;
            ExecutionEngine.Assert(ids.Length > 0 && ids.Length <= 64, "Account batch size must be 1-64");
            ExecutionEngine.Assert(ids.Length == saltList.Length, "Account batch salts mismatch");
            for (int i = 0; i < ids.Length; i++)
            {
                CreateAccountCore(ids[i], custody, saltList[i], recoveryTimelockMs, new object[0], true, null);
            }
        }

        /// <summary>
        /// Shared v4 registration core. The custody witness is normally
        /// required; the platform registrar path is gated by the registrar
        /// pointer instead (caller identity) and pins its own legacy-derived
        /// expected id so platform identities stay stable.
        /// </summary>
        private static void CreateAccountCore(
            UInt160 accountId, UInt160 custody, ByteString salt, BigInteger recoveryTimelockMs,
            object[] actions, bool requireCustodyWitness, UInt160? expectedAccountId)
        {
            ValidateAccountId(accountId);
            ExecutionEngine.Assert(custody != null && custody != UInt160.Zero && custody.IsValid, "Custody required");
            if (requireCustodyWitness)
            {
                ExecutionEngine.Assert(Runtime.CheckWitness(custody!), "Custody witness required");
            }
            ExecutionEngine.Assert(salt != null && salt.Length >= RegistrationSaltMinBytes
                && salt.Length <= RegistrationSaltMaxBytes, "Invalid registration salt");

            // Neither a v4 control record nor a legacy row may exist.
            ExecutionEngine.Assert(GetAccountControl(accountId) == null, "Account already exists");
            ExecutionEngine.Assert(
                Storage.Get(Storage.CurrentContext, Helper.Concat(Prefix_AccountState, (byte[])accountId!)) == null,
                "Account already exists");
            AssertAccountConfigurationIdle(accountId!);

            UInt160 expected = expectedAccountId ?? ComputeAccountIdentity(custody!, salt!);
            ExecutionEngine.Assert(accountId == expected, "Account id does not match registration parameters");

            if (recoveryTimelockMs == 0) recoveryTimelockMs = RecoveryTimelockMinMs;
            ExecutionEngine.Assert(recoveryTimelockMs >= RecoveryTimelockMinMs && recoveryTimelockMs <= RecoveryTimelockMaxMs,
                "Recovery timelock must be 7-90 days");

            if (actions == null) actions = new object[0];
            ExecutionEngine.Assert(actions.Length <= MaxActionsPerConfigurationIntent, ErrorModuleLimitActions);
            for (int i = 0; i < actions.Length; i++)
            {
                ValidateActionShape((object[])actions[i]);
            }

            AccountControl control = new AccountControl();
            control.Status = AccountStatusActive;
            control.Custody = custody!;
            control.RecoveryAuthority = UInt160.Zero;
            control.AuthorityEpoch = BigInteger.One;
            control.ConfigurationNonce = BigInteger.Zero;
            control.NextModuleId = BigInteger.One;
            control.NextIntentId = BigInteger.One;
            // Built-in route (validatorId = 0) is authorized until the first
            // validator installs; ExecuteInstallModuleAction disables it then.
            control.DefaultOperationAuthorization = true;
            control.DefaultMessageAuthorization = true;
            control.RecoveryTimelockMs = recoveryTimelockMs;
            control.HookOrderRevision = BigInteger.Zero;
            control.DefaultPolicyRevision = BigInteger.Zero;
            control.ControlRevision = BigInteger.One;
            control.OwnerOnlyRecovery = false;
            PutAccountControl(accountId!, control);

            // Registration default message subject (spec §8): a fresh account
            // must carry a subject; the default slot value is unsatisfiable by
            // any canonical P-256 script until real subjects are configured.
            InitializeDefaultMessageSubjects(accountId!, control);

            // Atomic initial install — the same executors the 24h intent path
            // uses, so registration can never install anything the intent
            // path could not (same validation, same limits, same callbacks).
            if (actions.Length > 0)
            {
                ExecuteConfigurationActions(accountId!, control, actions!);
                // Last-validator rule (spec §10): a registered account with no
                // validator must keep the built-in operation route enabled.
                if (CountModulesOfType(accountId!, ModuleTypeCodeValidator) == 0)
                {
                    ExecutionEngine.Assert(control.DefaultOperationAuthorization, ErrorOperationMalformed);
                }
                control.ConfigurationNonce += 1;
                PutAccountControl(accountId!, control);
            }

            OnAccountRegistered(accountId!, custody!, UInt160.Zero, UInt160.Zero);
        }

        // ========================================================================
        // 3. Deployed-module manifest ABI helpers
        //    Retained for the TODO(26) plugin adaptation layer (profile /
        //    capability probing before callbacks). A marker alone is never
        //    enough: a stale or malicious module could advertise a method
        //    while omitting it, and missing-method faults are not catchable,
        //    so the full ABI shape is checked before any binding.
        // ========================================================================

        private static bool ModuleExposesSafeMethod(UInt160 module, string methodName, ContractParameterType returnType,
            params ContractParameterType[] parameterTypes)
        {
            Contract? deployed = ContractManagement.GetContract(module);
            if (deployed == null) return false;

            ContractMethodDescriptor[] methods = deployed.Manifest.Abi.Methods;
            for (int i = 0; i < methods.Length; i++)
            {
                ContractMethodDescriptor method = methods[i];
                if (!method.Safe || method.Name != methodName || method.ReturnType != returnType
                    || method.Parameters.Length != parameterTypes.Length) continue;
                bool parametersMatch = true;
                for (int j = 0; j < parameterTypes.Length; j++)
                {
                    if (method.Parameters[j].Type != parameterTypes[j])
                    {
                        parametersMatch = false;
                        break;
                    }
                }
                if (parametersMatch) return true;
            }
            return false;
        }

        private static bool ModuleExposesMethod(UInt160 module, string methodName, ContractParameterType returnType,
            params ContractParameterType[] parameterTypes)
        {
            Contract? deployed = ContractManagement.GetContract(module);
            if (deployed == null) return false;

            ContractMethodDescriptor[] methods = deployed.Manifest.Abi.Methods;
            for (int i = 0; i < methods.Length; i++)
            {
                ContractMethodDescriptor method = methods[i];
                if (method.Name != methodName || method.ReturnType != returnType
                    || method.Parameters.Length != parameterTypes.Length) continue;
                bool parametersMatch = true;
                for (int j = 0; j < parameterTypes.Length; j++)
                {
                    if (method.Parameters[j].Type != parameterTypes[j])
                    {
                        parametersMatch = false;
                        break;
                    }
                }
                if (parametersMatch)
                {
                    return true;
                }
            }
            return false;
        }
    }
}
