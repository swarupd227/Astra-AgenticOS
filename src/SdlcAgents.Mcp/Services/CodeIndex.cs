using Microsoft.Extensions.Logging;

namespace SdlcAgents.Mcp.Services;

/// <summary>
/// A symbol/reference index over a target source tree. Language-neutral: it walks
/// the tree, routes each source file to the matching <see cref="ILanguageIndexer"/>
/// (Roslyn for C#; lightweight syntactic for Java / TypeScript / JS), and aggregates
/// their declarations and references. Config/build files are read + searchable but
/// not symbol-parsed.
///
/// All analysis is *syntactic* only — no compilation of the target is required
/// (important for legacy .NET Framework, and for brownfield code that won't build).
/// References are name-based "candidate" matches rather than fully semantically
/// resolved — accurate enough for impact analysis and clearly labelled as such.
/// The public query surface below is unchanged from the original C#-only index, so
/// the tools that call it are unaffected.
/// </summary>
public sealed class CodeIndex
{
    private readonly ILogger<CodeIndex> _logger;
    private readonly object _gate = new();
    private volatile bool _built;

    private readonly ILanguageIndexer[] _indexers;
    // Project/config/build files (.csproj, pom.xml, package.json, web.config, .json…):
    // available to read_file + search_code, but NOT symbol-parsed.
    private readonly List<SourceFile> _aux = new();

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

        _indexers = new ILanguageIndexer[]
        {
            new CSharpIndexer(_logger),
            new JavaIndexer(_logger),
            new TypeScriptIndexer(_logger),
        };
    }

    private static readonly string[] SkipDirs =
        { "bin", "obj", "packages", ".git", ".vs", "node_modules", "TestResults", "dist", "build", ".angular", ".next", "target", "out" };

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

    // Build/config/project files that agents (CI/CD, Dependency, Modernization) need to read.
    private static readonly string[] AuxExtensions =
        { ".csproj", ".sln", ".props", ".targets", ".config", ".nuspec", ".json", ".yml", ".yaml", ".xml",
          ".gradle", ".properties", ".html", ".htm", ".scss", ".css" };

    private void Build()
    {
        _logger.LogInformation("Building code index from {Root}", Root);
        if (!Directory.Exists(Root))
        {
            _logger.LogWarning("Source root does not exist: {Root}", Root);
            return;
        }

        var buckets = _indexers.ToDictionary(ix => ix, _ => new List<(string, string)>());

        var stack = new Stack<string>();
        stack.Push(Root);
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
                // Skip minified/bundled build artifacts — they're one-line noise, not source.
                var fileName = Path.GetFileName(f);
                if (fileName.Contains(".min.", StringComparison.OrdinalIgnoreCase)) continue;

                var ext = Path.GetExtension(f).ToLowerInvariant();

                var ix = Array.Find(_indexers, i => i.Handles(ext));
                if (ix != null)
                {
                    buckets[ix].Add((ToRelative(f), f));
                    continue;
                }

                if (AuxExtensions.Contains(ext))
                {
                    // Cap noisy/data formats by size to avoid bloating the index (build files are small).
                    if (ext is ".json" or ".xml" or ".yml" or ".yaml" or ".html" or ".htm" or ".scss" or ".css")
                    {
                        try { if (new FileInfo(f).Length > 96 * 1024) continue; } catch { continue; }
                    }
                    try { _aux.Add(new SourceFile(ToRelative(f), f, null, File.ReadAllText(f))); }
                    catch (Exception ex) { _logger.LogDebug(ex, "Skipping aux {Path}", f); }
                }
            }
        }

        foreach (var ix in _indexers)
            ix.Build(buckets[ix]);

        var perLang = string.Join(", ", _indexers.Where(i => i.Files.Count > 0).Select(i => $"{i.Files.Count} {i.Name}"));
        _logger.LogInformation("Indexed {Files} source files ({PerLang}); {Aux} project/config files",
            _indexers.Sum(i => i.Files.Count), string.IsNullOrEmpty(perLang) ? "none" : perLang, _aux.Count);
    }

    // ---- Query surface used by the tool classes (unchanged shapes) ------------------

    private IEnumerable<SourceFile> AllSourceFiles => _indexers.SelectMany(i => i.Files);

    public IReadOnlyList<SourceFile> Files
    {
        get { EnsureBuilt(); return AllSourceFiles.ToList(); }
    }

    public IReadOnlyList<SymbolDef> FindDeclarations(string name)
    {
        EnsureBuilt();
        var all = new List<SymbolDef>();
        foreach (var ix in _indexers) all.AddRange(ix.FindDeclarations(name));
        return all;
    }

    public IReadOnlyList<Reference> FindReferences(string name)
    {
        EnsureBuilt();
        var all = new List<Reference>();
        foreach (var ix in _indexers) all.AddRange(ix.FindReferences(name));
        return all;
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

        foreach (var file in AllSourceFiles.Concat(_aux))
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
        var all = AllSourceFiles.Concat(_aux).ToList();
        return all.FirstOrDefault(f =>
                   f.RelativePath.Replace('\\', '/').Equals(normalized, StringComparison.OrdinalIgnoreCase))
               ?? all.FirstOrDefault(f =>
                   f.RelativePath.Replace('\\', '/').EndsWith("/" + normalized, StringComparison.OrdinalIgnoreCase))
               ?? all.FirstOrDefault(f =>
                   Path.GetFileName(f.RelativePath).Equals(Path.GetFileName(normalized), StringComparison.OrdinalIgnoreCase));
    }

    // Manifest/project files across ecosystems: .NET, Java (Maven/Gradle), Node (npm/Angular).
    private static readonly string[] ProjectManifests =
        { "*.csproj", "pom.xml", "build.gradle", "build.gradle.kts", "package.json" };

    public IReadOnlyList<string> Projects()
    {
        EnsureBuilt();
        var projects = new List<string>();
        if (!Directory.Exists(Root)) return projects;

        foreach (var pattern in ProjectManifests)
        {
            IEnumerable<string> matches;
            try { matches = Directory.EnumerateFiles(Root, pattern, SearchOption.AllDirectories); }
            catch { continue; }
            foreach (var proj in matches)
            {
                var rel = ToRelative(proj);
                // skip anything under a build/vendor directory anywhere in its path
                if (rel.Split('/').Any(seg => SkipDirs.Contains(seg, StringComparer.OrdinalIgnoreCase))) continue;
                projects.Add(rel);
            }
        }
        return projects.Distinct().OrderBy(p => p, StringComparer.OrdinalIgnoreCase).ToList();
    }

    private string ToRelative(string fullPath)
    {
        var rel = Path.GetRelativePath(Root, fullPath);
        return rel.Replace('\\', '/');
    }
}

public sealed record SourceFile(string RelativePath, string FullPath, Microsoft.CodeAnalysis.SyntaxTree? Tree, string Text);

public sealed record SymbolDef(string Name, string Kind, string? Container, string File, int Line, string Signature);

public sealed record Reference(string File, int Line, string Text);
