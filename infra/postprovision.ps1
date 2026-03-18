$ErrorActionPreference = "Stop"

# Validate all required env vars from azd outputs
$required = @{
    entraAppId = $env:entraAppId
    containerAppFqdn = $env:containerAppFqdn
    frontDoorUrl = $env:frontDoorUrl
    managedIdentityClientId = $env:managedIdentityClientId
    keyVaultName = $env:keyVaultName
    AZURE_SUBSCRIPTION_ID = $env:AZURE_SUBSCRIPTION_ID
    AZURE_RESOURCE_GROUP = $env:AZURE_RESOURCE_GROUP
}
foreach ($kv in $required.GetEnumerator()) {
    if ([string]::IsNullOrEmpty($kv.Value)) {
        Write-Error "Missing required env var: $($kv.Key)"
        exit 1
    }
}

$APP_ID = $required.entraAppId
$SCOPE_ID = "2e1a5b3c-4d6e-7f8a-9b0c-1d2e3f4a5b6c"
$AZ_CLI_APP_ID = "04b07795-8ddb-461a-bbee-02f9e1bf7b46"
$ACA_FQDN = $required.containerAppFqdn
$FD_URL = $required.frontDoorUrl
$KV_NAME = $required.keyVaultName
$SUB_ID = $required.AZURE_SUBSCRIPTION_ID
$RG = $required.AZURE_RESOURCE_GROUP
$MSI_NAME = "msi-$env:environmentName"
if ([string]::IsNullOrEmpty($env:environmentName)) { $MSI_NAME = "msi-swarmclaw-prod" }
$MSI_RESOURCE_ID = "/subscriptions/$SUB_ID/resourceGroups/$RG/providers/Microsoft.ManagedIdentity/userAssignedIdentities/$MSI_NAME"

# Get Entra app object ID
Write-Host "Looking up Entra app object ID..."
$OBJ_ID = (az ad app show --id $APP_ID --query id -o tsv 2>&1)
if ($LASTEXITCODE -ne 0) { Write-Error "Failed to look up Entra app: $OBJ_ID"; exit 1 }
$graphUrl = "https://graph.microsoft.com/v1.0/applications/$OBJ_ID"
$tempFile = [System.IO.Path]::GetTempFileName()

# Set preAuthorizedApplications
Write-Host "Setting preAuthorizedApplications..."
@"
{"api":{"preAuthorizedApplications":[{"appId":"$AZ_CLI_APP_ID","delegatedPermissionIds":["$SCOPE_ID"]}]}}
"@ | Set-Content -Path $tempFile -Encoding utf8NoBOM
az rest --method PATCH --url $graphUrl --body "@$tempFile" --only-show-errors
if ($LASTEXITCODE -ne 0) { Write-Error "Failed to set preAuthorizedApplications"; exit 1 }

# Set redirect URIs
Write-Host "Setting redirect URIs..."
$uris = @("https://$ACA_FQDN/.auth/login/aad/callback")
if ($FD_URL -ne "N/A") {
    $fdHost = $FD_URL -replace "https://", ""
    $uris += "https://$fdHost/.auth/login/aad/callback"
}
$urisJson = ($uris | ForEach-Object { "`"$_`"" }) -join ","
@"
{"web":{"redirectUris":[$urisJson]}}
"@ | Set-Content -Path $tempFile -Encoding utf8NoBOM
az rest --method PATCH --url $graphUrl --body "@$tempFile" --only-show-errors
if ($LASTEXITCODE -ne 0) { Write-Error "Failed to set redirect URIs"; exit 1 }

Remove-Item $tempFile -ErrorAction SilentlyContinue

# Grant admin consent
Write-Host "Granting admin consent..."
az ad app permission admin-consent --id $APP_ID --only-show-errors
if ($LASTEXITCODE -ne 0) { Write-Host "WARNING: Admin consent failed (may already be granted)" }

# Seed Tailscale KV secret (only if missing or placeholder)
Write-Host "Checking Tailscale KV secret..."
$existingSecret = az keyvault secret show --vault-name $KV_NAME --name tailscale-auth-key --query "value" -o tsv 2>$null
if ([string]::IsNullOrEmpty($existingSecret) -or $existingSecret -eq "placeholder-rotate-after-deploy") {
    $tsKey = $env:TAILSCALE_AUTH_KEY
    if ([string]::IsNullOrEmpty($tsKey)) {
        Write-Error "TAILSCALE_AUTH_KEY not set in azd env and no valid secret in KV. Run: azd env set TAILSCALE_AUTH_KEY 'tskey-auth-...'"
        exit 1
    }
    Write-Host "Seeding tailscale-auth-key in Key Vault..."
    az keyvault secret set --vault-name $KV_NAME --name tailscale-auth-key --value $tsKey --only-show-errors
    if ($LASTEXITCODE -ne 0) { Write-Error "Failed to set Tailscale secret in KV"; exit 1 }
} else {
    Write-Host "Tailscale KV secret already exists — skipping (will not overwrite)."
}

# Refresh Tailscale KV secret reference
Write-Host "Refreshing Tailscale KV secret reference..."
az containerapp secret set -n swarmclaw -g $RG --secrets "ts-auth-key=keyvaultref:https://$KV_NAME.vault.azure.net/secrets/tailscale-auth-key,identityref:$MSI_RESOURCE_ID" --only-show-errors
if ($LASTEXITCODE -ne 0) { Write-Error "Failed to refresh Tailscale secret"; exit 1 }

# New revision to pick up fresh secrets
Write-Host "Creating new revision..."
az containerapp revision copy -n swarmclaw -g $RG --only-show-errors
if ($LASTEXITCODE -ne 0) { Write-Error "Failed to create new revision"; exit 1 }

Write-Host "Post-provision complete."
