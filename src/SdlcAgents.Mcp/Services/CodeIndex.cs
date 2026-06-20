using System.Collections.Concurrent;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;
using Microsoft.Extensions.Logging;

namespace SdlcAgents.Mcp.Services;

/// <summary>
/// A symbol/reference index over a target C# source tree, built with Roslyn.
///
/// Uses *syntactic* analysis only — it parses every .cs file into a SyntaxTree and
/// indexes declarations + identifier tokens. This needs no compilation/build of the
/// target (important: nopCommerce 3.90 is legacy .NET Framework 4.5.1), so it is robust
/// and fast. The trade-off is that references are name-based "candidate" matches rather
/// than fully semantically resolved — accurate enough for impact-analysis demos and
/// clearly labelled as such.
/// </summary>
public sealed class CodeIndex
{
    private readonly ILogger<CodeIndex> _logger;
    private readonly object _gate = new();
    private volatile bool _built;

    private readonly List<SourceFile> _files = new();
    // Project/config/build files (.csproj, packages.config, web.config, .sln, .json…):
    // available to read_file + search_code, but NOT Roslyn-parsed for symbols.
    private readonly List<SourceFile> _aux = new();
    // symbol name (case-sensitive) -> declarations
    private readonly Dictionary<string, List<SymbolDef>> _symbols = new(StringComparer.Ordinal);

    public string Root { get; }
    public string ArtifactsDir { get; }

    public CodeIndex(ILogger<CodeIndex> logger)
    {
        _logger = logger;

        Root = Environment.GetEnvironmentVariable("NOPCOMMERCE_ROOT")
               ?? Environment.GetEnvironmentVariable("SOURCE_ROOT")
               ?? Directory.GetCurrentDirectory();
        Root = Path.GetFullPath(Root);

        ArtifactsDir = Environment.GetEnvironmentVariable("ARTIFACTS_DIR")
                       ?? Path.Combine(Directory.GetCurrentDirectory(), "artifacts");
        ArtifactsDir = Path.GetFullPath(ArtifactsDir);
    }

    private static readonly string[] SkipDirs =
        { "bin", "obj", "packages", ".git", ".vs", "node_modules", "TestResults" };

    /// <summary>Build the index once, on first use. Thread-safe.</summary>
    public void EnsureBuilt()
    {
        if (_built) return;
        lock (_gate)
        {
            if (_built) return;
            Build();
            _built = true;
        }
    }

    private void Build()
    {
        _logger.LogInformation("Building code index from {Root}", Root);
        if (!Directory.Exists(Root))
        {
            _logger.LogWarning("Source root does not exist: {Root}", Root);
            return;
        }

        var csFiles = EnumerateSourceFiles(Root).ToList();
        var bag = new ConcurrentBag<SourceFile>();

        Parallel.ForEach(csFiles, path =>
        {
            try
            {
                var text = File.ReadAllText(path);
                var tree = CSharpSyntaxTree.ParseText(SourceText.From(text), path: path);
                bag.Add(new SourceFile(ToRelative(path), path, tree, text));
            }
            catch (Exception ex)
            {
                _logger.LogDebug(ex, "Skipping unpar. {Path}", path);
            }
        });

        _files.AddRange(bag);
        foreach (var f in _files)
            IndexDeclarations(f);

        // Project/config/build files — readable + searchable, not symbol-parsed.
        foreach (var path in EnumerateAuxFiles(Root))
        {
            try { _aux.Add(new SourceFile(ToRelative(path), path, null, File.ReadAllText(path))); }
            catch (Exception ex) { _logger.LogDebug(ex, "Skipping aux {Path}", path); }
        }

        _logger.LogInformation("Indexed {Files} C# files ({Aux} project/config files), {Symbols} declared symbols",
            _files.Count, _aux.Count, _symbols.Values.Sum(v => v.Count));
    }

    // Build/config/project files that agents (CI/CD, Dependency, Modernization) need to read.
    private static readonly string[] AuxExtensions =
        { ".csproj", ".sln", ".props", ".targets", ".config", ".nuspec", ".json", ".yml", ".yaml", ".xml" };

    private IEnumerable<string> EnumerateAuxFiles(string root)
    {
        var stack = new Stack<string>();
        stack.Push(root);
        while (stack.Count > 0)
        {
            var dir = stack.Pop();
            IEnumerable<string> subDirs;
            try { subDirs = Directory.EnumerateDirectories(dir); }
            catch { continue; }
            foreach (var sub in subDirs)
            {
                if (SkipDirs.Contains(Path.GetFileName(sub), StringComparer.OrdinalIgnoreCase)) continue;
                stack.Push(sub);
            }

            IEnumerable<string> files;
            try { files = Directory.EnumerateFiles(dir); }
            catch { continue; }
            foreach (var f in files)
            {
                var ext = Path.GetExtension(f).ToLowerInvariant();
                if (!AuxExtensions.Contains(ext)) continue;
                // Cap noisy/data formats by size to avoid bloating the index (build files are small).
                if ((ext is ".json" or ".xml" or ".yml" or ".yaml"))
                {
                    try { if (new FileInfo(f).Length > 96 * 1024) continue; } catch { continue; }
                }
                yield return f;
            }
        }
    }

