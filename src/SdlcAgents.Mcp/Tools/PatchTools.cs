using System.ComponentModel;
using System.Text;
using System.Text.Json;
using DiffPlex.DiffBuilder;
using DiffPlex.DiffBuilder.Model;
using ModelContextProtocol.Server;
using SdlcAgents.Mcp.Services;

namespace SdlcAgents.Mcp.Tools;

/// <summary>
/// Proposes a change to a REAL file in the indexed source tree — distinct from
/// save_artifact, which only ever writes into /artifacts and has no concept of a
/// real repo path. This tool never touches the source tree: it reads the target's
/// current content (for a modification), computes an exact diff against the
/// proposed content, and saves the proposal — full content, diff, and metadata —
/// the same way save_artifact does, through the same versioning guarantee.
///
/// Applying a proposal is a deliberate, separate, human-triggered action that does
/// not exist yet. This tool's entire job is to make that later action buildable
/// safely, by producing something unambiguous enough to apply: an exact diff
/// against a known base, not a snippet whose relationship to the real file is a
/// guess.
/// </summary>
[McpServerToolType]
public static class PatchTools
{
    [McpServerTool(Name = "propose_file_change")]
    [Description("Proposes a change to a real file in this project's source tree — a new file, or a modification to an existing one. Unlike save_artifact (which only ever writes into /artifacts with no real repo path), this tool records the REAL target path and computes an exact diff against the file's current content — not a diff you author yourself. It does NOT touch the source tree; nothing is applied. For kind='modify' you must have read_file'd the target THIS run first (the same rule save_artifact already enforces for named inputs — an unread target is refused). Use this instead of embedding proposed code as a snippet in your answer: a snippet cannot be reviewed as a diff or applied later; this can.")]
    public static string ProposeFileChange(
        CodeIndex index,
        [Description("Path of the real file this change targets, relative to the project root, e.g. 'src/Services/TaxService.cs'.")] string targetPath,
        [Description("The COMPLETE proposed content of the file after the change — the full file as it would read once applied, never a snippet or a diff.")] string content,
        [Description("'modify' if targetPath already exists in the source tree, 'create' if it does not.")] string kind)
    {
        var safe = ArtifactStore.SanitizeRelative(targetPath);
        if (safe is null)
            return $"Refused: '{targetPath}' resolves outside the project root.";
        if (kind is not ("modify" or "create"))
            return $"Refused: kind must be 'modify' or 'create', not '{kind}'.";

        var realPath = Path.Combine(index.Root, safe);
        var exists = File.Exists(realPath);

        if (kind == "create" && exists)
            return $"Refused: '{targetPath}' already exists in the source tree — propose this as kind='modify' instead, so the diff is against its real current content.";
        if (kind == "modify" && !exists)
            return $"Refused: '{targetPath}' does not exist in the source tree — propose this as kind='create' instead.";

        var oldContent = kind == "modify" ? File.ReadAllText(realPath) : "";
        if (kind == "modify" && oldContent == content)
            return $"Nothing to propose: the content given for '{targetPath}' is identical to what is already there.";

        var diffText = BuildUnifiedDiff(safe, oldContent, content);
        var (added, removed) = DiffStats(diffText);

        // Same store, same versioning guarantee save_artifact has always had — a prior
        // proposal for this path is never silently overwritten, it is snapshotted first.
        var stem = safe.Replace('/', '_');
        var proposalName = $"proposals/{stem}.proposed{Path.GetExtension(safe)}";
        var diffName = $"proposals/{stem}.diff";
        var metaName = $"proposals/{stem}.meta.json";

        var savedContent = ArtifactStore.Write(index.ArtifactsDir, proposalName, content);
        var savedDiff = ArtifactStore.Write(index.ArtifactsDir, diffName, diffText);

        // Provenance belongs in structured metadata, not a footer appended to the proposed
        // content — that content is very often literal source code, and a footer would
        // stop it compiling exactly the same way it would on a stamped save_artifact call.
        var meta = new
        {
            targetPath = safe,
            kind,
            proposedAtUtc = DateTime.UtcNow.ToString("O"),
            baseLength = oldContent.Length,
            proposedLength = content.Length,
            linesAdded = added,
            linesRemoved = removed,
        };
        ArtifactStore.Write(index.ArtifactsDir, metaName,
            JsonSerializer.Serialize(meta, new JsonSerializerOptions { WriteIndented = true }));

        return $"Proposed change to `{safe}` ({kind}) — {added} line(s) added, {removed} removed. " +
               $"Diff saved to `{Rel(index, savedDiff.FullPath)}`; full proposed content saved to `{Rel(index, savedContent.FullPath)}`. " +
               $"Nothing in the real repository has changed — this is a reviewable proposal only, not an applied edit.";
    }

    private static string Rel(CodeIndex index, string full) =>
        Path.GetRelativePath(index.ArtifactsDir, full).Replace('\\', '/');

