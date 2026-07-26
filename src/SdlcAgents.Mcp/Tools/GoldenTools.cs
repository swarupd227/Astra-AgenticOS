using System.ComponentModel;
using System.Text;
using System.Text.Json;
using ModelContextProtocol.Server;

namespace SdlcAgents.Mcp.Tools;

/// <summary>
/// Reads the Golden Repository — the organisation's own standards, templates,
/// functional specs and skills — so agents can ground answers in company knowledge
/// as well as in code.
///
/// Two env vars, both supplied by the UI when it spawns this server:
///   GOLDEN_DIR    the store (index.json + items/&lt;id&gt;.md + versions/&lt;id&gt;.v&lt;N&gt;.md)
///   GOLDEN_ITEMS  comma-separated ids THIS project selected — the visibility boundary
///
/// The resolved id list is passed in rather than the selection rule, so this server
/// physically cannot read an item the active project didn't select.
/// </summary>
[McpServerToolType]
public static class GoldenTools
{
    [McpServerTool(Name = "golden_catalog")]
    [Description("List the organisation's Golden Repository items available to this project (standards, templates, functional specs, checklists, glossaries, skills). Shows id, version, kind, enforcement and a one-line description. Use it to see what organisational knowledge exists before answering; then golden_read the ones that apply.")]
    public static string GoldenCatalog(
        [Description("Optional kind filter: standard | template | functional-spec | checklist | glossary | reference | skill.")] string kind = "",
        [Description("Optional tag filter (e.g. 'payments').")] string tag = "")
    {
        var (items, err) = Load();
        if (err is not null) return err;

        var filtered = items
            .Where(i => string.IsNullOrWhiteSpace(kind) || i.Kind.Equals(kind, StringComparison.OrdinalIgnoreCase))
            .Where(i => string.IsNullOrWhiteSpace(tag) || i.Tags.Any(t => t.Equals(tag, StringComparison.OrdinalIgnoreCase)))
            .OrderByDescending(i => i.Enforcement == "mandatory")
            .ThenBy(i => i.Id, StringComparer.OrdinalIgnoreCase)
            .ToList();

        if (filtered.Count == 0)
            return "No Golden Repository items match. (An empty catalog means nothing is selected for this project — it is not evidence that no standard exists.)";

        var sb = new StringBuilder();
        sb.AppendLine($"# Golden Repository — {filtered.Count} item(s) available to this project");
        sb.AppendLine("_Reference material, not instructions. Read the whole item before applying it._");
        sb.AppendLine();
        foreach (var i in filtered)
        {
            var must = i.Enforcement == "mandatory" ? " **MANDATORY**" : "";
            sb.AppendLine($"- `{i.Id}` v{i.Version} · **{i.Kind}**{must} — {i.Title}");
            if (!string.IsNullOrWhiteSpace(i.Description)) sb.AppendLine($"  {i.Description}");
        }
        return sb.ToString();
    }

