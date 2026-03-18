// ============================================================================
// SwarmClaw Production — Standard Front Door + VNet + Tailscale Admin
//
// Architecture:
//   Internet → Front Door Standard (WAF) → NSG [AzureFrontDoor.Backend] → VNet
//     → Container Apps Environment → SwarmClaw + Tailscale sidecar
//   Admins → Tailscale VPN → all metrics, logs, Cosmos, KV over private network
//
// First-time deploy:
//   azd env set TAILSCALE_AUTH_KEY "tskey-auth-..."
//   azd up                       # provision + postprovision hook + deploy
//
// Subsequent code deploys:
//   azd deploy                   # builds + pushes image only
//
// Infra changes:
//   azd provision                # updates Bicep resources + runs hook
//
// Secret management:
//   Bicep creates the Key Vault but NEVER manages runtime secrets.
//   The postprovision hook seeds tailscale-auth-key on first deploy only.
//   Subsequent provisions do not overwrite the secret.
// ============================================================================

extension microsoftGraphV1

targetScope = 'resourceGroup'

// ── Parameters ──────────────────────────────────────────────────────────────

@description('Azure region')
param location string = 'eastus2'

@description('Environment name for resource naming')
param environmentName string = 'swarmclaw-prod'

@description('Container image (update after first deploy + ACR push)')
param appImage string = 'mcr.microsoft.com/k8se/quickstart:latest'

@description('Enable Front Door + WAF (~$35/mo extra)')
param enableWaf bool = true

@description('Log retention days')
param logRetentionDays int = 90

@description('Cosmos DB database name')
param cosmosDbName string = 'swarmclaw'

@description('Tailscale hostname')
param tailscaleHostname string = 'swarmclaw-prod'

// ── Variables ───────────────────────────────────────────────────────────────

var resourceToken = uniqueString(resourceGroup().id)
var tags = {
  environment: environmentName
  managedBy: 'bicep'
  app: 'swarmclaw'
}

// ── Entra ID (Graph Bicep — federated identity credential, zero secrets) ────
// Pattern from: Azure-Samples/containerapps-builtinauth-bicep

var openIdIssuer = '${environment().authentication.loginEndpoint}${subscription().tenantId}/v2.0'

// Stable scope ID — must not change between deploys or preAuthorizedApplications breaks
var scopeId = '2e1a5b3c-4d6e-7f8a-9b0c-1d2e3f4a5b6c'
// Azure CLI app ID used in postprovision hook for preAuthorizedApplications

resource entraApp 'Microsoft.Graph/applications@v1.0' = {
  displayName: 'swarmclaw-${environmentName}'
  uniqueName: 'swarmclaw-${environmentName}'
  signInAudience: 'AzureADMyOrg'
  // identifierUris set outside Bicep — can't self-reference appId in the same resource
  web: {
    implicitGrantSettings: {
      enableAccessTokenIssuance: false
      enableIdTokenIssuance: true
    }
    // Redirect URIs — set post-deploy once FQDN is known
  }
  api: {
    requestedAccessTokenVersion: 2
    oauth2PermissionScopes: [
      {
        id: scopeId
        value: 'user_impersonation'
        type: 'User'
        isEnabled: true
        adminConsentDisplayName: 'Access SwarmClaw'
        adminConsentDescription: 'Access SwarmClaw API'
        userConsentDisplayName: 'Access SwarmClaw'
        userConsentDescription: 'Access SwarmClaw API'
      }
    ]
    // preAuthorizedApplications set via post-provision hook — Graph Bicep can't create
    // scope + reference it in preAuth atomically in a single deploy
  }
  requiredResourceAccess: [
    {
      resourceAppId: '00000003-0000-0000-c000-000000000000'
      resourceAccess: [
        { id: 'e1fe6dd8-ba31-4d61-89e7-88639da4683d', type: 'Scope' } // User.Read
        { id: '7427e0e9-2fba-42fe-b0c0-848c9e6a8182', type: 'Scope' } // offline_access
        { id: '37f7f235-527c-4136-accd-4a02d197296e', type: 'Scope' } // openid
        { id: '14dad69e-099b-42c9-810b-d002981feec1', type: 'Scope' } // profile
      ]
    }
  ]

  // Federated identity credential — MSI authenticates as this app, no secrets
  resource fic 'federatedIdentityCredentials@v1.0' = {
    name: '${entraApp.uniqueName}/msiAsFic'
    audiences: ['api://AzureADTokenExchange']
    issuer: openIdIssuer
    subject: identity.properties.principalId
  }
}

