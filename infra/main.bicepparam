using './main.bicep'

param location = 'eastus2'
param environmentName = 'swarmclaw-prod'
param enableWaf = true
param logRetentionDays = 90
param cosmosDbName = 'swarmclaw'
param tailscaleHostname = 'swarmclaw-prod'
