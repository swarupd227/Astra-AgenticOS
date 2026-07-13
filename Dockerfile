# syntax=docker/dockerfile:1

# ---- Stage 1: build the .NET MCP server (Release) ----
FROM mcr.microsoft.com/dotnet/sdk:9.0 AS mcp-build
WORKDIR /src
COPY src/SdlcAgents.Mcp/ ./SdlcAgents.Mcp/
RUN dotnet publish SdlcAgents.Mcp/SdlcAgents.Mcp.csproj -c Release -o /out

# ---- Source of the .NET 9 runtime files (copied in below — no apt / no install script) ----
FROM mcr.microsoft.com/dotnet/runtime:9.0 AS dotnet-rt

# ---- Stage 2: runtime image ----
# Full Node image (not -slim) already ships git — needed by the git tools + git-repo projects.
# The .NET runtime is copied from Microsoft's image, so this needs no Debian apt access
# (works on locked-down build networks that block public apt mirrors).
FROM node:20-bookworm
COPY --from=dotnet-rt /usr/share/dotnet /usr/share/dotnet
ENV PATH="/usr/share/dotnet:${PATH}"
ENV DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1

WORKDIR /app

# Agent personas + reused instructions (loaded at startup)
COPY .github/ ./.github/

# Built MCP server, at the exact path the UI launches it from
COPY --from=mcp-build /out/ ./src/SdlcAgents.Mcp/bin/Release/net9.0/

# UI dependencies (cached layer), then the UI source
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY ui/package.json ui/package-lock.json ./ui/
RUN cd ui && npm ci
COPY ui/ ./ui/

ENV PORT=5173
EXPOSE 5173

CMD ["npm", "--prefix", "ui", "start"]