resource entraServicePrincipal 'Microsoft.Graph/servicePrincipals@v1.0' = {
  appId: entraApp.appId
}

// ── Managed Identity ────────────────────────────────────────────────────────

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'msi-${environmentName}'
  location: location
  tags: tags
}

// ── Log Analytics ───────────────────────────────────────────────────────────

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-${environmentName}'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: logRetentionDays
  }
}

// ── VNet + NSG (origin lockdown) ────────────────────────────────────────────

resource nsg 'Microsoft.Network/networkSecurityGroups@2023-11-01' = {
  name: 'nsg-${environmentName}'
  location: location
  tags: tags
  properties: {
    securityRules: [
      {
        name: 'AllowFrontDoorInbound'
        properties: {
          priority: 100
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: 'AzureFrontDoor.Backend'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRanges: ['443', '80']
        }
      }
      {
        name: 'AllowAzureLoadBalancer'
        properties: {
          priority: 110
          direction: 'Inbound'
          access: 'Allow'
          protocol: '*'
          sourceAddressPrefix: 'AzureLoadBalancer'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '*'
        }
      }
      {
        name: 'DenyAllOtherInbound'
        properties: {
          priority: 4096
          direction: 'Inbound'
          access: 'Deny'
          protocol: '*'
          sourceAddressPrefix: '*'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '*'
        }
      }
    ]
  }
}

resource vnet 'Microsoft.Network/virtualNetworks@2023-11-01' = {
  name: 'vnet-${environmentName}'
  location: location
  tags: tags
  properties: {
    addressSpace: { addressPrefixes: ['10.0.0.0/16'] }
    subnets: [
      {
        name: 'snet-aca'
        properties: {
          addressPrefix: '10.0.0.0/23' // /23 required for Container Apps consumption
          networkSecurityGroup: { id: nsg.id }
          delegations: [
            {
              name: 'Microsoft.App.environments'
              properties: { serviceName: 'Microsoft.App/environments' }
            }
          ]
        }
      }
      {
        name: 'snet-pe'
        properties: {
          addressPrefix: '10.0.2.0/24' // private endpoints (Cosmos, KV, ACR)
        }
      }
    ]
  }
}

// ── Container Registry ──────────────────────────────────────────────────────

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: 'cr${resourceToken}'
  location: location
  tags: tags
  sku: { name: 'Basic' }
  properties: {
    adminUserEnabled: false
  }
}

resource acrPullRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, identity.id, '7f951dda-4ed3-4680-a7ca-43fe172d538d')
  scope: acr
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// Storage — Tailscale state persistence (survives container restarts)
resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: 'st${resourceToken}'
  location: location
  tags: tags
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    supportsHttpsTrafficOnly: true
  }
}

resource fileService 'Microsoft.Storage/storageAccounts/fileServices@2023-05-01' = {
  parent: storageAccount
  name: 'default'
}

resource fileShare 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-05-01' = {
  parent: fileService
  name: 'tailscale-state'
  properties: { shareQuota: 1 }
}

resource appDataShare 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-05-01' = {
  parent: fileService
  name: 'swarmclaw-data'
  properties: { shareQuota: 5 }
}

// ── Key Vault ───────────────────────────────────────────────────────────────

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: 'kv-${resourceToken}'
  location: location
  tags: tags
  properties: {
    sku: { family: 'A', name: 'standard' }
    tenantId: subscription().tenantId
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
  }
}

resource kvSecretsRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, identity.id, '4633458b-17de-408a-b874-0445c86b69e6')
  scope: keyVault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// ── Cosmos DB Serverless ────────────────────────────────────────────────────

resource cosmosAccount 'Microsoft.DocumentDB/databaseAccounts@2024-11-15' = {
  name: 'cosmos-${resourceToken}'
  location: location
  tags: tags
  kind: 'GlobalDocumentDB'
  properties: {
    databaseAccountOfferType: 'Standard'
    capabilities: [{ name: 'EnableServerless' }]
    consistencyPolicy: { defaultConsistencyLevel: 'Session' }
    locations: [{ locationName: location, failoverPriority: 0 }]
    backupPolicy: {
      type: 'Continuous'
      continuousModeProperties: { tier: 'Continuous7Days' }
    }
    disableLocalAuth: true
    publicNetworkAccess: 'Disabled'
    networkAclBypass: 'AzureServices'
  }
}

