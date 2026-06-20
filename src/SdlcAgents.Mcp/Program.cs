using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using SdlcAgents.Mcp.Services;

// SDLC Agents MCP server.
//
// Exposes Roslyn-backed code-intelligence tools over stdio so GitHub Copilot
// custom agents (or any MCP client) can ground their answers in a real
// .NET Framework / ASP.NET codebase (nopCommerce 3.90 for this demo).
//
// IMPORTANT: stdout is the MCP protocol channel for stdio transport. All logging
// MUST go to stderr, otherwise it corrupts the JSON-RPC stream.

var builder = Host.CreateApplicationBuilder(args);

builder.Logging.AddConsole(options =>
{
    options.LogToStandardErrorThreshold = LogLevel.Trace;
});

// One shared, lazily-built index of the target source tree.
builder.Services.AddSingleton<CodeIndex>();

builder.Services
    .AddMcpServer()
    .WithStdioServerTransport()
    .WithToolsFromAssembly();

await builder.Build().RunAsync();
