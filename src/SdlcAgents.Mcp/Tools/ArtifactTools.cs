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
    [Description("Persist a generated document (BRD, ADR, test file, review report) to the repo's /artifacts folder. Returns the saved path. Use this to deliver the final output of an agent. IMPORTANT: writing to a name that already exists does NOT destroy the prior file — the previous content is snapshotted to <name>.vN before the new content is written, so any earlier version that a human may have reviewed is preserved. Never rely on a silent overwrite to revise an approved artifact; a changed artifact voids any prior approval and must be re-reviewed.")]
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

        // Approval integrity: a prior artifact must never be silently mutated. If a file
        // with this name already exists, snapshot it to an immutable <name>.vN backup
        // before writing, so nothing a reviewer has seen is destroyed — and make the
        // change explicit in the return value rather than pretending it was a fresh save.
        if (File.Exists(full))
        {
            if (File.ReadAllText(full) == content)
                return $"Artifact `{full}` already contains this exact content — nothing changed ({content.Length} chars).";

            var backup = NextVersionPath(full);
            File.Copy(full, backup, overwrite: false);
            File.WriteAllText(full, content);
            var backupRel = Path.GetRelativePath(index.ArtifactsDir, backup).Replace('\\', '/');
            return $"Updated existing artifact `{full}` ({content.Length} chars). The previous version was preserved as `{backupRel}`. " +
                   $"⚠ This is a MATERIAL change to an existing artifact: any prior approval of it is now void and it must be re-reviewed before use downstream.";
        }

        File.WriteAllText(full, content);
        return $"Saved artifact to `{full}` ({content.Length} chars).";
    }

    /// <summary>Finds the next free immutable snapshot path: foo.md → foo.md.v1, foo.md.v2, …</summary>
    private static string NextVersionPath(string full)
    {
        for (var n = 1; ; n++)
        {
            var candidate = $"{full}.v{n}";
            if (!File.Exists(candidate)) return candidate;
        }
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

    [McpServerTool(Name = "read_artifact")]
    [Description("Read the content of a previously generated artifact from the /artifacts folder. Use after list_artifacts to actually inspect a BRD, ADR, review or threat model produced by another agent (e.g. to verify evidence before approving).")]
    public static string ReadArtifact(
        CodeIndex index,
        [Description("Artifact path as shown by list_artifacts, e.g. 'brd-checkout.md' or 'tests/TaxServiceTests.cs'.")] string name,
        [Description("Max characters to return (default 20000).")] int maxChars = 20000)
    {
        var safe = SanitizeRelative(name);
        if (safe is null)
            return $"Refused: '{name}' resolves outside the artifacts directory.";

        var full = Path.Combine(index.ArtifactsDir, safe);
        if (!File.Exists(full))
            return $"Artifact not found: '{name}'. Use list_artifacts to see what exists.";

        var text = File.ReadAllText(full);
        var truncated = maxChars > 0 && text.Length > maxChars;
        if (truncated) text = text[..maxChars] + "\n… (truncated)";
        return $"# `{safe}` ({new FileInfo(full).Length} bytes)\n\n{text}";
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
