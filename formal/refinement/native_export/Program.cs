using System.Collections;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Operations;

// Inventory only. Binding and syntax are attributed evidence, not a CLR proof.
internal static class Program
{
    private static readonly Dictionary<string, byte[]> Inputs = new(StringComparer.Ordinal);
    private static string Hash(byte[] raw) => Convert.ToHexString(SHA256.HashData(raw)).ToLowerInvariant();
    private static byte[] Snapshot(string path)
    {
        path = Path.GetFullPath(path);
        if (!Inputs.TryGetValue(path, out var raw)) Inputs.Add(path, raw = File.ReadAllBytes(path));
        return raw;
    }
    private static string? Type(ITypeSymbol? type)
    {
        if (type is IErrorTypeSymbol || type?.TypeKind == TypeKind.Error) throw new InvalidDataException("Unresolved type");
        return type?.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat);
    }
    private static object Symbol(ISymbol symbol)
    {
        string? type = symbol switch {
            ITypeSymbol t => Type(t), ILocalSymbol l => Type(l.Type), IParameterSymbol p => Type(p.Type),
            IFieldSymbol f => Type(f.Type), IPropertySymbol p => Type(p.Type), IMethodSymbol m => Type(m.ReturnType), _ => null };
        if (symbol is IMethodSymbol method)
        {
            foreach (var p in method.Parameters) Type(p.Type);
            foreach (var t in method.TypeArguments) Type(t);
        }
        return new { id = symbol.GetDocumentationCommentId() ?? symbol.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat),
            name = symbol.Name, kind = symbol.Kind.ToString(), type, isStatic = symbol.IsStatic,
            assembly = symbol is ILabelSymbol ? null : symbol.ContainingAssembly?.Identity.ToString(),
            display = symbol.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat),
            parameters = symbol is IMethodSymbol callable ? callable.Parameters.Select(p => new { name = p.Name, type = Type(p.Type), refKind = p.RefKind.ToString(), p.Ordinal }).ToArray() : null };
    }
    private static object Conversion(CommonConversion c) => new { c.Exists, c.IsIdentity, c.IsImplicit, c.IsNumeric, c.IsReference,
        c.IsNullable, c.IsUserDefined, method = c.MethodSymbol is null ? null : Symbol(c.MethodSymbol) };
    private static object? Metadata(object? value, IOperation[] children)
    {
        if (value is null || value is string || value is bool || value is int || value is long) return value;
        if (value.GetType().IsEnum) return value.ToString();
        if (value is ISymbol symbol) return new { kind = "symbol", value = Symbol(symbol) };
        if (value is CommonConversion conversion) return new { kind = "conversion", value = Conversion(conversion) };
        if (value is IOperation operation)
        {
            var indices = Enumerable.Range(0, children.Length).Where(i => ReferenceEquals(children[i], operation)).ToArray();
            if (indices.Length != 1) throw new InvalidDataException("Operation metadata is not a unique ordered child");
            return new { kind = "operation", childIndex = indices[0] };
        }
        if (value is IEnumerable enumerable)
        {
            var items = new List<object?>();
            foreach (object? item in enumerable) items.Add(Metadata(item, children));
            return new { kind = "collection", complete = true, items };
        }
        throw new InvalidDataException("Unsupported semantic metadata: " + value.GetType().FullName);
    }
    private static object Export(IOperation op)
    {
        if (op.Kind is OperationKind.Invalid or OperationKind.None) throw new InvalidDataException("Invalid/unbound operation: " + op.Syntax);
        var children = op.ChildOperations.ToArray();
        var metadata = new SortedDictionary<string, object?>(StringComparer.Ordinal);
        foreach (var contract in op.GetType().GetInterfaces().Where(t => t.Namespace == "Microsoft.CodeAnalysis.Operations").OrderBy(t => t.Name))
            foreach (var property in contract.GetProperties().OrderBy(p => p.Name))
                metadata.Add(contract.Name + "." + property.Name, Metadata(property.GetValue(op), children));
        return new { kind = op.Kind.ToString(), type = Type(op.Type), isImplicit = op.IsImplicit,
            constant = op.ConstantValue.HasValue ? new { hasValue = true, value = op.ConstantValue.Value } : null,
            syntax = new { kind = op.Syntax.Kind().ToString(), start = op.Syntax.SpanStart, length = op.Syntax.Span.Length, text = op.Syntax.ToString() },
            metadata, metadataComplete = true, children = children.Select(Export).ToArray() };
    }
    private static int Main(string[] args)
    {
        try
        {
            if (args.Length != 2) throw new ArgumentException("Usage: NativeCodecExport SOURCE_FILE OUTPUT_JSON");
            string sourcePath = Path.GetFullPath(args[0]), output = Path.GetFullPath(args[1]);
            if (File.Exists(output)) throw new IOException("Output already exists");
            byte[] raw = Snapshot(sourcePath);
            string source = new UTF8Encoding(false, true).GetString(raw);
            var tree = CSharpSyntaxTree.ParseText(source, new CSharpParseOptions(LanguageVersion.CSharp12), sourcePath);
            var references = new Dictionary<string, MetadataReference>(StringComparer.Ordinal);
            void Reference(string path)
            {
                path = Path.GetFullPath(path);
                references.Add(path, MetadataReference.CreateFromImage(Snapshot(path), filePath: path));
            }
            foreach (string path in ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!).Split(Path.PathSeparator)
                         .Where(p => !Path.GetFileName(p).StartsWith("Microsoft.CodeAnalysis", StringComparison.Ordinal) && Path.GetFileName(p) != "NativeCodecExport.dll").Distinct()) Reference(path);
            string packages = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".nuget/packages");
            foreach (string package in new[] { "neo", "neo.vm", "neo.io", "neo.extensions", "neo.json" })
            {
                string path = Directory.GetFiles(Path.Combine(packages, package, "3.10.1/lib/net10.0"), "*.dll").Single();
                Reference(path);
            }
            var compilation = CSharpCompilation.Create("PinnedNativeCodecSource", [tree], references.Values,
                new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, optimizationLevel: OptimizationLevel.Release, allowUnsafe: true));
            var diagnostics = compilation.GetDiagnostics();
            var errors = diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error).ToArray();
            if (errors.Length != 0) throw new InvalidDataException(string.Join("\n", errors.Select(d => d.ToString())));
            var model = compilation.GetSemanticModel(tree, ignoreAccessibility: false);
            var methods = tree.GetRoot().DescendantNodes().OfType<MethodDeclarationSyntax>().Where(m =>
                m.Identifier.Text == "Serialize" && m.ParameterList.Parameters.Count == 4 ||
                m.Identifier.Text == "Deserialize" && m.ParameterList.Parameters.Count == 3).ToArray();
            if (methods.Length != 2) throw new InvalidDataException("Expected exactly two native core methods");
            var exported = methods.Select(method => new { name = method.Identifier.Text,
                symbol = Symbol(model.GetDeclaredSymbol(method) ?? throw new InvalidDataException("Missing method symbol")),
                bodyStart = method.Body!.SpanStart, bodyLength = method.Body.Span.Length,
                operation = Export(model.GetOperation(method.Body) ?? throw new InvalidDataException("Missing bound method body")) }).ToArray();
            foreach (var assembly in new[] { typeof(Program).Assembly, typeof(IOperation).Assembly, typeof(CSharpCompilation).Assembly }) Snapshot(assembly.Location);
            foreach (var item in Inputs)
                if (!File.ReadAllBytes(item.Key).SequenceEqual(item.Value)) throw new IOException("Input changed during export: " + item.Key);
            var result = new { schema = "neoos-aa-native-codec-source/v1", status = "TYPED_SOURCE_INVENTORY_ONLY",
                source = new { path = sourcePath, sha256 = Hash(raw), text = source },
                inputs = Inputs.ToDictionary(kv => kv.Key, kv => Hash(kv.Value)),
                roslyn = new { version = typeof(CSharpCompilation).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion,
                    sha256 = Hash(Snapshot(typeof(CSharpCompilation).Assembly.Location)) },
                diagnostics = diagnostics.Select(d => new { severity = d.Severity.ToString(), id = d.Id, text = d.ToString() }).ToArray(),
                methods = exported, semanticMetadataComplete = true, compilationErrorCount = 0, fullImplementationVerified = false };
            File.WriteAllText(output, JsonSerializer.Serialize(result, new JsonSerializerOptions { MaxDepth = 512 }));
            return 0;
        }
        catch (Exception error) { Console.Error.WriteLine(error); return 1; }
    }
}
