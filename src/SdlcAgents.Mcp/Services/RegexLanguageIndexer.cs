using System.Collections.Concurrent;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Logging;

namespace SdlcAgents.Mcp.Services;

/// <summary>
/// A lightweight, dependency-free syntactic indexer for languages we don't have a
/// full parser for yet (Java, TypeScript/JS). It extracts the primary declarations
/// (types, methods/functions) with line-anchored regexes and finds candidate
/// references by whole-word identifier match — the same "syntactic candidate"
/// model the C# indexer already exposes, just without a formal grammar.
///
/// This is deliberately the drop-in point for a real tree-sitter backend: replace
/// the parsing here with tree-sitter queries and nothing above this class changes.
/// Declarations/references from here are clearly first-cut and best treated as
/// candidates to confirm with read_file.
/// </summary>
public abstract class RegexLanguageIndexer : ILanguageIndexer
{
    private readonly ILogger _logger;
    private readonly List<SourceFile> _files = new();
    private readonly Dictionary<string, List<SymbolDef>> _symbols = new(StringComparer.Ordinal);
    // "relpath|line" of every declaration, so a name isn't reported as a reference to itself.
    private readonly HashSet<string> _declSites = new(StringComparer.Ordinal);

    protected RegexLanguageIndexer(ILogger logger) => _logger = logger;

    public abstract string Name { get; }
    protected abstract IReadOnlyCollection<string> Extensions { get; }
    /// <summary>Ordered declaration patterns: each captures the symbol name in group "name".</summary>
    protected abstract IReadOnlyList<(Regex Rx, string Kind)> DeclarationPatterns { get; }

    public bool Handles(string extensionLower) => Extensions.Contains(extensionLower);
    public IReadOnlyList<SourceFile> Files => _files;

    public void Build(IReadOnlyList<(string Rel, string Full)> files)
    {
        var bag = new ConcurrentBag<SourceFile>();
        Parallel.ForEach(files, item =>
        {
            try { bag.Add(new SourceFile(item.Rel, item.Full, null, File.ReadAllText(item.Full))); }
            catch (Exception ex) { _logger.LogDebug(ex, "Skipping {Path}", item.Full); }
        });
        _files.AddRange(bag);

        foreach (var f in _files)
            IndexDeclarations(f);
    }

    private void IndexDeclarations(SourceFile file)
    {
        var lines = file.Text.Replace("\r\n", "\n").Split('\n');
        for (int i = 0; i < lines.Length; i++)
        {
            var line = lines[i];
            // skip obvious comment lines to cut false positives
            var trimmed = line.TrimStart();
            if (trimmed.StartsWith("//") || trimmed.StartsWith("*") || trimmed.StartsWith("/*")) continue;

            foreach (var (rx, kind) in DeclarationPatterns)
            {
                var m = rx.Match(line);
                if (!m.Success) continue;
                var name = m.Groups["name"].Value;
                if (string.IsNullOrEmpty(name)) continue;
                Add(name, kind, file.RelativePath, i + 1, trimmed.Length > 200 ? trimmed[..200] : trimmed);
                break; // one declaration kind per line
            }
        }
    }

    private void Add(string name, string kind, string file, int line, string signature)
    {
        if (!_symbols.TryGetValue(name, out var list))
            _symbols[name] = list = new List<SymbolDef>();
        list.Add(new SymbolDef(name, kind, null, file, line, signature));
        _declSites.Add($"{file}|{line}");
    }

    public IReadOnlyList<SymbolDef> FindDeclarations(string name)
        => _symbols.TryGetValue(name, out var list) ? list : Array.Empty<SymbolDef>();