    /// <summary>
    /// A real unified diff, computed from DiffPlex's line-level Myers diff — not
    /// hand-authored. The algorithm (which lines actually correspond to which) comes
    /// from tested library code; only the hunk grouping and @@ header formatting below
    /// is new code, and it is simple enough to verify directly: expand each changed
    /// line's index by `context` lines in both directions, merge overlapping windows,
    /// and each merged window is one hunk.
    /// </summary>
    private static string BuildUnifiedDiff(string relativePath, string oldText, string newText, int context = 3)
    {
        var diff = InlineDiffBuilder.Diff(oldText, newText);

        // Every line gets its old- and new-file line number (one or the other is absent
        // for a pure insertion/deletion), so a hunk header can be computed from whichever
        // lines actually land inside it.
        var lines = new List<(int? OldNo, int? NewNo, ChangeType Type, string Text)>(diff.Lines.Count);
        int oldNo = 0, newNo = 0;
        foreach (var p in diff.Lines)
        {
            switch (p.Type)
            {
                case ChangeType.Deleted:
                    oldNo++;
                    lines.Add((oldNo, null, p.Type, p.Text));
                    break;
                case ChangeType.Inserted:
                    newNo++;
                    lines.Add((null, newNo, p.Type, p.Text));
                    break;
                default: // Unchanged (Modified/Imaginary do not occur at InlineDiffBuilder's line granularity)
                    oldNo++; newNo++;
                    lines.Add((oldNo, newNo, ChangeType.Unchanged, p.Text));
                    break;
            }
        }

        var sb = new StringBuilder();
        sb.Append($"--- a/{relativePath}\n").Append($"+++ b/{relativePath}\n");

        var changedIdx = new List<int>();
        for (var i = 0; i < lines.Count; i++)
            if (lines[i].Type != ChangeType.Unchanged) changedIdx.Add(i);
        if (changedIdx.Count == 0) { sb.Append("(no textual difference)\n"); return sb.ToString(); }

        var ranges = new List<(int Start, int End)>();
        foreach (var idx in changedIdx)
        {
            var start = Math.Max(0, idx - context);
            var end = Math.Min(lines.Count - 1, idx + context);
            if (ranges.Count > 0 && start <= ranges[^1].End + 1)
                ranges[^1] = (ranges[^1].Start, Math.Max(ranges[^1].End, end));
            else
                ranges.Add((start, end));
        }

        foreach (var (start, end) in ranges)
        {
            var slice = lines.GetRange(start, end - start + 1);
            // A hunk can be all-insertion (kind="create": the old side is empty
            // everywhere, so no line in ANY hunk carries an OldNo) or, in principle,
            // all-deletion. First() on an empty match would throw, so fall back to
            // "one past the last numbered line before this hunk" — the standard
            // convention for an empty side (git emits "@@ -0,0 ..." for a brand new
            // file), and 0 when there is no earlier line either.
            var oldStart = SideStart(lines, start, end, useOld: true);
            var newStart = SideStart(lines, start, end, useOld: false);
            var oldCount = slice.Count(l => l.OldNo != null);
            var newCount = slice.Count(l => l.NewNo != null);
            sb.Append($"@@ -{oldStart},{oldCount} +{newStart},{newCount} @@\n");
            foreach (var l in slice)
            {
                var prefix = l.Type switch { ChangeType.Inserted => '+', ChangeType.Deleted => '-', _ => ' ' };
                sb.Append(prefix).Append(l.Text).Append('\n');
            }
        }
        return sb.ToString();
    }

    /// <summary>
    /// The 1-based line number where a hunk starts, on one side of the diff. Usually the
    /// first line in the hunk that carries a number on that side. If none does — every
    /// line in the hunk is a pure insertion (old side) or pure deletion (new side) — the
    /// position is one past the last numbered line before the hunk, or 0 if the hunk is
    /// at the very start of that side (an empty old file, for a "create" proposal).
    /// </summary>
    private static int SideStart(
        List<(int? OldNo, int? NewNo, ChangeType Type, string Text)> lines, int start, int end, bool useOld)
    {
        for (var i = start; i <= end; i++)
        {
            var v = useOld ? lines[i].OldNo : lines[i].NewNo;
            if (v != null) return v.Value;
        }
        for (var i = start - 1; i >= 0; i--)
        {
            var v = useOld ? lines[i].OldNo : lines[i].NewNo;
            if (v != null) return v.Value + 1;
        }
        return 0;
    }

    /// <summary>Added/removed line counts, read back off the diff text already built —
    /// avoids computing the same thing twice from two different representations.</summary>
    private static (int Added, int Removed) DiffStats(string diffText)
    {
        int added = 0, removed = 0;
        foreach (var line in diffText.Split('\n'))
        {
            if (line.StartsWith("+++") || line.StartsWith("---")) continue;
            if (line.StartsWith('+')) added++;
            else if (line.StartsWith('-')) removed++;
        }
        return (added, removed);
    }
}
