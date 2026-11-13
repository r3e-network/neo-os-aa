using System;
using System.Linq;
using System.Numerics;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Extensions;
using Neo.SmartContract;
using Neo.SmartContract.Testing.Exceptions;

namespace SmartAccount.Contracts.Tests;

/// <summary>
/// Phase 1b one-time storage migration: the legacy core-side pending platform owner
/// rotations (prefix 0x20) move into the AAPlatformRegistrar service through
/// migratePlatformOwnerRotations. The legacy rows are written directly into engine
/// storage, migrated, asserted gone, and a second run is rejected by the one-time
/// 0x2A flag. The seal is scan-based (audit High 1 / Medium 2): the flag is written
/// only after a prefix scan over the legacy family finds no row, so a batched
/// orchestration can never strand legacy rows behind an early seal.
/// </summary>
[TestClass]
public class PlatformOwnerRotationMigrationTests
{
    private static readonly UInt160 AppAdmin =
        UInt160.Parse("0x13ef519c362973f9a34648a9eac5b71250b2a80a");
    private static readonly UInt160 Stranger =
        UInt160.Parse("0x8f92a4d8a476a41c2b563c1f07e8f203e2c12345");
    private static readonly UInt160 RotatedOwner =
        UInt160.Parse("0x2233445566778899001122334455667788990011");

    private const uint EscapeTimelock = 2_592_000;

    private sealed class Harness
    {
        public RuntimeFixture Fx { get; } = new();
        public UInt160 Core { get; }
        public UInt160 Registrar { get; }
        public int CoreId { get; }

        public Harness()
        {
            Core = Fx.Deploy("SmartAccountV3");
            Registrar = Fx.Deploy("AAPlatformRegistrar", Core.ToArray());
            Fx.CallVoid(Core, "proposePlatformRegistrar", Registrar);
            Fx.AdvanceTime(TimeSpan.FromDays(7));
            Fx.CallVoid(Core, "confirmPlatformRegistrar");
            var record = (Neo.VM.Types.Array)Fx.Call(
                UInt160.Parse("0xfffdc93764dbaddd97c48f252a53ea4643faa3fd"), "getContract", Core);
            CoreId = (int)record[0].GetInteger();
        }

        public StorageKey Key(byte prefix, UInt160 accountId) => new()
        {
            Id = CoreId,
            Key = new[] { prefix }.Concat(accountId.ToArray()).ToArray()
        };

        public void SeedPendingRotation(UInt160 accountId, UInt160 newBackupOwner, BigInteger initiatedAt)
        {
            // The legacy PendingPlatformOwnerRotation model serializes as its field
            // values in declaration order: {NewBackupOwner, InitiatedAt}.
            byte[] pending = Fx.StdLibSerialize(new object[] { newBackupOwner, initiatedAt });
            Fx.Engine.Storage.Snapshot.Add(Key(0x20, accountId), new StorageItem(pending));
        }

        public UInt160 RegisterPlatformAccount(byte[] appBinding)
        {
            return Fx.CallUInt160(
                Registrar, "registerPlatformAccount", appBinding, AppAdmin, EscapeTimelock);
        }
    }

