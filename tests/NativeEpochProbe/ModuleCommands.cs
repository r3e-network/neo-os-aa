using System.Numerics;
using System.Text.Json;
using Neo;
using Neo.Extensions;
using Neo.IO;
using Neo.SmartContract.Testing.Exceptions;
using SmartAccount.Contracts.Tests;

internal static class ModuleCommands
{
    // This fixture supplies the module's caller, phase and generation. It does not
    // exercise native admission or the governance delay.
    internal static int Check(string modules, string fixturePrefix, string catalog)
    {
        using var doc = JsonDocument.Parse(File.ReadAllBytes(catalog));
        var fx = new RuntimeFixture();
        UInt160 Deploy(string prefix, object? data = null) => fx.DeployArtifact(
            File.ReadAllBytes(prefix + ".nef"), File.ReadAllText(prefix + ".manifest.json"), data);
        UInt160 core = Deploy(fixturePrefix);
        var account = UInt160.Parse("0x1111111111111111111111111111111111111111");
        var installAccount = UInt160.Parse("0x2222222222222222222222222222222222222222");
        var expiry = fx.Now() + 3_600_000;
        const int amount = 7, period = 3600, sessionCap = 23;
        var key = new P256SessionKey().CompressedPublicKey;
        object Sample(string field) => field switch
        {
            "publicKey:ByteArray" or "signerPublicKey:ByteArray" => key,
            "masterNullifier:ByteArray" or "claimCommitment:ByteArray" => new byte[32],
            "id:ByteArray" or "provider:ByteArray" => new byte[] { 1 },
            "validUntil:Integer" => expiry,
            "merchant:Hash160" => account,
            "amount:Integer" => amount,
            "periodSeconds:Integer" => period,
            "spendingLimit:Integer" => sessionCap,
            "signers:Hash160[]" => new object[] { account },
            "method:String" => "transfer",
            _ when field.EndsWith(":String", StringComparison.Ordinal) => "example",
            _ when field.EndsWith(":Boolean", StringComparison.Ordinal) => true,
            _ when field.EndsWith(":Integer", StringComparison.Ordinal) => 1,
            _ when field.EndsWith(":Hash160", StringComparison.Ordinal) => fx.GasHash,
            _ => throw new InvalidDataException("No sample for " + field)
        };
        foreach (var id in new[] { account, installAccount })
        {
            fx.CallVoid(core, "setAuthorizedModuleId", id, 6, 1);
            fx.CallVoid(core, "setModuleGeneration", id, 1, 1);
        }
        int passed = 0, rejectedTypes = 0, installs = 0, removals = 0;
        foreach (var entry in doc.RootElement.EnumerateObject())
        {
            var commands = entry.Value.GetProperty("commands");
            var forms = entry.Value.GetProperty("installData").EnumerateArray().Select(x => x.GetString()).ToArray();
            int kind = entry.Value.GetProperty("moduleType").GetString() switch
            {
                "validator" => 1, "hook" => 4, "recovery" => 5, _ => throw new InvalidDataException(entry.Name)
            };
            UInt160 module = Deploy(Path.Combine(modules, entry.Name, entry.Name), core.ToArray());
            void Forward(object[] data, string callback = "configure") => fx.CallVoid(core, "forward", module, callback,
                new object[] { callback == "onInstall" ? installAccount : account, 1, kind, data });
            void RefuseInstall(object[] data, string? expected = null)
            {
                try { Forward(data, "onInstall"); }
                catch (TestException e) when (expected is null || e.Message.Contains(expected, StringComparison.Ordinal)) { return; }
                throw new InvalidDataException(entry.Name + " accepted invalid installation data");
            }
            if (forms.Contains("empty")) Forward([], "onInstall");
            else RefuseInstall([], entry.Name);
            RefuseInstall(["unknownInstallCommand"]);
            if (forms.Contains("hookOrder"))
            {
                Forward([new object[] { 2, 5 }], "onInstall");
                RefuseInstall([new object[] { 5, 2 }]);
                RefuseInstall([new object[] { 2 }]);
                RefuseInstall([new object[] { new byte[] { 2 }, 5 }]);
                RefuseInstall([2, 5]);
            }
            installs++;
            foreach (var command in commands.EnumerateObject())
            {
                string label = entry.Name + "." + command.Name;
                var data = command.Value.EnumerateArray().Select(f => Sample(f.GetString()!))
                    .Prepend((object)command.Name).ToArray();
                try
                {
                    Forward(data.Append((object)0).ToArray());
                    throw new InvalidDataException(label + " accepted a trailing parameter");
                }
                catch (TestException e) when (e.Message.Contains("Invalid config arguments", StringComparison.Ordinal)) { }
                // Preserve the numeric value: rejecting an out-of-range value is
                // insufficient evidence that the module enforced the wire type.
                int index = 0;
                foreach (var field in command.Value.EnumerateArray())
                {
                    index++;
                    string type = field.GetString()!.Split(':')[1];
                    if (type is not ("Integer" or "Boolean")) continue;
                    object[] wrong = (object[])data.Clone();
                    wrong[index] = type == "Boolean" ? (object)1 :
                        (data[index] is BigInteger value ? value : new BigInteger((int)data[index])).ToByteArray();
                    foreach (string callback in new[] { "onInstall", "configure" })
                    {
                        try { Forward(wrong, callback); }
                        catch (TestException) { rejectedTypes++; continue; }
                        throw new InvalidDataException($"{label}: {callback} accepted the wrong VM type for {field}");
                    }
                }
                if (!forms.Contains("command")) throw new InvalidDataException(label + " is not an install form");
                Forward(data, "onInstall");
                try { Forward(data); }
                catch (TestException e) { throw new InvalidDataException(label + " rejected its NEP command", e); }
                if (command.Name == "createSubscription")
                {
                    var grant = (Neo.VM.Types.Array)fx.Call(module, "getSubscription", account, 1, new byte[] { 1 });
                    if (grant.Count != 6 || !grant[0].GetSpan().SequenceEqual(account.ToArray())
                        || !grant[1].GetSpan().SequenceEqual(fx.GasHash.ToArray())
                        || grant[2].GetInteger() != amount || grant[3].GetInteger() != period)
                        throw new InvalidDataException(label + ": merchant, token, amount or period differs");
                }
                if (command.Name == "setSessionKey")
                {
                    var grant = (Neo.VM.Types.Array)fx.Call(module, "getSessionKey", account, 1);
                    var meta = (Neo.VM.Types.Array)fx.Call(module, "getSessionKeyMetadata", account, 1);
                    if (grant.Count != 7 || !grant[0].GetSpan().SequenceEqual(key)
                        || !grant[1].GetSpan().SequenceEqual(fx.GasHash.ToArray()) || grant[2].GetString() != "transfer"
                        || grant[3].GetInteger() != expiry || grant[4].GetInteger() != sessionCap
                        || meta.Count != 3 || meta[2].GetString() != "example")
                        throw new InvalidDataException(label + ": grant scope, expiry, cap or metadata differs");
                }
                passed++;
            }
            if (forms.Length != 0)
            {
                // Remove the installed account; configuration of the other account
                // is an independent control even though both use instance ID 1.
                bool whitelist = entry.Name == "WhitelistHook";
                bool Allowed(UInt160 id) => fx.Call(module, "isWhitelisted", id, 1, fx.GasHash).GetBoolean();
                if (whitelist)
                {
                    foreach (var id in new[] { installAccount, account })
                        fx.CallVoid(core, "forward", module, "configure",
                            new object[] { id, 1, kind, new object[] { "allowTarget", fx.GasHash } });
                    if (!Allowed(installAccount) || !Allowed(account))
                        throw new InvalidDataException("whitelist setup did not persist both grants");
                }
                fx.CallVoid(core, "forward", module, "onUninstall",
                    new object[] { installAccount, 1, kind, Array.Empty<object>() });
                if (whitelist && (Allowed(installAccount) || !Allowed(account)))
                    throw new InvalidDataException("removing one whitelist changed the wrong grants");
                removals++;
            }
        }
        if (passed == 0) throw new InvalidDataException("No configuration commands tested");
        Console.WriteLine($"{installs} named installation profiles checked; {passed} named module commands accepted in NeoVM; {passed} wrong arities and {rejectedTypes} wrong numeric field types rejected.");
        Console.WriteLine($"{removals} enabled modules accepted empty uninstall data in NeoVM.");
        return 0;
    }
}