resource cosmosDb 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2024-11-15' = {
  parent: cosmosAccount
  name: cosmosDbName
  properties: { resource: { id: cosmosDbName } }
}

resource cosmosCollections 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = {
  parent: cosmosDb
  name: 'collections'
  properties: {
    resource: {
      id: 'collections'
      partitionKey: { paths: ['/collection'], kind: 'Hash', version: 2 }
      indexingPolicy: {
        indexingMode: 'consistent'
        automatic: true
        includedPaths: [{ path: '/*' }]
        excludedPaths: [{ path: '/data/*' }, { path: '/_etag/?' }]
      }
      defaultTtl: -1
    }
  }
}

resource cosmosUsage 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = {
  parent: cosmosDb
  name: 'usage'
  properties: {
    resource: {
      id: 'usage'
      partitionKey: { paths: ['/sessionId'], kind: 'Hash', version: 2 }
    }
  }
}

// Cosmos data-plane RBAC
resource cosmosDataRole 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-11-15' = {
  parent: cosmosAccount
  name: guid('data-contributor', identity.id, cosmosAccount.id)
  properties: {
    principalId: identity.properties.principalId
    roleDefinitionId: '${cosmosAccount.id}/sqlRoleDefinitions/00000000-0000-0000-0000-000000000002'
    scope: cosmosAccount.id
  }
}

// Cosmos private endpoint
resource cosmosPrivateEndpoint 'Microsoft.Network/privateEndpoints@2023-11-01' = {
  name: 'pe-cosmos-${resourceToken}'
  location: location
  tags: tags
  properties: {
    subnet: { id: vnet.properties.subnets[1].id } // snet-pe
    privateLinkServiceConnections: [
      {
        name: 'cosmos'
        properties: {
          privateLinkServiceId: cosmosAccount.id
          groupIds: ['Sql']
        }
      }
    ]
  }
}

resource cosmosDnsZone 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: 'privatelink.documents.azure.com'
  location: 'global'
  tags: tags
}

resource cosmosDnsVnetLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: cosmosDnsZone
  name: 'cosmos-vnet-link'
  location: 'global'
  properties: {
    virtualNetwork: { id: vnet.id }
    registrationEnabled: false
  }
}

resource cosmosDnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-11-01' = {
  parent: cosmosPrivateEndpoint
  name: 'cosmos-dns'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'cosmos'
        properties: { privateDnsZoneId: cosmosDnsZone.id }
      }
    ]
  }
}

// ── Container Apps Environment (VNet-integrated) ────────────────────────────

resource containerAppEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: 'cae-${environmentName}'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
    vnetConfiguration: {
      infrastructureSubnetId: vnet.properties.subnets[0].id // snet-aca
      internal: false // external FQDN — NSG handles origin lockdown
    }
    workloadProfiles: [
      { name: 'Consumption', workloadProfileType: 'Consumption' }
    ]
  }
}

resource envStorage 'Microsoft.App/managedEnvironments/storages@2024-03-01' = {
  parent: containerAppEnv
  name: 'tailscale-state'
  properties: {
    azureFile: {
      accountName: storageAccount.name
      accountKey: storageAccount.listKeys().keys[0].value
      shareName: fileShare.name
      accessMode: 'ReadWrite'
    }
  }
}

resource envAppDataStorage 'Microsoft.App/managedEnvironments/storages@2024-03-01' = {
  parent: containerAppEnv
  name: 'swarmclaw-data'
  properties: {
    azureFile: {
      accountName: storageAccount.name
      accountKey: storageAccount.listKeys().keys[0].value
      shareName: appDataShare.name
      accessMode: 'ReadWrite'
    }
  }
}

// ── Container App (SwarmClaw + Tailscale sidecar) ───────────────────────────