    [TestMethod]
    public void MigratePlatformOwnerRotations_MovesLegacyRowsOnce()
    {
        Harness h = new();
        byte[] appBinding = System.Text.Encoding.UTF8.GetBytes("neo-miniapps-platform:migration-source");
        UInt160 accountId = h.RegisterPlatformAccount(appBinding);

        BigInteger initiatedAt = h.Fx.Now();
        h.SeedPendingRotation(accountId, RotatedOwner, initiatedAt);

        // The migration is core-admin-gated; a stranger cannot run it.
        h.Fx.SetSigners(Stranger);
        TestException denied = Assert.ThrowsExactly<TestException>(() =>
            h.Fx.CallVoid(h.Core, "migratePlatformOwnerRotations", new object[] { new UInt160[] { accountId } }));
        StringAssert.Contains(denied.Message, "Not admin");

        h.Fx.SetSigners(h.Fx.Engine.ValidatorsAddress);
        h.Fx.CallVoid(h.Core, "migratePlatformOwnerRotations", new object[] { new UInt160[] { accountId } });

        // The legacy core row is gone and the registrar now owns the record.
        Assert.IsNull(h.Fx.Engine.Storage.Snapshot.TryGet(h.Key(0x20, accountId)));
        Neo.VM.Types.Array pending = (Neo.VM.Types.Array)h.Fx.Call(
            h.Registrar, "getPendingPlatformOwnerRotation", accountId);
        Assert.AreEqual(RotatedOwner, new UInt160(pending[0].GetSpan().ToArray()));
        Assert.AreEqual(AppAdmin, new UInt160(pending[1].GetSpan().ToArray()));
        Assert.AreEqual(initiatedAt, pending[2].GetInteger());
        Assert.AreEqual(initiatedAt + 7L * 24 * 60 * 60 * 1000, pending[3].GetInteger());

        // The one-time flag makes a second run strictly impossible.
        TestException repeat = Assert.ThrowsExactly<TestException>(() =>
            h.Fx.CallVoid(h.Core, "migratePlatformOwnerRotations", new object[] { new UInt160[] { accountId } }));
        StringAssert.Contains(repeat.Message, "Platform owner rotations already migrated");

        // A migrated record keeps its original InitiatedAt, so it cannot be re-armed:
        // after the original 7-day window it confirms with the new owner's witness.
        h.Fx.AdvanceTime(TimeSpan.FromDays(8));
        h.Fx.SetSigners(RotatedOwner);
        h.Fx.CallVoid(h.Registrar, "confirmPlatformAccountOwnerRotation", accountId, appBinding);
        Assert.AreEqual(RotatedOwner, h.Fx.CallUInt160(h.Core, "getBackupOwner", accountId));
    }

    [TestMethod]
    public void MigratePlatformOwnerRotations_SkipsAccountsWithoutLegacyRows()
    {
        Harness h = new();
        byte[] appBinding = System.Text.Encoding.UTF8.GetBytes("neo-miniapps-platform:migration-skip");
        UInt160 migrated = h.RegisterPlatformAccount(appBinding);
        UInt160 untouched = h.RegisterPlatformAccount(
            System.Text.Encoding.UTF8.GetBytes("neo-miniapps-platform:migration-skip-other"));

        h.SeedPendingRotation(migrated, RotatedOwner, h.Fx.Now());

        // The account without a legacy row is listed but simply skipped.
        h.Fx.CallVoid(h.Core, "migratePlatformOwnerRotations", new object[] { new UInt160[] { migrated, untouched } });
        Assert.IsNull(h.Fx.Engine.Storage.Snapshot.TryGet(h.Key(0x20, migrated)));
        Assert.IsNull(h.Fx.Engine.Storage.Snapshot.TryGet(h.Key(0x20, untouched)));
        Assert.AreEqual(Neo.VM.Types.StackItemType.Array,
            h.Fx.Call(h.Registrar, "getPendingPlatformOwnerRotation", migrated).Type);
        Assert.AreEqual(Neo.VM.Types.StackItemType.Any,
            h.Fx.Call(h.Registrar, "getPendingPlatformOwnerRotation", untouched).Type);

        // The whole run is one-shot: even un-migrated rows can never be picked up later.
        h.SeedPendingRotation(untouched, RotatedOwner, h.Fx.Now());
        TestException late = Assert.ThrowsExactly<TestException>(() =>
            h.Fx.CallVoid(h.Core, "migratePlatformOwnerRotations", new object[] { new UInt160[] { untouched } }));
        StringAssert.Contains(late.Message, "Platform owner rotations already migrated");
    }

