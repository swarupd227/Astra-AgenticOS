using System.Collections.Concurrent;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;
using Microsoft.Extensions.Logging;

namespace SdlcAgents.Mcp.Services;

/// <summary>
/// C# indexer — Roslyn *syntactic* analysis (parse only, no build). This is the
/// original CodeIndex logic moved behind <see cref="ILanguageIndexer"/> unchanged,
/// so C# results are byte-identical to before the multi-language refactor.
/// </summary>
public sealed class CSharpIndexer : ILanguageIndexer
{
    private readonly ILogger _logger;
    private readonly List<SourceFile> _files = new();
    private readonly Dictionary<string, List<SymbolDef>> _symbols = new(StringComparer.Ordinal);

    public CSharpIndexer(ILogger logger) => _logger = logger;

    public string Name => "C#";
    public bool Handles(string extensionLower) => extensionLower == ".cs";
    public IReadOnlyList<SourceFile> Files => _files;

    public void Build(IReadOnlyList<(string Rel, string Full)> files)
    {
        var bag = new ConcurrentBag<SourceFile>();
        Parallel.ForEach(files, item =>
        {
            var (rel, full) = item;
            // skip auto-generated designer/assembly files — noise for a demo
            var fn = Path.GetFileName(full);
            if (fn.EndsWith(".designer.cs", StringComparison.OrdinalIgnoreCase)) return;
            if (fn.Equals("AssemblyInfo.cs", StringComparison.OrdinalIgnoreCase)) return;
            try
            {
                var text = File.ReadAllText(full);
                var tree = CSharpSyntaxTree.ParseText(SourceText.From(text), path: full);
                bag.Add(new SourceFile(rel, full, tree, text));
            }
            catch (Exception ex)
            {
                _logger.LogDebug(ex, "Skipping unpar. {Path}", full);
            }
        });

        _files.AddRange(bag);
        foreach (var f in _files)
            IndexDeclarations(f);
    }

    private void IndexDeclarations(SourceFile file)
    {
        var rootNode = file.Tree!.GetRoot();
        foreach (var node in rootNode.DescendantNodes())
        {
            switch (node)
            {
                case ClassDeclarationSyntax c:
                    Add(c.Identifier.ValueText, "class", null, file, c.Identifier.GetLocation(), c.Identifier.ValueText);
                    break;
                case InterfaceDeclarationSyntax i:
                    Add(i.Identifier.ValueText, "interface", null, file, i.Identifier.GetLocation(), i.Identifier.ValueText);
                    break;
                case StructDeclarationSyntax s:
                    Add(s.Identifier.ValueText, "struct", null, file, s.Identifier.GetLocation(), s.Identifier.ValueText);
                    break;
                case EnumDeclarationSyntax e:
                    Add(e.Identifier.ValueText, "enum", null, file, e.Identifier.GetLocation(), e.Identifier.ValueText);
                    break;
                case MethodDeclarationSyntax m:
                    Add(m.Identifier.ValueText, "method", ContainerName(m), file, m.Identifier.GetLocation(),
                        $"{m.ReturnType} {m.Identifier}{m.ParameterList}");
                    break;
                case PropertyDeclarationSyntax p:
                    Add(p.Identifier.ValueText, "property", ContainerName(p), file, p.Identifier.GetLocation(),
                        $"{p.Type} {p.Identifier}");
                    break;
            }
        }
    }

    private static string? ContainerName(SyntaxNode node)
    {
        var t = node.Ancestors().OfType<TypeDeclarationSyntax>().FirstOrDefault();
        return t?.Identifier.ValueText;
    }

    private void Add(string name, string kind, string? container, SourceFile file, Location loc, string signature)
    {
        var line = loc.GetLineSpan().StartLinePosition.Line + 1;
        if (!_symbols.TryGetValue(name, out var list))
            _symbols[name] = list = new List<SymbolDef>();
        list.Add(new SymbolDef(name, kind, container, file.RelativePath, line, signature));
    }

    public IReadOnlyList<SymbolDef> FindDeclarations(string name)
        => _symbols.TryGetValue(name, out var list) ? list : Array.Empty<SymbolDef>();

    /// <summary>
    /// Candidate references: identifier tokens across all C# files matching
    /// <paramref name="name"/>, excluding the declaration tokens themselves.
    /// </summary>
    public IReadOnlyList<Reference> FindReferences(string name)
    {
        var results = new List<Reference>();
        foreach (var file in _files)
        {
            var rootNode = file.Tree!.GetRoot();
            foreach (var token in rootNode.DescendantTokens())
            {
                if (!token.IsKind(SyntaxKind.IdentifierToken)) continue;
                if (!string.Equals(token.ValueText, name, StringComparison.Ordinal)) continue;

                // skip the declaration identifier itself
                if (IsDeclarationName(token)) continue;

                var line = token.GetLocation().GetLineSpan().StartLinePosition.Line;
                var lineText = GetLineText(file, line);
                results.Add(new Reference(file.RelativePath, line + 1, lineText.Trim()));
            }
        }
        return results;
    }

    private static bool IsDeclarationName(SyntaxToken token)
    {
        return token.Parent switch
        {
            BaseTypeDeclarationSyntax t => t.Identifier == token,
            MethodDeclarationSyntax m => m.Identifier == token,
            PropertyDeclarationSyntax p => p.Identifier == token,
            _ => false
        };
    }

    private static string GetLineText(SourceFile file, int zeroBasedLine)
    {
        var textLine = file.Tree!.GetText().Lines;
        if (zeroBasedLine < 0 || zeroBasedLine >= textLine.Count) return string.Empty;
        return textLine[zeroBasedLine].ToString();
    }
}
