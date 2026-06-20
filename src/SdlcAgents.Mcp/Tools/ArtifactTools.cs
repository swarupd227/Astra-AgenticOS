using System.ComponentModel;
using System.Text;
using ModelContextProtocol.Server;
using SdlcAgents.Mcp.Services;

namespace SdlcAgents.Mcp.Tools;

/// <summary>
/// Lets agents persist the deliverables they produce (BRDs, ADRs, generated tests)
/// into the repo's /artifacts folder so the output survives the chat session.
/// Writes are sandboxed to the artifacts directory.
/// </summary>
[McpServerToolType]
public static class ArtifactTools
{
    [McpServerTool(Name = "save_artifact")]
    [Description("Persist a generated document (BRD, ADR, test file, review report) to the repo's /artifacts folder. Returns the saved path. Use this to deliver the final output of an agent.")]
    public static string SaveArtifact(
        CodeIndex index,
        [Description("File name including extension, e.g. 'brd-checkout.md' or 'TaxServiceTests.cs'. Subfolders allowed, e.g. 'tests/TaxServiceTests.cs'.")] string name,
        [Description("Full file content to write.")] string content)
    {
        var safe = SanitizeRelative(name);
        if (safe is null)
            return $"Refused: '{name}' resolves outside the artifacts directory.";

        var full = Path.Combine(index.ArtifactsDir, safe);
        Directory.CreateDirectory(Path.GetDirectoryName(full)!);
        File.WriteAllText(full, content);
        return $"Saved artifact to `{full}` ({content.Length} chars).";
    }

    [McpServerTool(Name = "list_artifacts")]
    [Description("List artifacts already generated in the repo's /artifacts folder.")]
    public static string ListArtifacts(CodeIndex index)
    {
        if (!Directory.Exists(index.ArtifactsDir))
            return "No artifacts yet.";
        var files = Directory.EnumerateFiles(index.ArtifactsDir, "*", SearchOption.AllDirectories)
            .Where(f => !f.EndsWith(".gitkeep"))
            .ToList();
        if (files.Count == 0) return "No artifacts yet.";

        var sb = new StringBuilder();
        sb.AppendLine($"# Artifacts ({files.Count})");
        foreach (var f in files)
            sb.AppendLine($"- `{Path.GetRelativePath(index.ArtifactsDir, f).Replace('\\', '/')}`");
        return sb.ToString();
    }

    /// <summary>Returns a safe relative path under the artifacts dir, or null if it escapes.</summary>
    private static string? SanitizeRelative(string name)
    {
        var cleaned = name.Replace('\\', '/').TrimStart('/');
        if (cleaned.Length == 0) return null;
        if (cleaned.Split('/').Any(seg => seg == "..")) return null;
        return cleaned;
    }
}
