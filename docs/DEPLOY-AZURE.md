# Deploy ASTRA AgenticOS to Azure (Cloud Shell)

ASTRA is a single Docker container (Node UI + .NET runtime + MCP server) that listens on **port 5173**
and needs an **`ANTHROPIC_API_KEY`**. These are copy-paste **Azure CLI** commands for **Cloud Shell**
(Bash). Cloud Shell has no local Docker daemon, so we build the image in **ACR** with `az acr build`.

Primary path = **Web App for Containers** (managed HTTPS URL). A quick **Container Instances** (ACI)
alternative is at the bottom.

---

## 0. Variables (edit these)

```bash
RG=astra-rg
LOC=germanywestcentral                 # Frankfurt (data residency); or westeurope, etc.
ACR=astraacr$RANDOM                    # must be globally unique, lowercase alphanumeric
APP=astra-agenticos-$RANDOM            # web app name → https://<APP>.azurewebsites.net
PLAN=astra-plan
IMAGE=astra-agenticos:latest
ANTHROPIC_KEY='sk-ant-REPLACE-ME'      # your Anthropic API key
```

## 1. Subscription + resource group

```bash
az account show -o table                       # confirm the right subscription
# az account set --subscription "<name-or-id>" # if you need to switch
az group create -n $RG -l $LOC
```

## 2. Container registry + build the image in the cloud

```bash
az acr create -n $ACR -g $RG --sku Basic --admin-enabled true

# Private GitHub repo: clone with your credentials first (PAT or `gh auth login`)
git clone https://github.com/swarupd227/Astra-AgenticOS.git

# ACR builds the Dockerfile server-side (no local Docker needed)
az acr build -r $ACR -t $IMAGE ./Astra-AgenticOS
```

## 3. App Service plan + Web App for Containers

```bash
# Linux plan. B2 (3.5 GB) recommended — the image bundles Node + the .NET runtime.
az appservice plan create -n $PLAN -g $RG --is-linux --sku B2

ACR_LOGIN=$(az acr show -n $ACR --query loginServer -o tsv)
ACR_USER=$(az acr credential show -n $ACR --query username -o tsv)
ACR_PASS=$(az acr credential show -n $ACR --query 'passwords[0].value' -o tsv)

az webapp create -g $RG -p $PLAN -n $APP \
  --deployment-container-image-name $ACR_LOGIN/$IMAGE

az webapp config container set -g $RG -n $APP \
  --docker-custom-image-name $ACR_LOGIN/$IMAGE \
  --docker-registry-server-url https://$ACR_LOGIN \
  --docker-registry-server-user $ACR_USER \
  --docker-registry-server-password $ACR_PASS
```

## 4. App settings (port + secrets) and start

```bash
az webapp config appsettings set -g $RG -n $APP --settings \
  WEBSITES_PORT=5173 \
  WEBSITES_CONTAINER_START_TIME_LIMIT=600 \
  ANTHROPIC_API_KEY="$ANTHROPIC_KEY" \
  MODEL=claude-sonnet-4-6

az webapp restart -g $RG -n $APP
echo "App URL:  https://$APP.azurewebsites.net"
```

- `WEBSITES_PORT=5173` tells App Service which port the container serves on.
- First start pulls a ~1.9 GB image, so allow a minute or two (the start-time limit is bumped to 600s).
- You can also leave `ANTHROPIC_API_KEY` out and set it later from the app's **Settings** gear — but an
  app setting is the durable way (survives restarts).

## 5. (Recommended for a bank) lock it down — it has no built-in auth

```bash
# Restrict to your office/VPN CIDR(s)
az webapp config access-restriction add -g $RG -n $APP \
  --rule-name office --action Allow --priority 100 --ip-address 203.0.113.0/24

# Or require Entra ID (Azure AD) sign-in:
# az webapp auth update -g $RG -n $APP --enabled true --action RedirectToLoginPage \
#   --identity-providers ... (see `az webapp auth microsoft`)
```

Harden the secret with Key Vault (optional):
```bash
# store the key in Key Vault and reference it from the app setting:
# ANTHROPIC_API_KEY=@Microsoft.KeyVault(SecretUri=https://<vault>.vault.azure.net/secrets/anthropic-key/)
```

## 6. Give it code to analyse

There's no mounted local folder in the cloud, so after the app is up:
- open it → **New project → Git repository** → paste a repo URL (the container has `git`, so it clones
  and indexes it), or
- bake a target repo into the image, or mount Azure Files at `/workspace` and set
  `SEED_PROJECT_ROOT=/workspace` (advanced).

## Logs / troubleshooting

```bash
az webapp log tail -g $RG -n $APP           # live logs
az webapp show -g $RG -n $APP --query state
```

---

## Alternative: Azure Container Instances (fastest, HTTP only)

```bash
ACR_LOGIN=$(az acr show -n $ACR --query loginServer -o tsv)
ACR_USER=$(az acr credential show -n $ACR --query username -o tsv)
ACR_PASS=$(az acr credential show -n $ACR --query 'passwords[0].value' -o tsv)

az container create -g $RG -n astra \
  --image $ACR_LOGIN/$IMAGE \
  --registry-login-server $ACR_LOGIN --registry-username $ACR_USER --registry-password $ACR_PASS \
  --ports 5173 --dns-name-label astra-$RANDOM \
  --cpu 2 --memory 4 \
  --environment-variables MODEL=claude-sonnet-4-6 WEBSITES_PORT=5173 \
  --secure-environment-variables ANTHROPIC_API_KEY="$ANTHROPIC_KEY"

az container show -g $RG -n astra --query ipAddress.fqdn -o tsv
# URL:  http://<fqdn>:5173
```

## Tear down

```bash
az group delete -n $RG --yes --no-wait
```
