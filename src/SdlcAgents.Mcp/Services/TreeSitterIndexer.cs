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
    /// <summary>Maps a declaration node to a symbol kind, or null to skip.</summary>
    protected abstract string? KindFor(Node node);
    /// <summary>Node types that are identifier references.</summary>
    protected virtual IReadOnlySet<string> IdentifierTypes { get; } =
        new HashSet<string>(StringComparer.Ordinal) { "identifier", "type_identifier", "property_identifier", "field_identifier" };

    /// <summary>
    /// Reads a named field, or null when the grammar has no such field on this node.
    /// The binding's indexer THROWS KeyNotFoundException rather than returning null,
    /// and field sets differ per grammar (Ruby's `module`, C's `function_definition`),
    /// so every field access must go through here.
    /// </summary>
    protected static Node? Field(Node node, string field)
    {
        try { return node[field]; }
        catch (KeyNotFoundException) { return null; }
    }

    /// <summary>
    /// Locates the node holding a declaration's name. Most grammars expose a "name"
    /// field; C/C++ instead nest it in a declarator chain (function_definition →
    /// function_declarator → identifier), so those languages override this.
    /// </summary>
    protected virtual Node? ResolveName(Node declaration) => Field(declaration, "name");

    /// <param name="extensionGrammars">Lower-case extension (".ts") → tree-sitter grammar id ("TypeScript").
    /// Passed in rather than read from a virtual member, because derived state isn't
    /// assigned yet while this constructor runs.</param>
    protected TreeSitterIndexer(ILogger logger, IReadOnlyDictionary<string, string> extensionGrammars)
    {
        _logger = logger;
        // Load every grammar up-front. A native failure here throws to the factory,
        // which then falls back to the regex indexer (Java/TS) or skips the language.
        foreach (var kv in extensionGrammars)
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
        // Per-node guard: an unexpected grammar shape must cost us one symbol, never the
        // rest of the file (a throw here previously aborted the whole file's indexing).
        string? kind;
        try { kind = KindFor(node); }
        catch (Exception ex) { _logger.LogDebug(ex, "kind fail {Type} in {File}", node.Type, rel); kind = null; }

        if (kind is not null)
        {
            try
            {
                // Anchor on the *name* token, not the declaration node — a Java/TS decl node
                // includes leading annotations/decorators, so its start line is the annotation.
                // Using the name's line makes the reported line + signature the real declaration
                // line, and lets us exclude the declaration's own name token from references.
                var nameNode = ResolveName(node);
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
            catch (Exception ex) { _logger.LogDebug(ex, "name fail {Type} in {File}", node.Type, rel); }
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

/// <summary>
/// Declarative definition of a language: which extensions map to which tree-sitter
/// grammar, which AST node types are declarations (and what kind of symbol they are),
/// and which node types count as identifier references. Adding a language is a config
/// entry, not a new class.
/// </summary>
public sealed record LanguageSpec(
    string Name,
    IReadOnlyDictionary<string, string> Extensions,   // ".py" -> "Python"
    IReadOnlyDictionary<string, string> Kinds,        // "class_definition" -> "class"
    IReadOnlySet<string> Identifiers,
    bool NameViaDeclarator = false);                  // C/C++ nest the name in a declarator

/// <summary>Config-driven tree-sitter indexer — one instance per <see cref="LanguageSpec"/>.</summary>
public sealed class GenericTreeSitterIndexer : TreeSitterIndexer
{
    private readonly LanguageSpec _spec;
    public GenericTreeSitterIndexer(LanguageSpec spec, ILogger logger) : base(logger, spec.Extensions) => _spec = spec;

    public override string Name => _spec.Name;
    protected override IReadOnlySet<string> IdentifierTypes => _spec.Identifiers;
    protected override string? KindFor(Node n) => _spec.Kinds.TryGetValue(n.Type, out var k) ? k : null;

    protected override Node? ResolveName(Node declaration)
    {
        var direct = Field(declaration, "name");
        if (direct is not null || !_spec.NameViaDeclarator) return direct;

        // C/C++: function_definition -> declarator: function_declarator -> declarator: identifier
        // (C++ adds qualified_identifier for out-of-class definitions: Type::method).
        var node = Field(declaration, "declarator");
        for (var depth = 0; node is not null && depth < 8; depth++)
        {
            if (_spec.Identifiers.Contains(node.Type)) return node;
            node = Field(node, "declarator") ?? Field(node, "name");
        }
        return null;
    }
}

/// <summary>Every language served by the tree-sitter backend beyond C# (Roslyn), Java and TypeScript/JS.</summary>
public static class LanguageSpecs
{
    private static IReadOnlyDictionary<string, string> Map(params (string Ext, string Grammar)[] xs)
        => xs.ToDictionary(x => x.Ext, x => x.Grammar, StringComparer.OrdinalIgnoreCase);
    private static IReadOnlyDictionary<string, string> Kind(params (string Node, string Kind)[] xs)
        => xs.ToDictionary(x => x.Node, x => x.Kind, StringComparer.Ordinal);
    private static IReadOnlySet<string> Ids(params string[] xs) => new HashSet<string>(xs, StringComparer.Ordinal);

    private static readonly IReadOnlySet<string> CommonIds =
        Ids("identifier", "type_identifier", "field_identifier", "property_identifier");

    public static readonly LanguageSpec Python = new("Python",
        Map((".py", "Python"), (".pyi", "Python")),
        Kind(("class_definition", "class"), ("function_definition", "function")),
        Ids("identifier", "type_identifier"));

    public static readonly LanguageSpec Go = new("Go",
        Map((".go", "Go")),
        Kind(("type_spec", "type"), ("function_declaration", "function"), ("method_declaration", "method")),
        Ids("identifier", "type_identifier", "field_identifier", "package_identifier"));

    public static readonly LanguageSpec Php = new("PHP",
        Map((".php", "PHP"), (".phtml", "PHP")),
        Kind(("class_declaration", "class"), ("interface_declaration", "interface"), ("trait_declaration", "trait"),
             ("enum_declaration", "enum"), ("function_definition", "function"), ("method_declaration", "method")),
        Ids("name", "identifier", "variable_name"));

    public static readonly LanguageSpec Ruby = new("Ruby",
        Map((".rb", "Ruby"), (".rake", "Ruby")),
        Kind(("class", "class"), ("module", "module"), ("method", "method"), ("singleton_method", "method")),
        Ids("identifier", "constant"));

    public static readonly LanguageSpec Rust = new("Rust",
        Map((".rs", "Rust")),
        Kind(("struct_item", "struct"), ("enum_item", "enum"), ("trait_item", "trait"),
             ("function_item", "function"), ("mod_item", "module"), ("type_item", "type")),
        Ids("identifier", "type_identifier", "field_identifier"));

    public static readonly LanguageSpec Scala = new("Scala",
        Map((".scala", "Scala"), (".sc", "Scala")),
        Kind(("class_definition", "class"), ("object_definition", "object"), ("trait_definition", "trait"),
             ("function_definition", "function")),
        Ids("identifier", "type_identifier"));

    public static readonly LanguageSpec C = new("C",
        Map((".c", "C"), (".h", "C")),
        Kind(("struct_specifier", "struct"), ("union_specifier", "union"), ("enum_specifier", "enum"),
             ("function_definition", "function")),
        CommonIds, NameViaDeclarator: true);

    public static readonly LanguageSpec Cpp = new("C++",
        Map((".cpp", "Cpp"), (".cc", "Cpp"), (".cxx", "Cpp"), (".hpp", "Cpp"), (".hh", "Cpp"), (".hxx", "Cpp")),
        Kind(("class_specifier", "class"), ("struct_specifier", "struct"), ("enum_specifier", "enum"),
             ("namespace_definition", "namespace"), ("function_definition", "function")),
        Ids("identifier", "type_identifier", "field_identifier", "namespace_identifier"),
        NameViaDeclarator: true);

    public static readonly LanguageSpec Bash = new("Shell",
        Map((".sh", "Bash"), (".bash", "Bash")),
        Kind(("function_definition", "function")),
        Ids("word", "variable_name"));

    /// <summary>All config-driven languages, in registration order.</summary>
    public static readonly IReadOnlyList<LanguageSpec> All =
        new[] { Python, Go, Php, Ruby, Rust, Scala, C, Cpp, Bash };
}

/// <summary>Java — classes, interfaces, enums, records, methods.</summary>
public sealed class JavaTreeSitterIndexer : TreeSitterIndexer
{
    private static readonly Dictionary<string, string> Exts =
        new(StringComparer.OrdinalIgnoreCase) { [".java"] = "Java" };
    public JavaTreeSitterIndexer(ILogger logger) : base(logger, Exts) { }
    public override string Name => "Java";
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
    private static readonly Dictionary<string, string> Exts =
        new(StringComparer.OrdinalIgnoreCase)
        {
            [".ts"] = "TypeScript", [".tsx"] = "TSX", [".jsx"] = "TSX",
            [".js"] = "JavaScript", [".mjs"] = "JavaScript", [".cjs"] = "JavaScript",
        };
    public TypeScriptTreeSitterIndexer(ILogger logger) : base(logger, Exts) { }
    public override string Name => "TypeScript/JS";
    protected override string? KindFor(Node n) => n.Type switch
    {
        "class_declaration" or "abstract_class_declaration" => "class",
        "interface_declaration" => "interface",
        "enum_declaration" => "enum",
        "type_alias_declaration" => "type",
        "function_declaration" or "generator_function_declaration" => "function",
        "method_definition" => "method",
        // const Foo = (...) => ... / = function(...) — React components & arrow functions.
        // Field() not n["value"]: an uninitialised declarator has no value field and the
        // binding throws rather than returning null.
        "variable_declarator" => Field(n, "value")?.Type is "arrow_function" or "function" or "function_expression" ? "function" : null,
        _ => null,
    };
}
