import { enqueueOrchestratorEvent } from '@/lib/server/runtime/system-events'
import { isOrchestratorEligible } from '@/lib/orchestrator-config'
import { loadAgents } from '@/lib/server/storage'

/**
 * Broadcast an event to all orchestrator-enabled agents.
 * Best-effort — swallows errors so callers aren't disrupted.
 */
export function notifyOrchestrators(text: string, contextKey?: string): void {
  try {
    const agents = loadAgents()
    for (const agent of Object.values(agents)) {
      if (agent.orchestratorEnabled && !agent.disabled && !agent.trashedAt && isOrchestratorEligible(agent)) {
        enqueueOrchestratorEvent(agent.id, text, contextKey)
      }
    }
  } catch { /* best-effort */ }
}