    [TestMethod]
    public void MigratePlatformOwnerRotations_RequiresRegistrarPointerAndAccounts()
    {
        RuntimeFixture fixture = new();
        UInt160 wallet = fixture.Deploy("SmartAccountV3");

        // Without a confirmed registrar pointer the migration cannot run.
        TestException unconfigured = Assert.ThrowsExactly<TestException>(() =>
            fixture.CallVoid(wallet, "migratePlatformOwnerRotations", new object[] { new UInt160[] { AppAdmin } }));
        StringAssert.Contains(unconfigured.Message, "Platform registrar not set");

        UInt160 registrar = fixture.Deploy("AAPlatformRegistrar", wallet.ToArray());
        fixture.CallVoid(wallet, "proposePlatformRegistrar", registrar);
        fixture.AdvanceTime(TimeSpan.FromDays(7));
        fixture.CallVoid(wallet, "confirmPlatformRegistrar");

        // An empty account list is rejected.
        TestException empty = Assert.ThrowsExactly<TestException>(() =>
            fixture.CallVoid(wallet, "migratePlatformOwnerRotations", new object[] { new UInt160[] { } }));
        StringAssert.Contains(empty.Message, "No accounts to migrate");
    }

    [TestMethod]
    public void MigratePlatformOwnerRotations_SealsOnlyWhenTheScanFindsNoLegacyRow()
    {
        Harness h = new();
        byte[] firstBinding = System.Text.Encoding.UTF8.GetBytes("neo-miniapps-platform:migration-batch-a");
        byte[] secondBinding = System.Text.Encoding.UTF8.GetBytes("neo-miniapps-platform:migration-batch-b");
        UInt160 first = h.RegisterPlatformAccount(firstBinding);
        UInt160 second = h.RegisterPlatformAccount(secondBinding);
        BigInteger initiatedAt = h.Fx.Now();
        h.SeedPendingRotation(first, RotatedOwner, initiatedAt);
        h.SeedPendingRotation(second, RotatedOwner, initiatedAt);

        // The orchestration batches ~50 accounts per invocation (block gas limits). The
        // first batch migrates its own row but MUST NOT write the 0x2A seal while the
        // scan still finds the second account's row: under the old unconditional seal
        // every later batch faulted on entry and the remaining rows were stranded
        // forever, because the upgraded core never reads 0x20 again.
        h.Fx.SetSigners(h.Fx.Engine.ValidatorsAddress);
        h.Fx.CallVoid(h.Core, "migratePlatformOwnerRotations", new object[] { new UInt160[] { first } });
        Assert.IsNull(h.Fx.Engine.Storage.Snapshot.TryGet(h.Key(0x20, first)));
        Assert.IsNotNull(h.Fx.Engine.Storage.Snapshot.TryGet(h.Key(0x20, second)),
            "A later batch must still be able to pick up the remaining legacy row");
        Assert.IsFalse(h.Fx.CallBoolean(h.Core, "isPlatformOwnerRotationsMigrated"),
            "An intermediate batch must not seal while legacy rows remain");
        Assert.AreEqual(Neo.VM.Types.StackItemType.Any,
            h.Fx.Call(h.Registrar, "getPendingPlatformOwnerRotation", second).Type);

        // The batch that empties the legacy family writes the one-time flag.
        h.Fx.CallVoid(h.Core, "migratePlatformOwnerRotations", new object[] { new UInt160[] { second } });
        Assert.IsNull(h.Fx.Engine.Storage.Snapshot.TryGet(h.Key(0x20, second)));
        Assert.IsTrue(h.Fx.CallBoolean(h.Core, "isPlatformOwnerRotationsMigrated"));
        Assert.IsNotNull(h.Fx.Engine.Storage.Snapshot.TryGet(
            new StorageKey { Id = h.CoreId, Key = new byte[] { 0x2A } }),
            "The seal row must exist under the bare 0x2A key");

        // The seal stays strictly one-shot: no further run is accepted.
        TestException repeat = Assert.ThrowsExactly<TestException>(() =>
            h.Fx.CallVoid(h.Core, "migratePlatformOwnerRotations", new object[] { new UInt160[] { second } }));
        StringAssert.Contains(repeat.Message, "Platform owner rotations already migrated");
    }