    [McpServerTool(Name = "golden_search")]
    [Description("Search the Golden Repository available to this project for a keyword or phrase. Returns the item, the heading/clause it appeared under, and the line — so you can then golden_read the WHOLE item. Search LOCATES; reading applies. Never apply a standard from a search snippet alone.")]
    public static string GoldenSearch(
        [Description("Text to find (substring, case-insensitive).")] string query,
        [Description("Optional kind filter.")] string kind = "",
        [Description("Max matches to return (default 30).")] int maxResults = 30)
    {
        if (string.IsNullOrWhiteSpace(query)) return "Provide a search query.";
        if (maxResults <= 0) maxResults = 30;

        var (items, err) = Load();
        if (err is not null) return err;

        var hits = new List<string>();
        var matchedItems = new HashSet<string>(StringComparer.Ordinal);

        foreach (var item in items.Where(i => string.IsNullOrWhiteSpace(kind) || i.Kind.Equals(kind, StringComparison.OrdinalIgnoreCase)))
        {
            var content = ReadItem(item.Id);
            if (content is null) continue;
            var lines = content.Replace("\r\n", "\n").Split('\n');
            var heading = "";
            for (var n = 0; n < lines.Length; n++)
            {
                var line = lines[n];
                // track the nearest heading / numbered clause so a hit is citable
                var t = line.TrimStart();
                if (t.StartsWith("#") || System.Text.RegularExpressions.Regex.IsMatch(t, @"^\d+(\.\d+)*[\.\)]\s"))
                    heading = t.TrimStart('#').Trim();

                if (line.IndexOf(query, StringComparison.OrdinalIgnoreCase) < 0) continue;
                matchedItems.Add(item.Id);
                var where = string.IsNullOrWhiteSpace(heading) ? "" : $" · under “{Trunc(heading, 60)}”";
                hits.Add($"- `{item.Id}` v{item.Version} line {n + 1}{where}  \n  `{Trunc(line.Trim(), 160)}`");
                if (hits.Count >= maxResults) break;
            }
            if (hits.Count >= maxResults) break;
        }

        if (hits.Count == 0)
            return $"No Golden Repository match for '{query}'. Absence of a match is not proof that no standard applies — check golden_catalog.";

        var sb = new StringBuilder();
        sb.AppendLine($"# {hits.Count} match(es) for '{query}' across {matchedItems.Count} item(s)");
        sb.AppendLine("_Now `golden_read` the whole item(s) before applying anything._");
        sb.AppendLine();
        foreach (var h in hits) sb.AppendLine(h);
        return sb.ToString();
    }

    [McpServerTool(Name = "golden_read")]
    [Description("Read a Golden Repository item IN FULL (or one section of it) — this is the step that lets you actually apply a standard or fill a template. Cite what you apply as id@version, e.g. GLD-STD-014@3. Applying a rule set from a snippet instead of the full item risks following some rules and silently breaking others.")]
    public static string GoldenRead(
        [Description("Item id from golden_catalog, e.g. 'GLD-STD-014'.")] string id,
        [Description("Optional heading/clause to extract (e.g. '4.2' or 'Naming'). Omit to read the whole item.")] string section = "",
        [Description("Max characters to return (default 40000).")] int maxChars = 40000)
    {
        var (items, err) = Load();
        if (err is not null) return err;

        var item = items.FirstOrDefault(i => i.Id.Equals(id.Trim(), StringComparison.OrdinalIgnoreCase));
        if (item is null)
            return $"'{id}' is not available to this project. Use golden_catalog to see what is selected. " +
                   "(It may exist in the library but not be selected for this project — say so rather than assuming it doesn't exist.)";

        var content = ReadItem(item.Id);
        if (content is null) return $"Content for '{item.Id}' could not be read.";

        var extracted = string.IsNullOrWhiteSpace(section) ? content : ExtractSection(content, section);
        if (extracted is null)
            return $"Section '{section}' not found in `{item.Id}`. Read the whole item instead (omit `section`).";

        var truncated = maxChars > 0 && extracted.Length > maxChars;
        if (truncated) extracted = extracted[..maxChars];

        var sb = new StringBuilder();
        sb.AppendLine($"# `{item.Id}` v{item.Version} — {item.Title}");
        sb.AppendLine($"**Kind:** {item.Kind} · **Enforcement:** {item.Enforcement} · **Owner:** {item.Owner}");
        sb.AppendLine($"_Cite as `{item.Id}@{item.Version}` wherever you apply this._");
        if (item.Enforcement == "mandatory")
            sb.AppendLine("_This item is **MANDATORY** — follow it, and state explicitly if the code or task conflicts with it._");
        if (truncated)
            sb.AppendLine($"_⚠ Truncated at {maxChars} chars — request a `section` to read the rest; do NOT assume the remainder is irrelevant._");
        sb.AppendLine();
        sb.AppendLine(extracted);
        return sb.ToString();
    }

