using System.ComponentModel;
using System.Text;
using ModelContextProtocol.Server;
using SdlcAgents.Mcp.Services;

namespace SdlcAgents.Mcp.Tools;

/// <summary>
/// The impact-analysis centerpiece. Turns a single symbol into a grounded
/// "what breaks if I change this?" report using the real reference graph —
/// the local, free replacement for a commercial tool like CAST Imaging.
/// </summary>
[McpServerToolType]
public static class ImpactTools
{
    [McpServerTool(Name = "find_references")]
    [Description("Find all CANDIDATE references to a symbol (class/method/property) across the codebase. Name-based syntactic matching (declarations excluded). Returns file:line and the calling line. Use as raw input; prefer analyze_impact for a structured assessment.")]
    public static string FindReferences(
        CodeIndex index,
        [Description("Simple symbol name to find usages of, e.g. 'GetTaxRate'.")] string name,
        [Description("Maximum references to list (default 100).")] int maxResults = 100)
    {
        var refs = index.FindReferences(name);
        if (refs.Count == 0)
            return $"No references found for '{name}'.";

        var shown = refs.Take(maxResults).ToList();
        var sb = new StringBuilder();
        sb.AppendLine($"# {refs.Count} candidate reference(s) to '{name}'"
                      + (refs.Count > shown.Count ? $" (showing {shown.Count})" : ""));
        sb.AppendLine("_Syntactic name matches — verify overloads when precision matters._");
        sb.AppendLine();
        foreach (var r in shown)
            sb.AppendLine($"- `{r.File}:{r.Line}` — `{Trunc(r.Text, 140)}`");
        return sb.ToString();
    }

    [McpServerTool(Name = "analyze_impact")]
    [Description("Produce a structured change-impact assessment for a symbol: where it is declared, which files/layers depend on it (controllers, services, views, plugins), a risk rating, and a suggested regression-test set. This is the primary tool for the Impact Analysis agent.")]
    public static string AnalyzeImpact(
        CodeIndex index,
        [Description("Symbol to assess, e.g. 'TaxService' or 'GetTaxRate'.")] string name)
    {
        // In DI codebases the dependency surface lives on the interface, not the concrete
        // class. Treat a class and its 'I'-prefixed interface as one logical component so the
        // impact picture reflects reality (e.g. 'TaxService' <-> 'ITaxService').
        var related = RelatedNames(index, name);

        var defs = related.SelectMany(index.FindDeclarations)
                          .GroupBy(d => (d.File, d.Line)).Select(g => g.First()).ToList();
        var refs = related.SelectMany(index.FindReferences)
                          .GroupBy(r => (r.File, r.Line)).Select(g => g.First()).ToList();

        // Group references by file, dropping the declaring files' own self-references noise.
        var declFiles = defs.Select(d => d.File).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var byFile = refs
            .GroupBy(r => r.File, StringComparer.OrdinalIgnoreCase)
            .Select(g => new { File = g.Key, Count = g.Count(), Layer = Classify(g.Key) })
            .OrderByDescending(x => x.Count)
            .ToList();

        var dependentFiles = byFile.Where(x => !declFiles.Contains(x.File)).ToList();
        var layerCounts = dependentFiles
            .GroupBy(x => x.Layer)
            .ToDictionary(g => g.Key, g => g.Count());

        var testFiles = dependentFiles.Where(x => x.Layer == "Test").ToList();
        var controllers = dependentFiles.Where(x => x.Layer == "Controller").ToList();
        var views = dependentFiles.Where(x => x.Layer == "View/UI").ToList();
        var plugins = dependentFiles.Where(x => x.Layer == "Plugin").ToList();

        var risk = Risk(dependentFiles.Count, controllers.Count + views.Count, plugins.Count);

        var sb = new StringBuilder();
        sb.AppendLine($"# Impact analysis — `{name}`");
        if (related.Count > 1)
            sb.AppendLine($"_Analysed as one component: {string.Join(", ", related.Select(r => $"`{r}`"))}._");
        sb.AppendLine();

        sb.AppendLine("## Declaration(s)");
        if (defs.Count == 0) sb.AppendLine("- _No declaration found by name; treating as usage-only._");
        foreach (var d in defs)
            sb.AppendLine($"- {d.Kind} `{d.File}:{d.Line}` — `{d.Signature}`");
        sb.AppendLine();

        sb.AppendLine($"## Risk: **{risk}**");
        sb.AppendLine($"- Dependent files: **{dependentFiles.Count}**, total references: **{refs.Count}**");
        sb.AppendLine($"- Layers touched: " + (layerCounts.Count == 0 ? "_none_" :
            string.Join(", ", layerCounts.OrderByDescending(k => k.Value).Select(k => $"{k.Key} ({k.Value})"))));
        sb.AppendLine();

        sb.AppendLine("## Dependent files by layer");
        foreach (var layer in new[] { "Controller", "Service", "View/UI", "Domain/Model", "Data", "Plugin", "Test", "Other" })
        {
            var items = dependentFiles.Where(x => x.Layer == layer).ToList();
            if (items.Count == 0) continue;
            sb.AppendLine($"### {layer} ({items.Count})");
            foreach (var x in items.Take(25))
                sb.AppendLine($"- `{x.File}` ({x.Count} ref{(x.Count == 1 ? "" : "s")})");
            if (items.Count > 25) sb.AppendLine($"- …and {items.Count - 25} more");
            sb.AppendLine();
        }

        sb.AppendLine("## Suggested regression tests");
        if (testFiles.Count > 0)
        {
            sb.AppendLine("Existing tests that already touch this symbol — run/extend these first:");
            foreach (var t in testFiles) sb.AppendLine($"- `{t.File}`");
        }
        else
        {
            sb.AppendLine("- No existing tests reference this symbol directly — **coverage gap**. Add tests before changing it.");
        }
        if (controllers.Count > 0 || views.Count > 0)
            sb.AppendLine("- UI/endpoint impact detected — add integration/UI smoke tests for the affected controllers/views above.");
        sb.AppendLine();

        sb.AppendLine("> Note: references are syntactic candidate matches. For overloaded members, confirm the exact signature with `read_file`.");
        return sb.ToString();
    }

