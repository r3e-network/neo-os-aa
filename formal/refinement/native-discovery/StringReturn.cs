using System.Security.Cryptography;
using System.Text.Json;
using Mono.Cecil;
using Mono.Cecil.Cil;

internal static class StringReturn
{
    public static void Export(string host, string vm, string output)
    {
        byte[] coreBytes = File.ReadAllBytes(host), vmBytes = File.ReadAllBytes(vm);
        using var core = AssemblyDefinition.ReadAssembly(new MemoryStream(coreBytes));
        using var machine = AssemblyDefinition.ReadAssembly(new MemoryStream(vmBytes));
        var engine = core.MainModule.GetType("Neo.SmartContract.ApplicationEngine");
        var stack = machine.MainModule.GetType("Neo.VM.Types.StackItem");
        var convert = engine.Methods.Single(m => m.Name == "Convert" && !m.IsStatic &&
            m.Parameters.Count == 1 && m.Parameters[0].ParameterType.FullName == "System.Object" && m.ReturnType.FullName == stack.FullName);
        var cast = stack.Methods.Single(m => m.Name == "op_Implicit" && m.IsStatic &&
            m.Parameters.Count == 1 && m.Parameters[0].ParameterType.FullName == "System.String" && m.ReturnType.FullName == stack.FullName);
        var bstr = machine.MainModule.GetType("Neo.VM.Types.ByteString");
        var encode = bstr.Methods.Single(m => m.Name == "op_Implicit" && m.IsStatic &&
            m.Parameters.Count == 1 && m.Parameters[0].ParameterType.FullName == "System.String" && m.ReturnType.FullName == bstr.FullName);
        var identity = core.MainModule.GetType("Neo.SmartContract.Native.SmartAccount").Methods.Single(m =>
            m.Name == "GetAccountImplementationId" && m.IsStatic && !m.HasParameters && m.ReturnType.FullName == "System.String");
        object Read(MethodDefinition m) => !m.Body.HasExceptionHandlers ? new {
            method = m.FullName, owner = m.Module.Assembly.Name.FullName,
            instructions = m.Body.Instructions.Select(i => new { pc = i.Offset, op = i.OpCode.Name,
                operand = i.Operand switch { null => "", Instruction j => j.Offset.ToString(),
                    VariableDefinition v => v.Index.ToString(), MemberReference r => r.FullName, _ => i.Operand.ToString() },
                scope = i.Operand is TypeReference t ? t.Scope.Name :
                    i.Operand is MemberReference member ? member.DeclaringType.Scope.Name : "" }) }
            : throw new FormatException("exception handlers not supported");
        if (core.MainModule.AssemblyReferences.Single(r => r.Name == "Neo.VM").FullName != machine.Name.FullName)
            throw new FormatException("unexpected Neo.VM identity");
        File.WriteAllText(output, JsonSerializer.Serialize(new {
            assemblySha256 = Convert.ToHexStringLower(SHA256.HashData(coreBytes)),
            vmSha256 = Convert.ToHexStringLower(SHA256.HashData(vmBytes)), identity = Read(identity),
            convert = Read(convert), cast = Read(cast), encode = Read(encode) }, new JsonSerializerOptions { WriteIndented = true })+"\n");
    }
}
