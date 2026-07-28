using System.ComponentModel;
using System.Diagnostics;
using ModelContextProtocol.Server;
using SdlcAgents.Mcp.Services;

namespace SdlcAgents.Mcp.Tools;

/// <summary>
/// Read-only git history access for the target repo, so agents (Regression,
/// Changelog, Human Review) can reason about what actually changed. Shells out to
/// the local `git` executable, scoped to the indexed source root.
/// </summary>
[McpServerToolType]
public static class GitTools
{
    private const int GitTimeoutMs = 20000;

    private static (bool ok, string output) RunGit(string root, string args)
    {
        try
        {
            var psi = new ProcessStartInfo("git", args)
            {
                WorkingDirectory = root,
                // Redirected so the child cannot inherit ours. This server speaks
                // JSON-RPC over stdio, so an un-redirected git that decides to ask a
                // question blocks reading the protocol stream itself.
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            // Belt and braces: git must never have a question to ask in the first place.
            psi.Environment["GIT_TERMINAL_PROMPT"] = "0";
            psi.Environment["GCM_INTERACTIVE"] = "never";
            psi.Environment["GIT_PAGER"] = "cat";

            using var p = Process.Start(psi);
            if (p is null) return (false, "Could not start git.");
            p.StandardInput.Close();

            // Drain asynchronously. ReadToEnd() has no timeout, so it ran *before*
            // the guard below and a git that never exited hung here forever — taking
            // the whole MCP session with it, because every later tool call queues
            // behind this one. The timeout was unreachable dead code.
            var so = p.StandardOutput.ReadToEndAsync();
            var se = p.StandardError.ReadToEndAsync();

            if (!p.WaitForExit(GitTimeoutMs))
            {
                try { p.Kill(entireProcessTree: true); } catch { /* already gone */ }
                return (false, $"git did not finish within {GitTimeoutMs / 1000}s and was stopped.");
            }
            Task.WhenAll(so, se).Wait(2000);   // exit does not imply the pipes are drained

            var outp = so.IsCompletedSuccessfully ? so.Result : "";
            var err = se.IsCompletedSuccessfully ? se.Result : "";
            if (p.ExitCode != 0 && string.IsNullOrWhiteSpace(outp))
                return (false, string.IsNullOrWhiteSpace(err) ? $"git exited {p.ExitCode}" : err.Trim());
            return (true, outp);
        }
        catch (Exception ex)
        {
            return (false, "git not available: " + ex.Message);
        }
    }

    private static string Cap(string s, int max) =>
        max > 0 && s.Length > max ? s[..max] + "\n… (truncated)" : s;

    /// <summary>
    /// A project here is a clone, not somebody's working copy. Its history may be
    /// truncated and most branches were never fetched, so an empty result usually
    /// means "not in this checkout" rather than "nothing changed" — and an agent
    /// told the latter will confidently review a diff it never saw. Returns a note
    /// describing the limit, or null when the checkout can answer normally.
    /// </summary>
    private static string? CheckoutLimits(string root)
    {
        var (sok, sh) = RunGit(root, "rev-parse --is-shallow-repository");
        var shallow = sok && sh.Trim().Equals("true", StringComparison.OrdinalIgnoreCase);

        // A single-branch clone pins the refspec to one branch; a normal clone
        // wildcards it. Counting branches instead would cry wolf on the many repos
        // that legitimately have only one.
        var (rok, refspec) = RunGit(root, "config --get remote.origin.fetch");
        var singleBranch = rok && !refspec.Contains('*');

        if (!shallow && !singleBranch) return null;

        var parts = new List<string>();
        if (shallow) parts.Add("its history is truncated");
        if (singleBranch) parts.Add($"only one branch was fetched ({refspec.Trim()})");

        return $"NOTE — this project is a clone and {string.Join(" and ", parts)}. "
             + "Anything outside what was fetched cannot be resolved here. That is a limit of this checkout, "
             + "not evidence that nothing changed — do not report 'no changes' on the strength of it.";
    }

    [McpServerTool(Name = "git_status")]
    [Description("Show the working-tree status of the target repo (staged/unstaged/untracked files). Use to find pending, uncommitted changes before assessing regression risk.")]
    public static string GitStatus(CodeIndex index)
    {
        var (ok, outp) = RunGit(index.Root, "status --porcelain=v1 --branch");
        if (!ok) return $"git_status failed: {outp}. (Is the source root inside a git repository?)";
        return string.IsNullOrWhiteSpace(outp)
            ? "Working tree clean — no pending changes."
            : "# git status\n```\n" + outp + "\n```";
    }

    [McpServerTool(Name = "git_log")]
    [Description("List recent commits (sha, author, date, subject). Use to build a changelog or understand recent history.")]
    public static string GitLog(
        CodeIndex index,
        [Description("How many recent commits to show (default 20).")] int count = 20)
    {
        if (count <= 0) count = 20;
        var (ok, outp) = RunGit(index.Root, $"log -n {count} --pretty=format:%h%x09%an%x09%ad%x09%s --date=short");
        if (!ok) return $"git_log failed: {outp}.";
        return "# Recent commits\n```\n" + outp + "\n```";
    }

    [McpServerTool(Name = "git_diff")]
    [Description("Show a diff. With no ref, shows uncommitted working-tree changes. Pass a ref/range (e.g. 'HEAD~1', 'main..feature') to diff that. Set statOnly=true for a file-level summary.")]
    public static string GitDiff(
        CodeIndex index,
        [Description("Git ref or range. Empty = uncommitted working-tree changes.")] string @ref = "",
        [Description("Only the file-level summary (--stat) instead of the full patch.")] bool statOnly = false,
        [Description("Max characters of diff to return (default 12000).")] int maxChars = 12000)
    {
        var sub = statOnly ? "--stat" : "";
        var args = string.IsNullOrWhiteSpace(@ref) ? $"diff {sub}".Trim() : $"diff {sub} {@ref}".Trim();
        var (ok, outp) = RunGit(index.Root, args);
        var limits = CheckoutLimits(index.Root);

        // An unresolvable ref and an identical ref produce very different truths.
        // Both used to read as "nothing to see here".
        if (!ok)
            return $"git_diff could not resolve `{@ref}`: {outp.Trim()}"
                 + (limits is null ? "" : "\n\n" + limits);

        if (string.IsNullOrWhiteSpace(outp))
        {
            if (!string.IsNullOrWhiteSpace(@ref)) return $"No differences for {@ref}.";
            return "The working tree is clean — there are no uncommitted edits."
                 + (limits is null
                     ? ""
                     : "\n\n" + limits + "\nTo review a change, diff against a branch or commit instead, "
                       + "e.g. ref: 'main..my-branch'.");
        }

        return $"# git diff {@ref}".TrimEnd() + "\n```diff\n" + Cap(outp, maxChars) + "\n```";
    }

    [McpServerTool(Name = "git_show")]
    [Description("Show one commit's metadata and changes. Default ref is HEAD. Use statOnly=true for just the changed-file summary.")]
    public static string GitShow(
        CodeIndex index,
        [Description("Commit ref, e.g. 'HEAD' or a short SHA.")] string @ref = "HEAD",
        [Description("Only the changed-file summary (--stat).")] bool statOnly = true,
        [Description("Max characters to return (default 12000).")] int maxChars = 12000)
    {
        var sub = statOnly ? "--stat" : "";
        var (ok, outp) = RunGit(index.Root, $"show {sub} {@ref}".Replace("  ", " ").Trim());
        if (!ok) return $"git_show failed: {outp}.";
        return $"# git show {@ref}\n```\n" + Cap(outp, maxChars) + "\n```";
    }
}