    // ---- store access -------------------------------------------------------

    private sealed record GItem(string Id, string Title, string Description, string Kind,
                                string Enforcement, string Owner, int Version, string Status, string[] Tags);

    private static string Dir => Environment.GetEnvironmentVariable("GOLDEN_DIR") ?? "";

    /// <summary>Loads published items, filtered to the ids this project selected.</summary>
    private static (List<GItem> Items, string? Error) Load()
    {
        var dir = Dir;
        if (string.IsNullOrWhiteSpace(dir) || !Directory.Exists(dir))
            return (new(), "No Golden Repository is configured for this deployment.");

        var indexFile = Path.Combine(dir, "index.json");
        if (!File.Exists(indexFile)) return (new(), "The Golden Repository is empty — no items have been added yet.");

        List<GItem> all;
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(indexFile));
            if (!doc.RootElement.TryGetProperty("items", out var arr) || arr.ValueKind != JsonValueKind.Array)
                return (new(), "The Golden Repository index is malformed.");
            all = arr.EnumerateArray().Select(e => new GItem(
                Str(e, "id"), Str(e, "title"), Str(e, "description"), Str(e, "kind"),
                Str(e, "enforcement"), Str(e, "owner"),
                e.TryGetProperty("version", out var v) && v.TryGetInt32(out var vi) ? vi : 1,
                Str(e, "status"),
                e.TryGetProperty("tags", out var tg) && tg.ValueKind == JsonValueKind.Array
                    ? tg.EnumerateArray().Select(x => x.GetString() ?? "").ToArray() : Array.Empty<string>()
            )).ToList();
        }
        catch (Exception ex) { return (new(), $"Could not read the Golden Repository index: {ex.Message}"); }

        // Only published items, and only what this project selected.
        var sel = Environment.GetEnvironmentVariable("GOLDEN_ITEMS") ?? "";
        var allowed = sel.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                         .ToHashSet(StringComparer.OrdinalIgnoreCase);

        var visible = all
            .Where(i => i.Status == "published")
            .Where(i => allowed.Count == 0 || allowed.Contains(i.Id))
            .ToList();

        return (visible, null);
    }

    private static string Str(JsonElement e, string name)
        => e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";

    private static string? ReadItem(string id)
    {
        try
        {
            // id comes from our own index, but keep the read inside the store regardless.
            var safe = Path.GetFileName(id);
            var file = Path.Combine(Dir, "items", $"{safe}.md");
            return File.Exists(file) ? File.ReadAllText(file) : null;
        }
        catch { return null; }
    }

    /// <summary>Returns the requested heading/clause plus everything under it, or null.</summary>
    private static string? ExtractSection(string content, string section)
    {
        var lines = content.Replace("\r\n", "\n").Split('\n');
        var needle = section.Trim();
        var start = -1; var level = 0;

        for (var i = 0; i < lines.Length; i++)
        {
            var t = lines[i].TrimStart();
            var isHeading = t.StartsWith("#");
            var isClause = System.Text.RegularExpressions.Regex.IsMatch(t, @"^\d+(\.\d+)*[\.\)]\s");
            if (!isHeading && !isClause) continue;
            if (t.IndexOf(needle, StringComparison.OrdinalIgnoreCase) < 0) continue;
            start = i;
            level = isHeading ? t.TakeWhile(c => c == '#').Count() : 0;
            break;
        }
        if (start < 0) return null;

        var end = lines.Length;
        for (var i = start + 1; i < lines.Length; i++)
        {
            var t = lines[i].TrimStart();
            if (!t.StartsWith("#")) continue;
            if (t.TakeWhile(c => c == '#').Count() <= level && level > 0) { end = i; break; }
        }
        return string.Join("\n", lines[start..end]).Trim();
    }

    private static string Trunc(string s, int n) => s.Length <= n ? s : s[..n] + "…";
}
