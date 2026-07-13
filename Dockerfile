# syntax=docker/dockerfile:1

# ---- Stage 1: build the .NET MCP server (Release) ----
FROM mcr.microsoft.com/dotnet/sdk:9.0 AS mcp-build
WORKDIR /src
COPY src/SdlcAgents.Mcp/ ./SdlcAgents.Mcp/
RUN dotnet publish SdlcAgents.Mcp/SdlcAgents.Mcp.csproj -c Release -o /out

# ---- Stage 2: runtime image (Node UI + .NET runtime for the MCP server) ----
FROM node:20-bookworm-slim

# .NET 9 runtime (to run the MCP server DLL) + git (git tools + git-repo projects)
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl git ca-certificates \
 && curl -sSL https://dot.net/v1/dotnet-install.sh | bash -s -- --channel 9.0 --runtime dotnet --install-dir /usr/share/dotnet \
 && ln -s /usr/share/dotnet/dotnet /usr/local/bin/dotnet \
 && apt-get purge -y curl \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Agent personas + reused instructions (the UI loads these at startup)
COPY .github/ ./.github/

# Built MCP server, at the exact path the UI expects to launch it from
COPY --from=mcp-build /out/ ./src/SdlcAgents.Mcp/bin/Release/net9.0/

# UI dependencies (cached layer), then the UI source
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY ui/package.json ui/package-lock.json ./ui/
RUN cd ui && npm ci
COPY ui/ ./ui/

ENV PORT=5173
EXPOSE 5173

# Listens on 5173 immediately, connects the MCP server + indexes in the background.
CMD ["npm", "--prefix", "ui", "start"]
