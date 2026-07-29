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

# Semgrep — multi-language static analysis that grounds the review/security agents
# (the semgrep_scan MCP tool). Installed apt-free: the base already ships python3 +
# curl, so we bootstrap pip and pip-install semgrep. If this layer's network is
# blocked, drop it — the semgrep_scan tool degrades gracefully when the CLI is absent.
RUN curl -sSL https://bootstrap.pypa.io/get-pip.py -o /tmp/get-pip.py \
    && python3 /tmp/get-pip.py --quiet --break-system-packages --root-user-action=ignore \
    && pip3 install --quiet --break-system-packages --root-user-action=ignore semgrep \
    && rm -f /tmp/get-pip.py \
    && semgrep --version

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

# Cloned repos live on the mounted /home share, whose files are owned by a different
# uid than this process. Git treats that as "dubious ownership" and refuses to run at
# all, so every git tool failed in the cloud while passing locally — taking the branch
# picker, diff-scoped review, and the commit in run identity with it.
#
# The protection guards against a repo planted by another user on a shared machine.
# This container is single-tenant and only ever operates on checkouts it created
# itself, so the condition it defends against cannot arise here.
RUN git config --system --add safe.directory '*'

ENV PORT=5173
EXPOSE 5173

CMD ["npm", "--prefix", "ui", "start"]
