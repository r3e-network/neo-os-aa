using System.Security.Cryptography;
using System.Text.Json;
using Neo.SmartContract;
using Neo.SmartContract.Testing;
using Neo.VM;

static string Digest(string path) => Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(path)));
var result = BlockRollback.Run(TestEngine.Default, File.ReadAllBytes(args[0]), File.ReadAllText(args[1]));
File.WriteAllText(args[2], System.Text.Json.JsonSerializer.Serialize(new
{
    engineSha256 = Digest(typeof(ApplicationEngine).Assembly.Location),
    vmSha256 = Digest(typeof(ExecutionEngine).Assembly.Location),
    nefSha256 = Digest(args[0]), manifestSha256 = Digest(args[1]), result
}, new JsonSerializerOptions { WriteIndented = true }));
