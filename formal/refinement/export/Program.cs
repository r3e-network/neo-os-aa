using System.Diagnostics;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Operations;
using Neo.Compiler;
using Neo.SmartContract;
using Neo.SmartContract.Manifest;
using Neo.VM;
using OpCode = Neo.VM.OpCode;
using CompilationOptions = Neo.Compiler.CompilationOptions;
using JsonSerializer = System.Text.Json.JsonSerializer;

// This exports input inventory. Neither compiler locations nor operation trees are proofs.
internal static class Program
{
    private const string CompilerVersion = "3.9.1+5fa9566e5165ede2165a9be1f4a0120c17602697";
    private const string CompilerPackageSha256 = "182c30a41f3b640086363b4d5fa2fb107cc7d17795df9d55a22b7bd646c543e0";
    private static readonly JsonSerializerOptions JsonOptions = new() { MaxDepth = 512 };
    private static readonly Dictionary<string, int> OperationCounts = new(StringComparer.Ordinal);
    private static string SourceRoot = "";

    private static int Main(string[] args)
    {
        try
        {
            var options = ParseArguments(args);
            SourceRoot = Path.GetFullPath(Required(options, "source-root"));
            string project = Path.GetFullPath(Required(options, "project"));
            string nefPath = Path.GetFullPath(Required(options, "nef"));
            string manifestPath = Path.GetFullPath(Required(options, "manifest"));
            string compilerDir = Path.GetFullPath(options.GetValueOrDefault("compiler-tool-dir") ??
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                ".dotnet/tools/.store/neo.compiler.csharp/3.9.1/neo.compiler.csharp/3.9.1/tools/net10.0/any"));
            ValidateCompiler(compilerDir);
            byte[] nefBytes = File.ReadAllBytes(nefPath);
            NefFile nef;
            try { nef = NefFile.Parse(nefBytes, verify: true); }
            catch (Exception ex) { throw new InvalidDataException("NEF checksum/structure validation failed", ex); }
            string manifestText = File.ReadAllText(manifestPath);
            var manifest = ContractManifest.Parse(manifestText);
            var instructions = Decode(nef);
            var boundaries = instructions.Select(i => (int)i["offset"]!).ToHashSet();
            var abiKeys = new HashSet<string>();
            foreach (var method in manifest.Abi.Methods)
                if (!boundaries.Contains(method.Offset) || !abiKeys.Add(method.Name + "/" + method.Parameters.Length))
                    throw new InvalidDataException("ABI offset or name/arity is invalid");

            if (!project.StartsWith(SourceRoot + Path.DirectorySeparatorChar, StringComparison.Ordinal))
                throw new InvalidDataException("Project must be inside source-root");
            var inputs = CollectInputs();
            inputs[nefPath] = Hash(nefBytes);
            inputs[manifestPath] = Hash(File.ReadAllBytes(manifestPath));
            string compilerPackagePath = Path.Combine(Path.GetFullPath(Path.Combine(compilerDir, "../../..")), "neo.compiler.csharp.3.9.1.nupkg");
            inputs[compilerPackagePath] = CompilerPackageSha256;
            SnapshotFrameworkPackage(inputs);
            string scratch = Path.Combine(Path.GetTempPath(), "aa-refinement-export-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(scratch);
            try
            {
                foreach (var path in inputs.Keys.Where(p => p.StartsWith(SourceRoot + Path.DirectorySeparatorChar, StringComparison.Ordinal)))
                {
                    if (path == nefPath || path == manifestPath) continue;
                    string target = Path.Combine(scratch, Path.GetRelativePath(SourceRoot, path));
                    Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                    File.Copy(path, target);
                }
                string scratchProject = Path.Combine(scratch, Path.GetRelativePath(SourceRoot, project));
                string output = Path.Combine(scratch, "exported-artifacts");
                RunCompiler(compilerDir, scratchProject, output);
                string compiledPath = Path.Combine(output, manifest.Name + ".nef");
                if (!File.ReadAllBytes(compiledPath).SequenceEqual(nefBytes))
                    throw new InvalidDataException("Source/NEF pair mismatch: debug rebuild differs from exact candidate bytes");
                if (!JsonNode.DeepEquals(JsonNode.Parse(manifestText), JsonNode.Parse(File.ReadAllText(Path.Combine(output, manifest.Name + ".manifest.json")))))
                    throw new InvalidDataException("Source/manifest pair mismatch: compiled manifest semantics differ from candidate");
                string debugPath = Path.Combine(output, manifest.Name + ".nefdbgnfo");
                JsonNode debug;
                using (var archive = System.IO.Compression.ZipFile.OpenRead(debugPath))
                using (var reader = new StreamReader(archive.Entries.Single().Open()))
                    debug = JsonNode.Parse(reader.ReadToEnd())!;
                string assembly = File.ReadAllText(Path.Combine(output, manifest.Name + ".asm"));
                var compilerOptions = new CompilationOptions { Debug = CompilationOptions.DebugType.Extended, SkipRestoreIfAssetsPresent = true };
                var engine = new CompilationEngine(compilerOptions);
                Compilation compilation;
                var originalOutput = Console.Out;
                try
                {
                    Console.SetOut(Console.Error);
                    compilation = engine.GetCompilation(scratchProject);
                }
                finally { Console.SetOut(originalOutput); }
                var diagnostics = compilation.GetDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error).ToArray();
                if (diagnostics.Length != 0) throw new InvalidDataException("Typed source diagnostics: " + string.Join("; ", diagnostics.Select(d => d.ToString())));
                var source = ExportSource(compilation, scratch);
                foreach (var tree in compilation.SyntaxTrees)
                {
                    string inputPath = OriginalPath(tree.FilePath, scratch);
                    if (!File.Exists(inputPath)) throw new InvalidDataException("Compiler source tree has no attributable file: " + inputPath);
                    if (File.ReadAllText(inputPath) != tree.GetText().ToString()) throw new InvalidDataException("Typed tree differs from current input source: " + inputPath);
                    // Hash the original bytes, including any BOM, as part of the input identity.
                    BindInput(inputs, inputPath);
                }
                foreach (var reference in compilation.References.OfType<PortableExecutableReference>())
                    if (reference.FilePath is string referencePath && File.Exists(referencePath))
                        BindInput(inputs, referencePath);
                var documentInputs = ((JsonArray)debug["documents"]!).Select((doc, index) =>
                {
                    string debugSource = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(scratchProject)!, doc!.GetValue<string>()));
                    string original = OriginalPath(debugSource, scratch);
                    if (!File.Exists(original)) throw new InvalidDataException("Debug document has no attributable file: " + original);
                    BindInput(inputs, original);
                    return new { index, path = original, sha256 = inputs[original], origin = Origin(original) };
                }).ToArray();
                foreach (var input in inputs)
                    if (Hash(File.ReadAllBytes(input.Key)) != input.Value)
                        throw new InvalidDataException("Input changed during export: " + input.Key);
                ValidateCompiler(compilerDir);
                var focus = ((JsonArray)debug["methods"]!).Where(m => m!["id"]!.GetValue<string>().Contains("CapReimbursementToActualCost", StringComparison.Ordinal))
                    .Select(m => new { id = m!["id"]!.GetValue<string>(), range = m["range"]!.GetValue<string>(),
                        source = m.DeepClone(), instructions = Slice(instructions, m["range"]!.GetValue<string>()) }).ToArray();
                var assemblyIdentity = typeof(CompilationEngine).Assembly;
                var loaded = AppDomain.CurrentDomain.GetAssemblies().Where(a => !a.IsDynamic && File.Exists(a.Location))
                    .OrderBy(a => a.GetName().Name).ToDictionary(a => a.GetName().Name!, a => Hash(File.ReadAllBytes(a.Location)));
                var report = new
                {
                    schema = "neoos-aa-refinement-inventory/v1", status = "INVENTORY_ONLY", inputs,
                    compiler = new { assemblyPath = Path.Combine(compilerDir, "nccs.dll"),
                        sha256 = Hash(File.ReadAllBytes(assemblyIdentity.Location)),
                        informationalVersion = assemblyIdentity.GetCustomAttribute<AssemblyInformationalVersionAttribute>()!.InformationalVersion,
                        packagePath = compilerPackagePath, packageSha256 = CompilerPackageSha256,
                        loadedAssemblies = loaded, optimization = "Basic", parseSymbols = compilerOptions.GetParseOptions().PreprocessorSymbolNames },
                    source,
                    nef = new { sha256 = Hash(nefBytes), scriptSha256 = Hash(nef.Script.ToArray()), scriptHex = Convert.ToHexString(nef.Script.Span).ToLowerInvariant(),
                        instructions, tokens = nef.Tokens.Select(t => new { hash = t.Hash.ToString(), method = t.Method, parametersCount = t.ParametersCount, hasReturnValue = t.HasReturnValue, callFlags = (byte)t.CallFlags }),
                        opcodeCounts = instructions.GroupBy(i => (string)i["name"]!).ToDictionary(g => g.Key, g => g.Count()),
                        syscalls = instructions.Where(i => (string)i["name"]! == "SYSCALL").GroupBy(i => (string)i["operandHex"]!)
                            .Select(g => new { id = g.Key, name = ResolveSyscall(g.Key), offsets = g.Select(i => (int)i["offset"]!) }) },
                    manifest = new { sha256 = Hash(File.ReadAllBytes(manifestPath)), methods = JsonNode.Parse(manifestText)!["abi"]!["methods"] },
                    sourceMap = new { exactByteMatch = true, exactManifestMatch = true, debug, documentInputs, assembly, focusedMethods = focus, scope = "Compiler locations only; not semantic equivalence" },
                    proofObligations = new[] { "Every typed operation has unproved source semantics", "Every NeoVM opcode and edge has unproved target semantics",
                        "No translation certificates", "Syscalls, native calls, dynamic calls, faults and heap aliasing need effect contracts", "Compiler debug locations are unproved attribution hints" }
                };
                Console.WriteLine(JsonSerializer.Serialize(report, JsonOptions));
            }
            finally { Directory.Delete(scratch, recursive: true); }
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex.ToString());
            return 1;
        }
    }

    private static Dictionary<string, string> ParseArguments(string[] args)
    {
        var result = new Dictionary<string, string>();
        for (int i = 0; i < args.Length; i += 2)
            if (i + 1 >= args.Length || !args[i].StartsWith("--") || !result.TryAdd(args[i][2..], args[i + 1]))
                throw new ArgumentException("Use --source-root ROOT --project CSPROJ --nef NEF --manifest MANIFEST [--compiler-tool-dir DIR]");
        if (result.Keys.Except(new[] { "source-root", "project", "nef", "manifest", "compiler-tool-dir" }).Any())
            throw new ArgumentException("Unknown argument");
        return result;
    }
    private static string Required(Dictionary<string, string> args, string name) => args.TryGetValue(name, out var value) ? value : throw new ArgumentException("Missing --" + name);
    private static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    private static void ValidateCompiler(string dir)
    {
        var pin = JsonNode.Parse(File.ReadAllText(Path.Combine(SourceRoot, "contracts/neo-platform-packages.json")))!["compiler"]!;
        if (pin["version"]!.GetValue<string>() != "3.9.1" || pin["repositoryCommit"]!.GetValue<string>() != CompilerVersion.Split('+')[1])
            throw new InvalidDataException("Unsupported compiler pin");
        string packageRoot = Path.GetFullPath(Path.Combine(dir, "../../.."));
        string nupkg = Path.Combine(packageRoot, "neo.compiler.csharp.3.9.1.nupkg");
        if (pin["sha256"]!.GetValue<string>() != CompilerPackageSha256 || Hash(File.ReadAllBytes(nupkg)) != CompilerPackageSha256)
            throw new InvalidDataException("Installed compiler package does not match audited SHA256");
        using var zip = System.IO.Compression.ZipFile.OpenRead(nupkg);
        foreach (var entry in zip.Entries.Where(e => e.FullName.StartsWith("tools/net10.0/any/") && e.Name.EndsWith(".dll")))
        {
            using var stream = entry.Open(); using var memory = new MemoryStream(); stream.CopyTo(memory);
            string installed = Path.Combine(dir, entry.FullName["tools/net10.0/any/".Length..]);
            if (!File.ReadAllBytes(installed).SequenceEqual(memory.ToArray())) throw new InvalidDataException("Compiler installed assembly mismatch: " + entry.Name);
            if (entry.Name == "nccs.dll" && !File.ReadAllBytes(typeof(CompilationEngine).Assembly.Location).SequenceEqual(memory.ToArray()))
                throw new InvalidDataException("Loaded compiler assembly does not match audited package");
            if (!entry.FullName["tools/net10.0/any/".Length..].Contains('/'))
                foreach (var loaded in AppDomain.CurrentDomain.GetAssemblies().Where(a => !a.IsDynamic && File.Exists(a.Location) && Path.GetFileName(a.Location) == entry.Name))
                    if (!File.ReadAllBytes(loaded.Location).SequenceEqual(memory.ToArray()))
                        throw new InvalidDataException("Loaded dependency differs from audited compiler package: " + entry.Name);
        }
    }
    private static void BindInput(Dictionary<string, string> inputs, string path)
    {
        string digest = Hash(File.ReadAllBytes(path));
        if (inputs.TryGetValue(path, out var initial) && initial != digest)
            throw new InvalidDataException("Input changed during export: " + path);
        inputs.TryAdd(path, digest);
    }
    private static void SnapshotFrameworkPackage(Dictionary<string, string> inputs)
    {
        var pin = JsonNode.Parse(File.ReadAllText(Path.Combine(SourceRoot, "contracts/neo-platform-packages.json")))!;
        string packages = Environment.GetEnvironmentVariable("NUGET_PACKAGES") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".nuget/packages");
        string package = Path.Combine(packages, "neo.smartcontract.framework", pin["frameworkVersion"]!.GetValue<string>());
        string nupkg = Path.Combine(package, "neo.smartcontract.framework." + pin["frameworkVersion"]!.GetValue<string>() + ".nupkg");
        string expected = ((JsonArray)pin["packages"]!).Single(p => p!["id"]!.GetValue<string>() == "Neo.SmartContract.Framework")!["sha256"]!.GetValue<string>();
        if (Hash(File.ReadAllBytes(nupkg)) != expected) throw new InvalidDataException("Framework package differs from audited SHA256");
        using (var zip = System.IO.Compression.ZipFile.OpenRead(nupkg))
            foreach (var entry in zip.Entries.Where(e => Path.GetExtension(e.FullName) is ".cs" or ".dll"))
            {
                using var stream = entry.Open(); using var memory = new MemoryStream(); stream.CopyTo(memory);
                if (!File.ReadAllBytes(Path.Combine(package, entry.FullName)).SequenceEqual(memory.ToArray()))
                    throw new InvalidDataException("Framework source/reference differs from audited package: " + entry.FullName);
            }
        foreach (string file in Directory.EnumerateFiles(package, "*", SearchOption.AllDirectories))
            if (Path.GetExtension(file) is ".cs" or ".dll" or ".nupkg") BindInput(inputs, file);
    }
    private static Dictionary<string, string> CollectInputs()
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (string path in EnumerateInputs(SourceRoot))
        {
            string relative = Path.GetRelativePath(SourceRoot, path).Replace('\\', '/');
            if (relative.Split('/').Any(s => s is ".git" or "node_modules" or "bin" or "obj" or ".codegraph" or ".next" or "build")) continue;
            if (!(relative.StartsWith("contracts/", StringComparison.Ordinal) || !relative.Contains('/'))) continue;
            if (Path.GetExtension(path) is ".cs" or ".csproj" or ".props" or ".targets" or ".json" or ".config") result[path] = Hash(File.ReadAllBytes(path));
        }
        return result;
    }
    private static IEnumerable<string> EnumerateInputs(string dir)
    {
        foreach (string file in Directory.EnumerateFiles(dir)) yield return file;
        foreach (string child in Directory.EnumerateDirectories(dir))
        {
            string name = Path.GetFileName(child);
            if (name is ".git" or "node_modules" or "bin" or "obj" or ".codegraph" or ".next" or "build") continue;
            if (dir == SourceRoot && name != "contracts") continue;
            foreach (string file in EnumerateInputs(child)) yield return file;
        }
    }
    private static void RunCompiler(string dir, string project, string output)
    {
        var start = new ProcessStartInfo("dotnet") { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false };
        foreach (string arg in new[] { Path.Combine(dir, "nccs.dll"), project, "-o", output, "--debug", "Extended", "--assembly" }) start.ArgumentList.Add(arg);
        using var process = Process.Start(start)!;
        var stdout = process.StandardOutput.ReadToEndAsync(); var stderr = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(180000)) { process.Kill(entireProcessTree: true); throw new TimeoutException("Compiler export timeout"); }
        Task.WaitAll(stdout, stderr);
        if (process.ExitCode != 0) throw new InvalidDataException("Pinned compiler export failed: " + stdout.Result + stderr.Result);
    }

    private static List<Dictionary<string, object?>> Decode(NefFile nef)
    {
        var script = new Script(nef.Script, strictMode: true);
        var result = new List<Dictionary<string, object?>>();
        for (int pc = 0; pc < script.Length;)
        {
            Instruction instruction = script.GetInstruction(pc);
            if (!Enum.IsDefined(instruction.OpCode)) throw new InvalidDataException("Unknown opcode at " + pc);
            string name = instruction.OpCode.ToString();
            var edges = new List<Dictionary<string, object?>>();
            int next = pc + instruction.Size;
            if (name is "CALL" or "CALL_L" || name.StartsWith("JMP") || name.StartsWith("ENDTRY"))
            {
                int delta = instruction.Operand.Length == 1 ? (sbyte)instruction.Operand.Span[0] : System.Buffers.Binary.BinaryPrimitives.ReadInt32LittleEndian(instruction.Operand.Span);
                edges.Add(new() { ["kind"] = name.StartsWith("CALL") ? "call" : "branch", ["target"] = pc + delta });
            }
            if (name is "TRY" or "TRY_L")
            {
                int width = name == "TRY" ? 1 : 4;
                for (int i = 0; i < 2; i++)
                {
                    int delta = width == 1 ? (sbyte)instruction.Operand.Span[i] : System.Buffers.Binary.BinaryPrimitives.ReadInt32LittleEndian(instruction.Operand.Span[(i * width)..]);
                    if (delta != 0) edges.Add(new() { ["kind"] = i == 0 ? "catch" : "finally", ["target"] = pc + delta });
                }
            }
            if (name == "CALLA") edges.Add(new() { ["kind"] = "unresolved-indirect-call", ["target"] = null });
            if (name is not ("RET" or "ABORT" or "ABORTMSG" or "THROW" or "JMP" or "JMP_L" or "ENDTRY" or "ENDTRY_L" or "ENDFINALLY") && next < script.Length)
                edges.Add(new() { ["kind"] = "fallthrough", ["target"] = next });
            if (name == "CALLT" && instruction.TokenU16 >= nef.Tokens.Length) throw new InvalidDataException("CALLT token out of bounds");
            result.Add(new() { ["offset"] = pc, ["opcode"] = (byte)instruction.OpCode, ["name"] = name,
                ["operandHex"] = Convert.ToHexString(instruction.Operand.Span).ToLowerInvariant(), ["size"] = instruction.Size,
                ["tokenIndex"] = name == "CALLT" ? instruction.TokenU16 : null,
                ["syscallName"] = name == "SYSCALL" ? ResolveSyscall(Convert.ToHexString(instruction.Operand.Span).ToLowerInvariant()) : null,
                ["instructionHex"] = Convert.ToHexString(nef.Script.Span.Slice(pc, instruction.Size)).ToLowerInvariant(), ["edges"] = edges });
            pc = next;
        }
        var boundaries = result.Select(i => (int)i["offset"]!).ToHashSet();
        foreach (var item in result)
            foreach (var edge in (List<Dictionary<string, object?>>)item["edges"]!)
                if (edge["target"] is int target && !boundaries.Contains(target)) throw new InvalidDataException("Branch target is not an instruction boundary");
        return result;
    }
    private static object[] Slice(List<Dictionary<string, object?>> instructions, string range)
    {
        int[] values = range.Split('-').Select(int.Parse).ToArray();
        return instructions.Where(i => (int)i["offset"]! >= values[0] && (int)i["offset"]! <= values[1]).Cast<object>().ToArray();
    }
    private static string? ResolveSyscall(string id)
    {
        uint hash = Convert.ToUInt32(Convert.ToHexString(Convert.FromHexString(id).Reverse().ToArray()), 16);
        return ApplicationEngine.Services.TryGetValue(hash, out var descriptor) ? descriptor.Name : null;
    }

    private static object ExportSource(Compilation compilation, string scratch)
    {
        OperationCounts.Clear(); var methods = new List<object>(); var types = new List<object>(); var initializers = new List<object>();
        var trees = compilation.SyntaxTrees.GroupBy(t => t.FilePath).Select(g => g.First()).ToArray();
        foreach (var tree in trees)
        {
            var model = compilation.GetSemanticModel(tree);
            foreach (var node in tree.GetRoot().DescendantNodes().OfType<TypeDeclarationSyntax>())
            {
                if (model.GetDeclaredSymbol(node) is not INamedTypeSymbol symbol) continue;
                types.Add(new { id = Id(symbol), displayName = TypeName(symbol), kind = symbol.TypeKind.ToString(),
                    baseType = TypeName(symbol.BaseType), isValueType = symbol.IsValueType, location = Location(node, scratch),
                    fields = symbol.GetMembers().OfType<IFieldSymbol>().Select(f => new { id = Id(f), name = f.Name, type = TypeName(f.Type), isStatic = f.IsStatic, isReadOnly = f.IsReadOnly, constant = f.HasConstantValue ? Constant(f.ConstantValue) : null }),
                    synthesizedMembers = symbol.GetMembers().Where(s => s.IsImplicitlyDeclared).Select(s => new { id = Id(s), kind = s.Kind.ToString(), issue = "Compiler-synthesized member has no separately exported source body" }) });
            }
            foreach (var node in tree.GetRoot().DescendantNodes().Where(n => n is BaseMethodDeclarationSyntax or AccessorDeclarationSyntax or LocalFunctionStatementSyntax))
            {
                if (model.GetDeclaredSymbol(node) is not IMethodSymbol symbol) continue;
                IOperation? operation = model.GetOperation(node);
                methods.Add(new { id = Id(symbol), displayName = symbol.ToDisplayString(), location = Location(node, scratch), returnType = TypeName(symbol.ReturnType),
                    origin = Origin(OriginalPath(tree.FilePath, scratch)),
                    parameters = symbol.Parameters.Select(p => new { name = p.Name, type = TypeName(p.Type), ordinal = p.Ordinal, refKind = p.RefKind.ToString() }),
                    operations = operation is null ? Array.Empty<object>() : new[] { ExportOperation(operation, scratch) },
                    exportIssue = operation is null ? "No method body operation; extern or unsupported syntax must be reviewed" : null });
            }
            foreach (var initializer in tree.GetRoot().DescendantNodes().OfType<EqualsValueClauseSyntax>().Where(n => n.Parent is PropertyDeclarationSyntax || n.Parent is VariableDeclaratorSyntax { Parent.Parent: FieldDeclarationSyntax or EventFieldDeclarationSyntax }))
            {
                var op = model.GetOperation(initializer);
                initializers.Add(new { location = Location(initializer, scratch), origin = Origin(OriginalPath(tree.FilePath, scratch)),
                    operations = op is null ? Array.Empty<object>() : new[] { ExportOperation(op, scratch) },
                    exportIssue = op is null ? "Initializer operation unavailable; explicit proof obligation" : null });
            }
        }
        return new { types, methods, initializers, files = trees.Select(t => new { path = OriginalPath(t.FilePath, scratch), origin = Origin(OriginalPath(t.FilePath, scratch)), sha256 = Hash(File.ReadAllBytes(OriginalPath(t.FilePath, scratch))) }),
            compilationScope = "All distinct source trees returned by the pinned compiler loader; other contract types are input inventory, not claimed reachable target methods",
            operationCounts = OperationCounts,
            unsupportedOperations = OperationCounts.Select(pair => new { kind = pair.Key, count = pair.Value, reason = "No formal source semantics certificate; inventory does not prove support" }) };
    }
    private static string? TypeName(ITypeSymbol? type) => type?.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat);
    private static string Id(ISymbol symbol) => symbol.GetDocumentationCommentId() ?? symbol.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat);
    private static object? Constant(object? value) => value is null ? null : new { runtimeType = value.GetType().FullName, value = Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture) };
    private static object Location(SyntaxNode node, string scratch)
    {
        var span = node.GetLocation().GetLineSpan();
        string path = OriginalPath(span.Path, scratch);
        return new { path, startLine = span.StartLinePosition.Line + 1, startColumn = span.StartLinePosition.Character + 1,
            endLine = span.EndLinePosition.Line + 1, endColumn = span.EndLinePosition.Character + 1, start = node.SpanStart, length = node.Span.Length };
    }
    private static string OriginalPath(string path, string scratch) => Path.GetFullPath(path.StartsWith(scratch + Path.DirectorySeparatorChar, StringComparison.Ordinal) ? Path.Combine(SourceRoot, Path.GetRelativePath(scratch, path)) : path);
    private static string Origin(string path) => path.StartsWith(SourceRoot + Path.DirectorySeparatorChar, StringComparison.Ordinal) ? "repository-source" : path.Contains("/.nuget/packages/") ? "package-source" : "compiler-reference-source";
    private static object ExportOperation(IOperation op, string scratch)
    {
        string kind = op.Kind.ToString(); OperationCounts[kind] = OperationCounts.GetValueOrDefault(kind) + 1;
        if (op.Kind == OperationKind.Invalid) throw new InvalidDataException("Invalid typed operation at " + op.Syntax.GetLocation());
        var details = new Dictionary<string, object?>();
        switch (op)
        {
            case IBinaryOperation b: details["operator"] = b.OperatorKind.ToString(); details["checked"] = b.IsChecked; details["lifted"] = b.IsLifted; details["operatorMethod"] = b.OperatorMethod is null ? null : Id(b.OperatorMethod); break;
            case IUnaryOperation u: details["operator"] = u.OperatorKind.ToString(); details["checked"] = u.IsChecked; details["operatorMethod"] = u.OperatorMethod is null ? null : Id(u.OperatorMethod); break;
            case IConversionOperation c: details["checked"] = c.IsChecked; details["tryCast"] = c.IsTryCast; details["conversion"] = new { c.Conversion.Exists, c.Conversion.IsIdentity, c.Conversion.IsImplicit, c.Conversion.IsNullable, c.Conversion.IsNumeric, c.Conversion.IsReference, c.Conversion.IsUserDefined, method = c.Conversion.MethodSymbol is null ? null : Id(c.Conversion.MethodSymbol) }; break;
            case IInvocationOperation i: details["callee"] = Id(i.TargetMethod); details["virtual"] = i.IsVirtual; break;
            case IObjectCreationOperation o: details["constructor"] = o.Constructor is null ? null : Id(o.Constructor); break;
            case IFieldReferenceOperation f: details["symbol"] = Id(f.Field); break;
            case IPropertyReferenceOperation p: details["symbol"] = Id(p.Property); break;
            case ILocalReferenceOperation l: details["symbol"] = Id(l.Local); break;
            case IParameterReferenceOperation p: details["symbol"] = Id(p.Parameter); details["ordinal"] = p.Parameter.Ordinal; break;
            case IArgumentOperation a: details["argumentKind"] = a.ArgumentKind.ToString(); details["parameter"] = a.Parameter is null ? null : Id(a.Parameter); details["inConversion"] = Conversion(a.InConversion); details["outConversion"] = Conversion(a.OutConversion); break;
            case IVariableDeclaratorOperation v: details["symbol"] = Id(v.Symbol); break;
            case IIncrementOrDecrementOperation i: details["checked"] = i.IsChecked; details["postfix"] = i.IsPostfix; details["operatorMethod"] = i.OperatorMethod is null ? null : Id(i.OperatorMethod); break;
            case ICompoundAssignmentOperation a: details["operator"] = a.OperatorKind.ToString(); details["checked"] = a.IsChecked; details["operatorMethod"] = a.OperatorMethod is null ? null : Id(a.OperatorMethod); break;
        }
        var boundMetadata = new Dictionary<string, object?>();
        var unexportedMetadata = new List<string>();
        foreach (var contract in op.GetType().GetInterfaces().Where(t => t.Namespace == "Microsoft.CodeAnalysis.Operations"))
            foreach (var property in contract.GetProperties())
            {
                string key = contract.Name + "." + property.Name;
                object? value = property.GetValue(op);
                if (value is null || value is bool or string or int || value?.GetType().IsEnum == true)
                    boundMetadata[key] = value?.GetType().IsEnum == true ? value.ToString() : value;
                else if (value is ISymbol symbol) boundMetadata[key] = new { id = Id(symbol), type = symbol is ITypeSymbol type ? TypeName(type) : null };
                else if (value is CommonConversion conversion) boundMetadata[key] = Conversion(conversion);
                else if (value is IOperation) boundMetadata[key] = "Operation child; see ordered children";
                else unexportedMetadata.Add(key + ":" + value!.GetType().FullName);
            }
        return new { kind, type = TypeName(op.Type), @implicit = op.IsImplicit,
            constant = op.ConstantValue.HasValue ? new { hasValue = true, value = Constant(op.ConstantValue.Value) } : null,
            location = Location(op.Syntax, scratch), details, boundMetadata, unexportedMetadata,
            children = op.ChildOperations.Select(child => ExportOperation(child, scratch)).ToArray(),
            evaluationOrder = "Roslyn ChildOperations order; formal semantics still required" };
    }
    private static object Conversion(CommonConversion c) => new { c.Exists, c.IsIdentity, c.IsImplicit, c.IsNullable, c.IsNumeric, c.IsReference, c.IsUserDefined, method = c.MethodSymbol is null ? null : Id(c.MethodSymbol) };
}
