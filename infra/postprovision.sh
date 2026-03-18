#!/usr/bin/env bash
set -euo pipefail

# Validate required env vars
for var in entraAppId containerAppFqdn frontDoorUrl managedIdentityClientId keyVaultName AZURE_SUBSCRIPTION_ID AZURE_RESOURCE_GROUP; do
    if [ -z "${!var:-}" ]; then
        echo "ERROR: Missing required env var: $var" >&2
        exit 1
    fi
done

APP_ID="${entraAppId}"
SCOPE_ID="2e1a5b3c-4d6e-7f8a-9b0c-1d2e3f4a5b6c"
AZ_CLI_APP_ID="04b07795-8ddb-461a-bbee-02f9e1bf7b46"
ACA_FQDN="${containerAppFqdn}"
FD_URL="${frontDoorUrl}"
KV_NAME="${keyVaultName}"
SUB_ID="${AZURE_SUBSCRIPTION_ID}"
RG="${AZURE_RESOURCE_GROUP}"
MSI_NAME="msi-${environmentName:-swarmclaw-prod}"
MSI_RESOURCE_ID="/subscriptions/${SUB_ID}/resourceGroups/${RG}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${MSI_NAME}"

echo "Looking up Entra app object ID..."
OBJ_ID=$(az ad app show --id "$APP_ID" --query id -o tsv)
GRAPH_URL="https://graph.microsoft.com/v1.0/applications/${OBJ_ID}"

echo "Setting preAuthorizedApplications..."
TMPFILE=$(mktemp)
cat > "$TMPFILE" <<EOF
{"api":{"preAuthorizedApplications":[{"appId":"${AZ_CLI_APP_ID}","delegatedPermissionIds":["${SCOPE_ID}"]}]}}
EOF
az rest --method PATCH --url "$GRAPH_URL" --body "@${TMPFILE}" --only-show-errors

echo "Setting redirect URIs..."
URIS="\"https://${ACA_FQDN}/.auth/login/aad/callback\""
if [ "$FD_URL" != "N/A" ]; then
    FD_HOST=$(echo "$FD_URL" | sed 's|https://||')
    URIS="${URIS},\"https://${FD_HOST}/.auth/login/aad/callback\""
fi
cat > "$TMPFILE" <<EOF
{"web":{"redirectUris":[${URIS}]}}
EOF
az rest --method PATCH --url "$GRAPH_URL" --body "@${TMPFILE}" --only-show-errors
rm -f "$TMPFILE"

echo "Granting admin consent..."
az ad app permission admin-consent --id "$APP_ID" --only-show-errors || echo "WARNING: Admin consent failed (may already be granted)"

echo "Checking Tailscale KV secret..."
EXISTING_SECRET=$(az keyvault secret show --vault-name "$KV_NAME" --name tailscale-auth-key --query "value" -o tsv 2>/dev/null || true)
if [ -z "$EXISTING_SECRET" ] || [ "$EXISTING_SECRET" = "placeholder-rotate-after-deploy" ]; then
    TS_KEY="${TAILSCALE_AUTH_KEY:-}"
    if [ -z "$TS_KEY" ]; then
        echo "ERROR: TAILSCALE_AUTH_KEY not set in azd env and no valid secret in KV. Run: azd env set TAILSCALE_AUTH_KEY 'tskey-auth-...'" >&2
        exit 1
    fi
    echo "Seeding tailscale-auth-key in Key Vault..."
    az keyvault secret set --vault-name "$KV_NAME" --name tailscale-auth-key --value "$TS_KEY" --only-show-errors
else
    echo "Tailscale KV secret already exists — skipping (will not overwrite)."
fi

echo "Refreshing Tailscale KV secret reference..."
az containerapp secret set -n swarmclaw -g "$RG" \
    --secrets "ts-auth-key=keyvaultref:https://${KV_NAME}.vault.azure.net/secrets/tailscale-auth-key,identityref:${MSI_RESOURCE_ID}" \
    --only-show-errors

echo "Creating new revision..."
az containerapp revision copy -n swarmclaw -g "$RG" --only-show-errors

echo "Post-provision complete."
