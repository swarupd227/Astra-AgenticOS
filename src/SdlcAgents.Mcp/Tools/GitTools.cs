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
    private static (bool ok, string output) RunGit(string root, string args)
    {
        try
        {
            var psi = new ProcessStartInfo("git", args)
            {
                WorkingDirectory = root,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            using var p = Process.Start(psi);
            if (p is null) return (false, "Could not start git.");
            var so = p.StandardOutput.ReadToEnd();
            var se = p.StandardError.ReadToEnd();
            p.WaitForExit(20000);
            if (p.ExitCode != 0 && string.IsNullOrWhiteSpace(so))
                return (false, string.IsNullOrWhiteSpace(se) ? $"git exited {p.ExitCode}" : se.Trim());
            return (true, so);
        }
        catch (Exception ex)
        {
            return (false, "git not available: " + ex.Message);
        }
    }

    private static string Cap(string s, int max) =>
        max > 0 && s.Length > max ? s[..max] + "\n… (truncated)" : s;

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
        if (!ok) return $"git_diff failed: {outp}.";
        if (string.IsNullOrWhiteSpace(outp))
            return "No differences for " + (string.IsNullOrWhiteSpace(@ref) ? "the working tree" : @ref) + ".";
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
