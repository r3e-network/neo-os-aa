using System.Buffers.Binary;
using System.Reflection.PortableExecutable;
using System.Security.Cryptography;
using System.Text.Json;
using Mono.Cecil;
using Mono.Cecil.Cil;

internal static class ReceivingAddress
{
    internal static void Export(string path, string output)
    {
        byte[] bytes = File.ReadAllBytes(path);
        using var pe = new PEReader(new MemoryStream(bytes));
        using var assembly = AssemblyDefinition.ReadAssembly(new MemoryStream(bytes));
        var methods = new List<object>();
        foreach (var (type, names) in new[] {
            ("Neo.SmartContract.Native.SmartAccount", new[] { "GetAccountAddress", "RequireAccountId" }),
            ("Neo.SmartContract.Native.SmartAccountProtocol", new[] { "GetAccountAddress", "RequireIdentity", "CreateVerificationScript", "get_ServiceHash" }),
            ("Neo.Extensions.ScriptBuilderExtensions", new[] { "EmitDynamicCall" }),
            ("Neo.SmartContract.Helper", new[] { "ToScriptHash" }) })
        {
            var owner = assembly.MainModule.GetType(type);
            foreach (var name in names)
            {
                var method = owner.Methods.Single(m => m.Name == name && (name switch {
                    "EmitDynamicCall" => m.Parameters.Count == 5,
                    "ToScriptHash" => m.Parameters[0].ParameterType.FullName == "System.Byte[]",
                    _ => true }));
                var body = method.Body;
                var raw = pe.GetSectionData(method.RVA).GetContent();
                var header = BinaryPrimitives.ReadUInt16LittleEndian(raw.AsSpan(0, 2));
                int offset = (header & 3) switch { 2 => 1, 3 => 4 * (header >> 12), _ => throw new FormatException("bad header") };
                int size = offset == 1 ? (header & 255) >> 2 : BinaryPrimitives.ReadInt32LittleEndian(raw.AsSpan(4, 4));
                if (size != body.CodeSize) throw new FormatException("body length");
                var il = raw.AsSpan(offset, size).ToArray();
                var ins = body.Instructions.Select(i => new {
                    pc = i.Offset, op = i.OpCode.Name,
                    operand = i.Operand switch {
                        Instruction next => next.Offset.ToString(),
                        MemberReference m => m.FullName,
                        null => "", _ => i.Operand.ToString() },
                    scope = i.Operand is TypeReference t ? t.Scope.Name :
                        i.Operand is MemberReference r ? r.DeclaringType.Scope.Name : null
                }).ToArray();
                methods.Add(new { id = type + "." + name, signature = method.FullName, method.IsStatic,
                    il = Convert.ToHexStringLower(il), instructions = ins,
                    locals = body.Variables.Select(v => v.VariableType.FullName),
                    handlers = body.ExceptionHandlers.Select(h => new { kind = h.HandlerType.ToString(),
                        start = h.TryStart.Offset, end = h.TryEnd.Offset, handler = h.HandlerStart.Offset, after = h.HandlerEnd.Offset }) });
            }
        }
        File.WriteAllText(output, JsonSerializer.Serialize(new { assemblySha256 = Convert.ToHexStringLower(SHA256.HashData(bytes)), methods },
            new JsonSerializerOptions { WriteIndented = true }) + "\n");
    }
}