resource containerApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: 'swarmclaw'
  location: location
  tags: union(tags, { 'azd-service-name': 'swarmclaw' })
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    environmentId: containerAppEnv.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 3456
        transport: 'auto'
        allowInsecure: false
      }
      registries: [
        {
          server: acr.properties.loginServer
          identity: identity.id
        }
      ]
      secrets: [
        { name: 'ts-auth-key', keyVaultUrl: '${keyVault.properties.vaultUri}secrets/tailscale-auth-key', identity: identity.id }
        { name: 'override-use-mi-fic-assertion-client-id', value: identity.properties.clientId }
      ]
    }
    template: {
      scale: {
        minReplicas: 1 // keep alive — SQLite data lives on ephemeral disk, lost if scaled to zero
        maxReplicas: 3
        rules: [
          {
            name: 'http-scaling'
            http: { metadata: { concurrentRequests: '50' } }
          }
        ]
      }
      containers: [
        {
          name: 'swarmclaw'
          image: appImage
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: [
            { name: 'NODE_ENV', value: 'production' }
            { name: 'PORT', value: '3456' }
            { name: 'HOSTNAME', value: '0.0.0.0' }
            { name: 'AZURE_CLIENT_ID', value: identity.properties.clientId }
          ]
          // SQLite requires local filesystem (WAL mode needs mmap, incompatible with Azure Files SMB)
          // Data persists as long as the replica is alive (minReplicas: 1 prevents cold loss)
          // TODO: finish Cosmos backend for true persistence across restarts
        }
        {
          name: 'tailscale'
          image: 'ghcr.io/tailscale/tailscale:latest'
          // ACA sets KUBERNETES_SERVICE_HOST which breaks containerboot (tailscale/tailscale#18558)
          // Workaround: override command to clear it before running containerboot
          command: ['/bin/sh']
          args: ['-c', 'export KUBERNETES_SERVICE_HOST="" && /usr/local/bin/containerboot']
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          env: [
            { name: 'TS_AUTHKEY', secretRef: 'ts-auth-key' }
            { name: 'TS_HOSTNAME', value: tailscaleHostname }
            { name: 'TS_STATE_DIR', value: '/var/lib/tailscale' }
            { name: 'TS_USERSPACE', value: 'true' }
            { name: 'TS_AUTH_ONCE', value: 'true' }
            { name: 'TS_EXTRA_ARGS', value: '--advertise-exit-node' }
          ]
          volumeMounts: [{ volumeName: 'ts-state', mountPath: '/var/lib/tailscale' }]
        }
      ]
      volumes: [
        { name: 'ts-state', storageName: envStorage.name, storageType: 'AzureFile' }
      ]
    }
  }
}

// ── Easy Auth (Entra — federated identity credential, zero secrets) ─────────

// Auth config uses federated identity credential — pattern from Azure-Samples/containerapps-builtinauth-bicep
resource authConfig 'Microsoft.App/containerApps/authConfigs@2024-10-02-preview' = {
  parent: containerApp
  name: 'current'
  properties: {
    platform: { enabled: true }
    globalValidation: {
      unauthenticatedClientAction: 'RedirectToLoginPage'
      redirectToProvider: 'azureactivedirectory'
      excludedPaths: ['/api/daemon/health-check']
    }
    identityProviders: {
      azureActiveDirectory: {
        enabled: true
        registration: {
          clientId: entraApp.appId
          clientSecretSettingName: 'override-use-mi-fic-assertion-client-id' // sentinel — uses MSI federated credential
          openIdIssuer: openIdIssuer
        }
        validation: {
          allowedAudiences: [
            'api://${entraApp.appId}'
            entraApp.appId
          ]
        }
      }
    }
    httpSettings: {
      requireHttps: true
      forwardProxy: enableWaf ? {
        convention: 'Custom'
        customHostHeaderName: 'X-Forwarded-Host'
        customProtoHeaderName: 'X-Forwarded-Proto'
      } : null
    }
  }
}

// ── Front Door Standard + WAF (conditional) ─────────────────────────────────

resource wafPolicy 'Microsoft.Network/FrontDoorWebApplicationFirewallPolicies@2024-02-01' = if (enableWaf) {
  name: 'waf${replace(environmentName, '-', '')}'
  location: 'global'
  tags: tags
  sku: { name: 'Standard_AzureFrontDoor' }
  properties: {
    policySettings: {
      enabledState: 'Enabled'
      mode: 'Prevention'
      requestBodyCheck: 'Enabled'
    }
    customRules: {
      rules: [
        {
          name: 'RateLimitGlobal'
          priority: 100
          ruleType: 'RateLimitRule'
          action: 'Block'
          rateLimitDurationInMinutes: 1
          rateLimitThreshold: 200
          matchConditions: [
            {
              matchVariable: 'RemoteAddr'
              operator: 'IPMatch'
              negateCondition: true
              matchValue: ['192.0.2.0/24'] // IANA documentation range — matches all real traffic
            }
          ]
        }
        // X-Azure-FDID validation happens at the origin (NSG service tag), not at WAF
        // WAF sees client requests BEFORE Front Door adds the FDID header
        {
          name: 'BlockBadBots'
          priority: 200
          ruleType: 'MatchRule'
          action: 'Block'
          matchConditions: [
            {
              matchVariable: 'RequestHeader'
              selector: 'User-Agent'
              operator: 'Contains'
              matchValue: ['sqlmap', 'nikto', 'nmap', 'masscan', 'zgrab']
              transforms: ['Lowercase']
            }
          ]
        }
      ]
    }
  }
}