    [TestMethod]
    public void MigratePlatformOwnerRotations_UnlistedRowsBlockTheSealUntilMigrated()
    {
        Harness h = new();
        byte[] listedBinding = System.Text.Encoding.UTF8.GetBytes("neo-miniapps-platform:migration-unlisted");
        byte[] unlistedBinding = System.Text.Encoding.UTF8.GetBytes("neo-miniapps-platform:migration-unlisted-other");
        UInt160 listed = h.RegisterPlatformAccount(listedBinding);
        UInt160 unlisted = h.RegisterPlatformAccount(unlistedBinding);
        h.SeedPendingRotation(listed, RotatedOwner, h.Fx.Now());
        h.SeedPendingRotation(unlisted, RotatedOwner, h.Fx.Now());

        // A batch whose list does not cover the remaining rows returns unsealed, so an
        // under-covering account list cannot strand what it did not name.
        h.Fx.SetSigners(h.Fx.Engine.ValidatorsAddress);
        h.Fx.CallVoid(h.Core, "migratePlatformOwnerRotations", new object[] { new UInt160[] { listed } });
        Assert.IsFalse(h.Fx.CallBoolean(h.Core, "isPlatformOwnerRotationsMigrated"));

        // The catch-up batch migrates the remaining row and seals.
        h.Fx.CallVoid(h.Core, "migratePlatformOwnerRotations", new object[] { new UInt160[] { unlisted } });
        Assert.IsNull(h.Fx.Engine.Storage.Snapshot.TryGet(h.Key(0x20, unlisted)));
        Assert.IsTrue(h.Fx.CallBoolean(h.Core, "isPlatformOwnerRotationsMigrated"));
    }

    [TestMethod]
    public void MigratePlatformOwnerRotations_SealsWhenNoLegacyRowExistsAtAll()
    {
        Harness h = new();
        byte[] appBinding = System.Text.Encoding.UTF8.GetBytes("neo-miniapps-platform:migration-empty");
        UInt160 accountId = h.RegisterPlatformAccount(appBinding);

        // The seal is derived from storage, not from the amount of work this batch did:
        // with the legacy family already empty, even a batch that migrates nothing
        // writes the flag, which keeps the flag exactly equivalent to "0x20 is drained".
        h.Fx.SetSigners(h.Fx.Engine.ValidatorsAddress);
        h.Fx.CallVoid(h.Core, "migratePlatformOwnerRotations", new object[] { new UInt160[] { accountId } });
        Assert.IsTrue(h.Fx.CallBoolean(h.Core, "isPlatformOwnerRotationsMigrated"));
    }

    [TestMethod]
    public void RegistrarIngestRejectsNonCoreCallers()
    {
        Harness h = new();
        byte[] appBinding = System.Text.Encoding.UTF8.GetBytes("neo-miniapps-platform:ingest-guard");
        UInt160 accountId = h.RegisterPlatformAccount(appBinding);

        // Only the authorized core may ingest; a direct transaction-level caller is
        // rejected before any state is written.
        TestException direct = Assert.ThrowsExactly<TestException>(() =>
            h.Fx.CallVoid(h.Registrar, "ingestPendingPlatformOwnerRotation",
                accountId, appBinding, RotatedOwner, AppAdmin, (BigInteger)h.Fx.Now()));
        StringAssert.Contains(direct.Message, "Unauthorized caller");
        Assert.AreEqual(Neo.VM.Types.StackItemType.Any,
            h.Fx.Call(h.Registrar, "getPendingPlatformOwnerRotation", accountId).Type);
    }
}
