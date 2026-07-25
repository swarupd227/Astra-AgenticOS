using System.ComponentModel;
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using ModelContextProtocol.Server;
using SdlcAgents.Mcp.Services;

namespace SdlcAgents.Mcp.Tools;

/// <summary>
/// Grounds the review/security agents in a real multi-language static analyzer
/// (Semgrep, 30+ languages, framework-aware for Spring/Express/NestJS/React/Angular)
/// instead of reasoning about framework behaviour from memory. Shells out to the
/// `semgrep` CLI and returns structured findings with file:line evidence.
///
/// Degrades gracefully: if `semgrep` isn't installed (e.g. local dev), the tool
/// returns a clear message rather than throwing, so the rest of the server is
/// unaffected.
/// </summary>
[McpServerToolType]
public static class SemgrepTools
{
    [McpServerTool(Name = "semgrep_scan")]
    [Description("Run Semgrep static analysis over the indexed codebase (any language: C#, Java, TypeScript/JS, Angular, React, etc.) and return real, rule-backed findings with file:line and the rule that fired. Use this to GROUND security/quality claims in an analyzer's output rather than asserting framework behaviour from memory. Optionally scope to a sub-folder.")]
    public static string SemgrepScan(
        CodeIndex index,
        [Description("Optional repo-relative sub-folder to scan (e.g. 'src' or 'ApplicationCore'). Empty scans the whole indexed root.")] string subPath = "",
        [Description("Semgrep config: 'p/default' (the multi-language default), or a pack like 'p/security-audit' / 'p/secrets' / 'p/owasp-top-ten', or a language pack. Overridable per call.")] string config = "",
        [Description("Max findings to return (default 50).")] int maxResults = 50)
    {
        index.EnsureBuilt();
        if (maxResults <= 0) maxResults = 50;

        // Resolve + sandbox the scan target under the indexed root.
        var target = index.Root;
        if (!string.IsNullOrWhiteSpace(subPath))
        {
            var cleaned = subPath.Replace('\\', '/').TrimStart('/');
            if (cleaned.Split('/').Any(s => s == "..")) return $"Refused: '{subPath}' escapes the codebase.";
            target = Path.Combine(index.Root, cleaned);
            if (!Directory.Exists(target)) return $"Sub-folder not found: '{subPath}'.";
        }
        if (!Directory.Exists(target)) return $"No codebase to scan at '{index.Root}'.";

        // Default to the registry's multi-language pack. NB: 'auto' is deliberately NOT
        // the default — it requires metrics ON (it uploads project stats to pick rules),
        // which we disable for privacy. 'p/default' works with --metrics=off.
        var cfg = !string.IsNullOrWhiteSpace(config) ? config
                  : (Environment.GetEnvironmentVariable("SEMGREP_CONFIG") ?? "p/default");
        var timeoutS = Environment.GetEnvironmentVariable("SEMGREP_TIMEOUT_S") ?? "120";

        var psi = new ProcessStartInfo
        {
            FileName = "semgrep",
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        // --metrics=off: never send usage/metadata externally.  --json: machine-readable.
        foreach (var a in new[] { "--config", cfg, "--json", "--metrics=off",
                                  "--timeout", timeoutS, "--max-target-bytes", "2000000",
                                  "--quiet", target })
            psi.ArgumentList.Add(a);

        string stdout, stderr;
        try
        {
            using var p = Process.Start(psi);
            if (p is null) return "Could not start semgrep.";
            // hard wall so a runaway scan can't hang the agent turn
            stdout = p.StandardOutput.ReadToEnd();
            stderr = p.StandardError.ReadToEnd();
            if (!p.WaitForExit((int.Parse(timeoutS) + 60) * 1000))
            {
                try { p.Kill(true); } catch { }
                return $"Semgrep timed out after {timeoutS}s on `{Rel(index, target)}`. Try a smaller sub-folder.";
            }
        }
        catch (System.ComponentModel.Win32Exception)
        {
            return "Semgrep is not installed on this server, so static-analysis grounding is unavailable. "
                 + "Install it (`pip install semgrep`) or deploy the container image, which bundles it. "
                 + "In the meantime, ground findings by reading the code with read_file/search_code.";
        }
        catch (Exception ex)
        {
            return $"Semgrep failed to run: {ex.Message}";
        }

        if (string.IsNullOrWhiteSpace(stdout))
            return $"Semgrep produced no output. {(string.IsNullOrWhiteSpace(stderr) ? "" : "stderr: " + Trunc(stderr, 300))}";

        JsonDocument doc;
        try { doc = JsonDocument.Parse(stdout); }
        catch { return $"Could not parse semgrep output. {Trunc(stdout, 300)}"; }

        return Format(doc, index, Rel(index, target), cfg, maxResults);
    }

    private static string Format(JsonDocument doc, CodeIndex index, string scanned, string cfg, int maxResults)
    {
        var root = doc.RootElement;
        var results = root.TryGetProperty("results", out var r) && r.ValueKind == JsonValueKind.Array
            ? r.EnumerateArray().ToList()
            : new List<JsonElement>();

        if (results.Count == 0)
        {
            var sb0 = new StringBuilder();
            sb0.AppendLine($"# Semgrep — no findings in `{scanned}` (config: `{cfg}`)");
            sb0.AppendLine("No rule matched. This is an absence of *rule matches*, not a proof of security — say so.");
            if (root.TryGetProperty("errors", out var e0) && e0.ValueKind == JsonValueKind.Array && e0.GetArrayLength() > 0)
                sb0.AppendLine($"\n_({e0.GetArrayLength()} scan error(s) — some files may not have been analysed.)_");
            return sb0.ToString();
        }

        // severity order: ERROR > WARNING > INFO
        static int Rank(string s) => s?.ToUpperInvariant() switch { "ERROR" => 0, "WARNING" => 1, _ => 2 };
        var findings = results.Select(x =>
        {
            var extra = x.TryGetProperty("extra", out var ex) ? ex : default;
            var sev = extra.ValueKind == JsonValueKind.Object && extra.TryGetProperty("severity", out var sv) ? sv.GetString() ?? "INFO" : "INFO";
            var msg = extra.ValueKind == JsonValueKind.Object && extra.TryGetProperty("message", out var mv) ? mv.GetString() ?? "" : "";
            var rule = x.TryGetProperty("check_id", out var c) ? (c.GetString() ?? "") : "";
            var path = x.TryGetProperty("path", out var pth) ? (pth.GetString() ?? "") : "";
            var line = x.TryGetProperty("start", out var st) && st.TryGetProperty("line", out var ln) ? ln.GetInt32() : 0;
            return new { sev, msg, rule = rule.Split('.').Last(), path = RelPath(index, path), line };
        })
        .OrderBy(f => Rank(f.sev)).ThenBy(f => f.path, StringComparer.OrdinalIgnoreCase).ToList();

        var shown = findings.Take(maxResults).ToList();
        var bySev = findings.GroupBy(f => f.sev.ToUpperInvariant()).ToDictionary(g => g.Key, g => g.Count());

        var sb = new StringBuilder();
        sb.AppendLine($"# Semgrep findings in `{scanned}` — {findings.Count} total (config: `{cfg}`)");
        sb.AppendLine("Severity: " + string.Join(", ", new[] { "ERROR", "WARNING", "INFO" }
            .Where(bySev.ContainsKey).Select(s => $"{s} {bySev[s]}")));
        sb.AppendLine("_Real analyzer findings — cite these instead of asserting framework behaviour. Still confirm exploitability with read_file._");
        sb.AppendLine();
        foreach (var f in shown)
        {
            sb.AppendLine($"- **{f.sev}** `{f.path}:{f.line}` — `{f.rule}`  \n  {Trunc(OneLine(f.msg), 200)}");
        }
        if (findings.Count > shown.Count) sb.AppendLine($"\n_…and {findings.Count - shown.Count} more (raise maxResults or scope to a sub-folder)._");
        return sb.ToString();
    }

    private static string Rel(CodeIndex index, string full)
    {
        try { var r = Path.GetRelativePath(index.Root, full).Replace('\\', '/'); return r == "." ? "(root)" : r; }
        catch { return full; }
    }
    private static string RelPath(CodeIndex index, string p)
    {
        try { return Path.GetRelativePath(index.Root, p).Replace('\\', '/'); } catch { return p.Replace('\\', '/'); }
    }
    private static string OneLine(string s) => s.Replace("\r", " ").Replace("\n", " ").Trim();
    private static string Trunc(string s, int n) => s.Length <= n ? s : s[..n] + "…";
}