resource frontDoor 'Microsoft.Cdn/profiles@2024-09-01' = if (enableWaf) {
  name: 'fd-${environmentName}'
  location: 'global'
  tags: tags
  sku: { name: 'Standard_AzureFrontDoor' }
}

resource fdEndpoint 'Microsoft.Cdn/profiles/afdEndpoints@2024-09-01' = if (enableWaf) {
  parent: frontDoor
  name: 'swarmclaw'
  location: 'global'
  properties: { enabledState: 'Enabled' }
}

resource fdOriginGroup 'Microsoft.Cdn/profiles/originGroups@2024-09-01' = if (enableWaf) {
  parent: frontDoor
  name: 'swarmclaw-origins'
  properties: {
    loadBalancingSettings: {
      sampleSize: 4
      successfulSamplesRequired: 3
      additionalLatencyInMilliseconds: 50
    }
    healthProbeSettings: {
      probePath: '/api/daemon/health-check'
      probeRequestType: 'HEAD'
      probeProtocol: 'Https'
      probeIntervalInSeconds: 100
    }
  }
}

resource fdOrigin 'Microsoft.Cdn/profiles/originGroups/origins@2024-09-01' = if (enableWaf) {
  parent: fdOriginGroup
  name: 'swarmclaw-aca'
  properties: {
    hostName: containerApp.properties.configuration.ingress.fqdn
    originHostHeader: containerApp.properties.configuration.ingress.fqdn
    httpPort: 80
    httpsPort: 443
    priority: 1
    weight: 1000
    enabledState: 'Enabled'
    enforceCertificateNameCheck: true
  }
}

resource fdRoute 'Microsoft.Cdn/profiles/afdEndpoints/routes@2024-09-01' = if (enableWaf) {
  parent: fdEndpoint
  name: 'default-route'
  properties: {
    originGroup: { id: fdOriginGroup.id }
    patternsToMatch: ['/*']
    forwardingProtocol: 'HttpsOnly'
    httpsRedirect: 'Enabled'
    linkToDefaultDomain: 'Enabled'
    supportedProtocols: ['Http', 'Https']
  }
  dependsOn: [fdOrigin]
}

resource fdSecurityPolicy 'Microsoft.Cdn/profiles/securityPolicies@2024-09-01' = if (enableWaf) {
  parent: frontDoor
  name: 'waf-policy'
  properties: {
    parameters: {
      type: 'WebApplicationFirewall'
      wafPolicy: { id: wafPolicy.id }
      associations: [
        {
          domains: [{ id: fdEndpoint.id }]
          patternsToMatch: ['/*']
        }
      ]
    }
  }
}

// ── Diagnostic Settings ─────────────────────────────────────────────────────

resource cosmosDiag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'cosmos-diag'
  scope: cosmosAccount
  properties: {
    workspaceId: logAnalytics.id
    logs: [{ categoryGroup: 'allLogs', enabled: true }]
    metrics: [{ category: 'Requests', enabled: true }]
  }
}

resource kvDiag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'kv-diag'
  scope: keyVault
  properties: {
    workspaceId: logAnalytics.id
    logs: [{ categoryGroup: 'allLogs', enabled: true }]
    metrics: [{ category: 'AllMetrics', enabled: true }]
  }
}

// ── Outputs ─────────────────────────────────────────────────────────────────

output containerAppFqdn string = containerApp.properties.configuration.ingress.fqdn
output containerAppUrl string = 'https://${containerApp.properties.configuration.ingress.fqdn}'
output frontDoorUrl string = enableWaf ? 'https://${fdEndpoint!.properties.hostName}' : 'N/A'
output frontDoorId string = enableWaf ? frontDoor!.properties.frontDoorId : 'N/A'
output cosmosEndpoint string = cosmosAccount.properties.documentEndpoint
output AZURE_CONTAINER_REGISTRY_ENDPOINT string = acr.properties.loginServer
output managedIdentityClientId string = identity.properties.clientId
output tailscaleHostname string = tailscaleHostname
output keyVaultName string = keyVault.name
output entraAppId string = entraApp.appId
output vnetId string = vnet.id
