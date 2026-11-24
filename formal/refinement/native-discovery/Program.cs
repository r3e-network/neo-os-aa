using System.Reflection.PortableExecutable;
using System.Security.Cryptography;
using System.Text.Json;
using Mono.Cecil;
using Mono.Cecil.Cil;

if (args.Length == 4 && args[3] == "--return-string")
{
    StringReturn.Export(args[0], args[1], args[2]);
    return;
}
if (args.Length == 3 && args[2] == "--receiving-address")
{
    ReceivingAddress.Export(args[0], args[1]);
    return;
}
if (args.Length != 2) throw new ArgumentException("expected native Neo.dll and output JSON");
var bytes = File.ReadAllBytes(args[0]);
using var pe = new PEReader(new MemoryStream(bytes));
using var assembly = AssemblyDefinition.ReadAssembly(new MemoryStream(bytes));
var module = assembly.MainModule;
var core = module.GetType("Neo.SmartContract.Native.SmartAccount") ?? throw new FormatException("missing core");
var methods = new List<object>();
foreach (var name in new[] { "GetAccountImplementationId", "GetProtocolInfo" })
{
    var method = core.Methods.Single(m => m.Name == name);
    var attr = method.CustomAttributes.Single(a => a.AttributeType.FullName == "Neo.SmartContract.Native.ContractMethodAttribute");
    if (!method.IsPrivate || !method.IsStatic || method.HasParameters || method.HasGenericParameters ||
        method.Body.HasExceptionHandlers || method.Body.HasVariables || attr.HasConstructorArguments ||
        attr.Fields.Count != 0 || attr.Properties.Count != 2)
        throw new FormatException("unexpected method or attribute shape: " + name);
    var returnType = method.ReturnType.FullName;
    var flags = Convert.ToInt32(attr.Properties.Single(p => p.Name == "RequiredCallFlags").Argument.Value);
    var cpu = Convert.ToInt64(attr.Properties.Single(p => p.Name == "CpuFee").Argument.Value);
    if (flags != 0 || cpu != 32768 || returnType != (name == "GetProtocolInfo" ? "Neo.VM.Types.Array" : "System.String"))
        throw new FormatException("unexpected signature, permission or price: " + name);
    var raw = pe.GetSectionData(method.RVA).GetContent();
    // The two getters have a tiny CLR header: code size in the upper six bits.
    if ((raw[0] & 3) != 2 || raw[0] >> 2 != method.Body.CodeSize)
        throw new FormatException("unsupported method header");
    var il = raw.AsSpan(1, method.Body.CodeSize).ToArray();
    var symbols = new List<object>();
    foreach (var i in method.Body.Instructions)
    {
        string? kind = null, value = null;
        if (i.OpCode.Code == Code.Ldstr) { kind = "text"; value = (string)i.Operand; }
        else if (i.Operand is MethodReference r)
        {
            var scope = r.DeclaringType.Scope.Name;
            kind = (scope, r.FullName) switch
            {
                ("Neo.VM", "Neo.VM.Types.StackItem Neo.VM.Types.StackItem::op_Implicit(System.Int32)") => "vmInt",
                ("Neo.dll", "System.Void <>z__ReadOnlySingleElementList`1<Neo.VM.Types.StackItem>::.ctor(T)")
                    when r.Parameters[0].ParameterType is GenericParameter { Position: 0, Type: GenericParameterType.Type } => "singleton",
                ("Neo.VM", "System.Void Neo.VM.Types.Array::.ctor(System.Collections.Generic.IEnumerable`1<Neo.VM.Types.StackItem>)") => "vmArray",
                _ => throw new FormatException($"unrecognized symbol: {scope} {r.FullName}")
            };
            value = r.FullName;
        }
        if (kind != null)
            symbols.Add(new { token = System.Buffers.Binary.BinaryPrimitives.ReadUInt32LittleEndian(il.AsSpan(i.Offset + 1)),
                kind, value });
    }
    methods.Add(new { name, cpu, flags, returnType, il = Convert.ToHexStringLower(il), symbols });
}
File.WriteAllText(args[1], JsonSerializer.Serialize(new { assemblySha256 = Convert.ToHexStringLower(SHA256.HashData(bytes)),
    mvid = module.Mvid, methods }, new JsonSerializerOptions { WriteIndented = true }) + "\n");