    public IReadOnlyList<Reference> FindReferences(string name)
    {
        if (string.IsNullOrEmpty(name)) return Array.Empty<Reference>();
        // whole-word identifier match (JS/TS allow $), so 'Order' doesn't match 'OrderService'
        var rx = new Regex($@"(?<![\w$]){Regex.Escape(name)}(?![\w$])");
        var results = new List<Reference>();
        foreach (var file in _files)
        {
            var lines = file.Text.Replace("\r\n", "\n").Split('\n');
            for (int i = 0; i < lines.Length; i++)
            {
                if (!rx.IsMatch(lines[i])) continue;
                // don't report the declaration line of this same name as a reference
                if (_declSites.Contains($"{file.RelativePath}|{i + 1}") &&
                    FindDeclarations(name).Any(d => d.File == file.RelativePath && d.Line == i + 1))
                    continue;
                results.Add(new Reference(file.RelativePath, i + 1, lines[i].Trim()));
            }
        }
        return results;
    }
}

/// <summary>Java — classes, interfaces, enums, records, and method declarations.</summary>
public sealed class JavaIndexer : RegexLanguageIndexer
{
    public JavaIndexer(ILogger logger) : base(logger) { }
    public override string Name => "Java";
    protected override IReadOnlyCollection<string> Extensions { get; } = new[] { ".java" };

    private const RegexOptions O = RegexOptions.Compiled | RegexOptions.CultureInvariant;
    protected override IReadOnlyList<(Regex Rx, string Kind)> DeclarationPatterns { get; } = new (Regex, string)[]
    {
        (new Regex(@"\bclass\s+(?<name>[A-Za-z_]\w*)", O), "class"),
        (new Regex(@"\binterface\s+(?<name>[A-Za-z_]\w*)", O), "interface"),
        (new Regex(@"\benum\s+(?<name>[A-Za-z_]\w*)", O), "enum"),
        (new Regex(@"\brecord\s+(?<name>[A-Za-z_]\w*)", O), "record"),
        // method: [modifiers] <ReturnType> name(...)  with a body/throws — avoid control keywords
        (new Regex(@"^\s*(?:public|private|protected|static|final|abstract|synchronized|native|default|\s)*[\w<>\[\],.?&\s]+\s+(?<name>(?!if|for|while|switch|catch|return|new)[A-Za-z_]\w*)\s*\([^;{]*\)\s*(?:throws[\w,.\s]+)?\{?\s*$", O), "method"),
    };
}

/// <summary>TypeScript / JavaScript / TSX / JSX — types, functions, exported consts (React components), class methods.</summary>
public sealed class TypeScriptIndexer : RegexLanguageIndexer
{
    public TypeScriptIndexer(ILogger logger) : base(logger) { }
    public override string Name => "TypeScript/JS";
    protected override IReadOnlyCollection<string> Extensions { get; } = new[] { ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs" };

    private const RegexOptions O = RegexOptions.Compiled | RegexOptions.CultureInvariant;
    protected override IReadOnlyList<(Regex Rx, string Kind)> DeclarationPatterns { get; } = new (Regex, string)[]
    {
        (new Regex(@"\bclass\s+(?<name>[A-Za-z_$][\w$]*)", O), "class"),
        (new Regex(@"\binterface\s+(?<name>[A-Za-z_$][\w$]*)", O), "interface"),
        (new Regex(@"\benum\s+(?<name>[A-Za-z_$][\w$]*)", O), "enum"),
        (new Regex(@"\btype\s+(?<name>[A-Za-z_$][\w$]*)\s*[=<]", O), "type"),
        (new Regex(@"\bfunction\s*\*?\s+(?<name>[A-Za-z_$][\w$]*)", O), "function"),
        // exported/plain const arrow function or React component:  const Foo = (...) => / = async (
        (new Regex(@"\b(?:export\s+)?const\s+(?<name>[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>", O), "function"),
        // class method:  name(...) { / name(...):Type {  — skip control keywords and calls
        (new Regex(@"^\s*(?:public|private|protected|static|readonly|async|get|set|\s)*(?<name>(?!if|for|while|switch|catch|return|function|constructor)[A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^={]+)?\{", O), "method"),
    };
}
