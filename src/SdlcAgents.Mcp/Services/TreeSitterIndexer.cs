using Microsoft.Extensions.Logging;
using TreeSitter;

namespace SdlcAgents.Mcp.Services;

/// <summary>
/// Real tree-sitter parsing for non-C# languages (Java, TypeScript/JS incl. Angular
/// &amp; React). More accurate than the regex fallback: correct name/line extraction,
/// multi-line signatures, and references that ignore matches inside strings/comments
/// (they aren't identifier nodes). Native grammars ship with the TreeSitter.DotNet
/// NuGet for win-x64 + linux-x64, so there's no build-time compilation.
///
/// If the native library can't load in a given environment, construction throws and
/// <see cref="CodeIndex"/> falls back to <see cref="RegexLanguageIndexer"/> — Java/TS
/// support degrades rather than breaking.
/// </summary>
public abstract class TreeSitterIndexer : ILanguageIndexer, IDisposable
{
    private readonly ILogger _logger;
    private readonly Dictionary<string, (Language Lang, Parser Parser)> _byExt = new(StringComparer.OrdinalIgnoreCase);
    private readonly object _lock = new(); // tree-sitter Parser is not thread-safe
    private readonly List<SourceFile> _files = new();
    private readonly Dictionary<string, List<SymbolDef>> _symbols = new(StringComparer.Ordinal);
    private readonly HashSet<string> _declSites = new(StringComparer.Ordinal); // "rel|line|name"

    public abstract string Name { get; }
    /// <summary>Lower-case extension (".ts") → tree-sitter grammar id ("TypeScript").</summary>
    protected abstract IReadOnlyDictionary<string, string> ExtensionGrammars { get; }
    /// <summary>Maps a declaration node to a symbol kind, or null to skip.</summary>
    protected abstract string? KindFor(Node node);
    /// <summary>Node types that are identifier references.</summary>
    protected virtual IReadOnlySet<string> IdentifierTypes { get; } =
        new HashSet<string>(StringComparer.Ordinal) { "identifier", "type_identifier", "property_identifier", "field_identifier" };

    protected TreeSitterIndexer(ILogger logger)
    {
        _logger = logger;
        // Load every grammar up-front. A native failure here throws to the factory,
        // which then falls back to the regex indexer for this language.
        foreach (var kv in ExtensionGrammars)
        {
            var lang = new Language(kv.Value);
            var parser = new Parser(lang);
            using (var _ = parser.Parse("")) { } // force the native path now (fail fast)
            _byExt[kv.Key] = (lang, parser);
        }
    }

    public bool Handles(string extensionLower) => _byExt.ContainsKey(extensionLower);
    public IReadOnlyList<SourceFile> Files => _files;

    public void Build(IReadOnlyList<(string Rel, string Full)> files)
    {
        foreach (var (rel, full) in files)
        {
            var ext = Path.GetExtension(full).ToLowerInvariant();
            if (!_byExt.TryGetValue(ext, out var pp)) continue;
            string text;
            try { text = File.ReadAllText(full); }
            catch (Exception ex) { _logger.LogDebug(ex, "read fail {Path}", full); continue; }
            try
            {
                var lines = text.Replace("\r\n", "\n").Split('\n');
                lock (_lock)
                {
                    using var tree = pp.Parser.Parse(text);
                    if (tree is not null) IndexDeclarations(tree.RootNode, rel, lines);
                }
            }
            catch (Exception ex) { _logger.LogDebug(ex, "parse fail {Path}", full); }
            _files.Add(new SourceFile(rel, full, null, text));
        }
    }

    private void IndexDeclarations(Node node, string rel, string[] lines)
    {
        var kind = KindFor(node);
        if (kind is not null)
        {
            // Anchor on the *name* token, not the declaration node — a Java/TS decl node
            // includes leading annotations/decorators, so its start line is the annotation.
            // Using the name's line makes the reported line + signature the real declaration
            // line, and lets us exclude the declaration's own name token from references.
            var nameNode = node["name"];
            var name = nameNode?.Text;
            if (nameNode is not null && !string.IsNullOrEmpty(name))
            {
                var line = (int)nameNode.StartPosition.Row + 1;
                var sig = (line - 1 >= 0 && line - 1 < lines.Length) ? lines[line - 1].Trim() : name!;
                if (sig.Length > 200) sig = sig[..200];
                if (!_symbols.TryGetValue(name, out var list)) _symbols[name] = list = new();
                list.Add(new SymbolDef(name, kind, null, rel, line, sig));
                _declSites.Add($"{rel}|{line}|{name}");
            }
        }
        foreach (var c in node.Children) IndexDeclarations(c, rel, lines);
    }