    private IEnumerable<string> EnumerateSourceFiles(string root)
    {
        var stack = new Stack<string>();
        stack.Push(root);
        while (stack.Count > 0)
        {
            var dir = stack.Pop();
            IEnumerable<string> subDirs;
            try { subDirs = Directory.EnumerateDirectories(dir); }
            catch { continue; }

            foreach (var sub in subDirs)
            {
                var name = Path.GetFileName(sub);
                if (SkipDirs.Contains(name, StringComparer.OrdinalIgnoreCase)) continue;
                stack.Push(sub);
            }

            IEnumerable<string> files;
            try { files = Directory.EnumerateFiles(dir, "*.cs"); }
            catch { continue; }

            foreach (var f in files)
            {
                // skip auto-generated designer/assembly files — noise for a demo
                var fn = Path.GetFileName(f);
                if (fn.EndsWith(".designer.cs", StringComparison.OrdinalIgnoreCase)) continue;
                if (fn.Equals("AssemblyInfo.cs", StringComparison.OrdinalIgnoreCase)) continue;
                yield return f;
            }
        }
    }

    private void IndexDeclarations(SourceFile file)
    {
        var rootNode = file.Tree.GetRoot();
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

    // ---- Query surface used by the tool classes -------------------------------------

    public IReadOnlyList<SourceFile> Files { get { EnsureBuilt(); return _files; } }

    public IReadOnlyList<SymbolDef> FindDeclarations(string name)
    {
        EnsureBuilt();
        return _symbols.TryGetValue(name, out var list) ? list : Array.Empty<SymbolDef>();
    }

    /// <summary>
    /// Candidate references: identifier tokens across all files matching <paramref name="name"/>,
    /// excluding the declaration tokens themselves.
    /// </summary>
    public IReadOnlyList<Reference> FindReferences(string name)
    {
        EnsureBuilt();
        var results = new List<Reference>();
        foreach (var file in _files)
        {
            var rootNode = file.Tree.GetRoot();
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

    public IReadOnlyList<Reference> SearchText(string query, bool regex, int max)
    {
        EnsureBuilt();
        var results = new List<Reference>();
        System.Text.RegularExpressions.Regex? rx = null;
        if (regex)
        {
            try { rx = new System.Text.RegularExpressions.Regex(query, System.Text.RegularExpressions.RegexOptions.IgnoreCase); }
            catch { rx = null; }
        }

        foreach (var file in _files.Concat(_aux))
        {
            var lines = file.Text.Split('\n');
            for (int i = 0; i < lines.Length; i++)
            {
                var hit = rx != null
                    ? rx.IsMatch(lines[i])
                    : lines[i].Contains(query, StringComparison.OrdinalIgnoreCase);
                if (!hit) continue;
                results.Add(new Reference(file.RelativePath, i + 1, lines[i].Trim()));
                if (results.Count >= max) return results;
            }
        }
        return results;
    }

    public SourceFile? GetFile(string relativeOrName)
    {
        EnsureBuilt();
        var normalized = relativeOrName.Replace('\\', '/').TrimStart('/');
        var all = _files.Concat(_aux).ToList();
        return all.FirstOrDefault(f =>
                   f.RelativePath.Replace('\\', '/').Equals(normalized, StringComparison.OrdinalIgnoreCase))
               ?? all.FirstOrDefault(f =>
                   f.RelativePath.Replace('\\', '/').EndsWith("/" + normalized, StringComparison.OrdinalIgnoreCase))
               ?? all.FirstOrDefault(f =>
                   Path.GetFileName(f.RelativePath).Equals(Path.GetFileName(normalized), StringComparison.OrdinalIgnoreCase));
    }

    public IReadOnlyList<string> Projects()
    {
        EnsureBuilt();
        var projects = new List<string>();
        if (!Directory.Exists(Root)) return projects;
        foreach (var proj in Directory.EnumerateFiles(Root, "*.csproj", SearchOption.AllDirectories))
        {
            var name = Path.GetFileName(Path.GetDirectoryName(proj));
            if (SkipDirs.Contains(name ?? "", StringComparer.OrdinalIgnoreCase)) continue;
            projects.Add(ToRelative(proj));
        }
        return projects.OrderBy(p => p, StringComparer.OrdinalIgnoreCase).ToList();
    }

    private static string GetLineText(SourceFile file, int zeroBasedLine)
    {
        var textLine = file.Tree.GetText().Lines;
        if (zeroBasedLine < 0 || zeroBasedLine >= textLine.Count) return string.Empty;
        return textLine[zeroBasedLine].ToString();
    }

    private string ToRelative(string fullPath)
    {
        var rel = Path.GetRelativePath(Root, fullPath);
        return rel.Replace('\\', '/');
    }
}

public sealed record SourceFile(string RelativePath, string FullPath, SyntaxTree? Tree, string Text);

public sealed record SymbolDef(string Name, string Kind, string? Container, string File, int Line, string Signature);

public sealed record Reference(string File, int Line, string Text);
