using System.ComponentModel;
using System.Text;
using ModelContextProtocol.Server;
using SdlcAgents.Mcp.Services;

namespace SdlcAgents.Mcp.Tools;

/// <summary>
/// Read-only navigation over the target codebase. These are the "eyes" the SDLC agents
/// use to ground every answer in real source rather than guessing.
/// </summary>
[McpServerToolType]
public static class CodeSearchTools
{
    [McpServerTool(Name = "solution_overview")]
    [Description("Return a high-level map of the target .NET solution: every project (.csproj) grouped by layer (Libraries, Presentation, Plugins, Tests). Use this first to orient before deeper analysis.")]
    public static string SolutionOverview(CodeIndex index)
    {
        var projects = index.Projects();
        if (projects.Count == 0)
            return $"No projects found under source root: {index.Root}";

        var groups = projects
            .GroupBy(p => p.Contains('/') ? p.Split('/')[0] : "(root)")
            .OrderBy(g => g.Key, StringComparer.OrdinalIgnoreCase);

        var sb = new StringBuilder();
        sb.AppendLine($"# Solution overview ({projects.Count} projects)");
        sb.AppendLine($"Source root: `{index.Root}`");
        sb.AppendLine($"Indexed C# files: {index.Files.Count}");
        sb.AppendLine();
        foreach (var g in groups)
        {
            sb.AppendLine($"## {g.Key}");
            foreach (var p in g.OrderBy(x => x, StringComparer.OrdinalIgnoreCase))
                sb.AppendLine($"- `{p}`");
            sb.AppendLine();
        }
        return sb.ToString();
    }

    [McpServerTool(Name = "find_symbol")]
    [Description("Locate where a type, method, or property is DECLARED. Returns kind, containing type, file path and line for each declaration. Input is a simple name, e.g. 'TaxService' or 'GetTaxRate'.")]
    public static string FindSymbol(
        CodeIndex index,
        [Description("Simple symbol name (class/interface/method/property). No namespace.")] string name)
    {
        var defs = index.FindDeclarations(name);
        if (defs.Count == 0)
            return $"No declarations found for '{name}'. Try find_symbol with a different name, or search_code.";

        var sb = new StringBuilder();
        sb.AppendLine($"# Declarations of '{name}' ({defs.Count})");
        foreach (var d in defs.OrderBy(d => d.File, StringComparer.OrdinalIgnoreCase))
        {
            var container = d.Container is null ? "" : $" in `{d.Container}`";
            sb.AppendLine($"- **{d.Kind}**{container} — `{d.File}:{d.Line}`  \n  `{d.Signature}`");
        }
        return sb.ToString();
    }

    [McpServerTool(Name = "search_code")]
    [Description("Search the codebase for a substring or regular expression across all C# files. Returns file:line and the matching line. Use for finding business rules, config keys, strings, or patterns when you don't have an exact symbol name.")]
    public static string SearchCode(
        CodeIndex index,
        [Description("Text to find. Substring by default; set regex=true to treat as a .NET regex.")] string query,
        [Description("Treat query as a regular expression.")] bool regex = false,
        [Description("Maximum number of matches to return (default 50).")] int maxResults = 50)
    {
        if (maxResults <= 0) maxResults = 50;
        var hits = index.SearchText(query, regex, maxResults);
        if (hits.Count == 0)
            return $"No matches for '{query}'.";

        var sb = new StringBuilder();
        sb.AppendLine($"# {hits.Count} match(es) for '{query}'" + (hits.Count >= maxResults ? " (truncated)" : ""));
        foreach (var h in hits)
            sb.AppendLine($"- `{h.File}:{h.Line}` — `{Trunc(h.Text, 160)}`");
        return sb.ToString();
    }

    [McpServerTool(Name = "read_file")]
    [Description("Return the source of a file (or a line range of it) from the target codebase, with line numbers. Accepts a repo-relative path, a partial path, or just a file name. Use after find_symbol/analyze_impact to read the actual code.")]
    public static string ReadFile(
        CodeIndex index,
        [Description("Repo-relative path, partial path, or file name, e.g. 'Libraries/Nop.Services/Tax/TaxService.cs' or 'TaxService.cs'.")] string path,
        [Description("Optional 1-based start line.")] int startLine = 1,
        [Description("Optional 1-based end line. 0 or omitted means end of file.")] int endLine = 0)
    {
        var file = index.GetFile(path);
        if (file is null)
            return $"File not found: '{path}'. Use search_code or find_symbol to discover the correct path.";

        var lines = file.Text.Replace("\r\n", "\n").Split('\n');
        if (startLine < 1) startLine = 1;
        if (endLine <= 0 || endLine > lines.Length) endLine = lines.Length;
        if (startLine > lines.Length) startLine = lines.Length;

        var fence = Path.GetExtension(file.RelativePath).ToLowerInvariant() switch
        {
            ".cs" => "csharp",
            ".csproj" or ".config" or ".props" or ".targets" or ".nuspec" or ".xml" => "xml",
            ".json" => "json",
            ".yml" or ".yaml" => "yaml",
            _ => "",
        };
        var sb = new StringBuilder();
        sb.AppendLine($"# `{file.RelativePath}` (lines {startLine}-{endLine} of {lines.Length})");
        sb.AppendLine("```" + fence);
        for (int i = startLine; i <= endLine; i++)
            sb.AppendLine($"{i,5}  {lines[i - 1]}");
        sb.AppendLine("```");
        return sb.ToString();
    }

    private static string Trunc(string s, int n) => s.Length <= n ? s : s[..n] + "…";
}