    public IReadOnlyList<SymbolDef> FindDeclarations(string name)
        => _symbols.TryGetValue(name, out var list) ? list : Array.Empty<SymbolDef>();

    public IReadOnlyList<Reference> FindReferences(string name)
    {
        if (string.IsNullOrEmpty(name)) return Array.Empty<Reference>();
        var results = new List<Reference>();
        foreach (var file in _files)
        {
            var ext = Path.GetExtension(file.FullPath).ToLowerInvariant();
            if (!_byExt.TryGetValue(ext, out var pp)) continue;
            try
            {
                var lines = file.Text.Replace("\r\n", "\n").Split('\n');
                lock (_lock)
                {
                    using var tree = pp.Parser.Parse(file.Text);
                    if (tree is null) continue;
                    CollectRefs(tree.RootNode, name, file.RelativePath, lines, results);
                }
            }
            catch (Exception ex) { _logger.LogDebug(ex, "ref parse fail {Path}", file.FullPath); }
        }
        return results;
    }

    private void CollectRefs(Node node, string name, string rel, string[] lines, List<Reference> results)
    {
        if (node.Text == name && IdentifierTypes.Contains(node.Type))
        {
            var line = (int)node.StartPosition.Row + 1;
            if (!_declSites.Contains($"{rel}|{line}|{name}")) // skip the declaration's own name token
            {
                var text = (line - 1 >= 0 && line - 1 < lines.Length) ? lines[line - 1].Trim() : name;
                results.Add(new Reference(rel, line, text));
            }
        }
        foreach (var c in node.Children) CollectRefs(c, name, rel, lines, results);
    }

    public void Dispose()
    {
        foreach (var kv in _byExt) { try { kv.Value.Parser.Dispose(); kv.Value.Lang.Dispose(); } catch { } }
    }
}

/// <summary>Java — classes, interfaces, enums, records, methods.</summary>
public sealed class JavaTreeSitterIndexer : TreeSitterIndexer
{
    public JavaTreeSitterIndexer(ILogger logger) : base(logger) { }
    public override string Name => "Java";
    protected override IReadOnlyDictionary<string, string> ExtensionGrammars { get; } =
        new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { [".java"] = "Java" };
    protected override string? KindFor(Node n) => n.Type switch
    {
        "class_declaration" => "class",
        "interface_declaration" => "interface",
        "enum_declaration" => "enum",
        "record_declaration" => "record",
        "method_declaration" => "method",
        _ => null,
    };
}

/// <summary>TypeScript / JavaScript / TSX / JSX — types, functions, components, methods.</summary>
public sealed class TypeScriptTreeSitterIndexer : TreeSitterIndexer
{
    public TypeScriptTreeSitterIndexer(ILogger logger) : base(logger) { }
    public override string Name => "TypeScript/JS";
    protected override IReadOnlyDictionary<string, string> ExtensionGrammars { get; } =
        new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            [".ts"] = "TypeScript", [".tsx"] = "TSX", [".jsx"] = "TSX",
            [".js"] = "JavaScript", [".mjs"] = "JavaScript", [".cjs"] = "JavaScript",
        };
    protected override string? KindFor(Node n) => n.Type switch
    {
        "class_declaration" or "abstract_class_declaration" => "class",
        "interface_declaration" => "interface",
        "enum_declaration" => "enum",
        "type_alias_declaration" => "type",
        "function_declaration" or "generator_function_declaration" => "function",
        "method_definition" => "method",
        // const Foo = (...) => ... / = function(...) — React components & arrow functions
        "variable_declarator" => n["value"]?.Type is "arrow_function" or "function" or "function_expression" ? "function" : null,
        _ => null,
    };
}