    /// <summary>
    /// Pairs a concrete class with its conventional 'I'-prefixed interface (and vice-versa)
    /// when both are declared in the codebase, so impact reflects the DI dependency surface.
    /// </summary>
    private static List<string> RelatedNames(CodeIndex index, string name)
    {
        var set = new HashSet<string>(StringComparer.Ordinal) { name };

        // class 'TaxService' -> interface 'ITaxService'
        var asInterface = "I" + name;
        if (index.FindDeclarations(asInterface).Any(d => d.Kind == "interface"))
            set.Add(asInterface);

        // interface 'ITaxService' -> class 'TaxService'
        if (name.Length > 1 && name[0] == 'I' && char.IsUpper(name[1]))
        {
            var asClass = name[1..];
            if (index.FindDeclarations(asClass).Any(d => d.Kind is "class" or "struct"))
                set.Add(asClass);
        }
        return set.ToList();
    }

    private static string Classify(string file)
    {
        var f = file.Replace('\\', '/');
        var name = f.Split('/').Last();
        if (f.Contains("/Tests/", StringComparison.OrdinalIgnoreCase) || name.Contains("Test", StringComparison.OrdinalIgnoreCase))
            return "Test";
        if (name.EndsWith("Controller.cs", StringComparison.OrdinalIgnoreCase) || f.Contains("/Controllers/", StringComparison.OrdinalIgnoreCase))
            return "Controller";
        if (f.Contains("/Plugins/", StringComparison.OrdinalIgnoreCase))
            return "Plugin";
        if (f.Contains("/Views/", StringComparison.OrdinalIgnoreCase) || name.EndsWith("Model.cs", StringComparison.OrdinalIgnoreCase) || f.Contains("/Models/", StringComparison.OrdinalIgnoreCase))
            return "View/UI";
        if (f.Contains("Nop.Services", StringComparison.OrdinalIgnoreCase) || name.EndsWith("Service.cs", StringComparison.OrdinalIgnoreCase))
            return "Service";
        if (f.Contains("Nop.Data", StringComparison.OrdinalIgnoreCase) || f.Contains("/Data/", StringComparison.OrdinalIgnoreCase) || name.Contains("Repository", StringComparison.OrdinalIgnoreCase))
            return "Data";
        if (f.Contains("Nop.Core", StringComparison.OrdinalIgnoreCase) || f.Contains("/Domain/", StringComparison.OrdinalIgnoreCase))
            return "Domain/Model";
        return "Other";
    }

    private static string Risk(int dependents, int uiTouch, int pluginTouch)
    {
        var score = dependents + uiTouch * 2 + pluginTouch * 2;
        if (score >= 40) return "HIGH";
        if (score >= 12) return "MEDIUM";
        return "LOW";
    }

    private static string Trunc(string s, int n) => s.Length <= n ? s : s[..n] + "…";
}
