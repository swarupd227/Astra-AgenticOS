namespace SdlcAgents.Mcp.Services;

public enum WriteOutcome { Created, Updated, Unchanged }

/// <summary>A completed write, with enough detail for the caller to word its own message.</summary>
public readonly record struct WriteResult(string FullPath, WriteOutcome Outcome, string? BackupRelativePath);

/// <summary>
/// The write-with-versioning behaviour originally inside ArtifactTools.SaveArtifact,
/// pulled out so a second caller (PatchTools.ProposeFileChange) gets the exact same
/// approval-integrity guarantee — a prior file is never silently overwritten, it is
/// snapshotted to an immutable <c>.vN</c> sibling first — from one piece of code rather
/// than two copies that could quietly drift apart.
/// </summary>
public static class ArtifactStore
{
    /// <summary>Returns a safe relative path under the artifacts dir, or null if it escapes.</summary>
    public static string? SanitizeRelative(string name)
    {
        var cleaned = name.Replace('\\', '/').TrimStart('/');
        if (cleaned.Length == 0) return null;
        if (cleaned.Split('/').Any(seg => seg == "..")) return null;
        return cleaned;
    }

    public static WriteResult Write(string artifactsDir, string safeRelativeName, string content)
    {
        var full = Path.Combine(artifactsDir, safeRelativeName);
        Directory.CreateDirectory(Path.GetDirectoryName(full)!);

        if (File.Exists(full))
        {
            if (File.ReadAllText(full) == content)
                return new WriteResult(full, WriteOutcome.Unchanged, null);

            var backup = NextVersionPath(full);
            File.Copy(full, backup, overwrite: false);
            File.WriteAllText(full, content);
            var backupRel = Path.GetRelativePath(artifactsDir, backup).Replace('\\', '/');
            return new WriteResult(full, WriteOutcome.Updated, backupRel);
        }

        File.WriteAllText(full, content);
        return new WriteResult(full, WriteOutcome.Created, null);
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
}
