/**
 * Protocol for-each step processing.
 * Group G13 from protocol-service.ts
 */
import type {
  ProtocolForEachConfig,
  ProtocolRun,
  ProtocolRunForEachStepState,
  ProtocolRunParallelBranchState,
  ProtocolStepDefinition,
} from '@/types'
import { cleanText, now, uniqueIds } from '@/lib/server/protocols/protocol-types'
import type { ProtocolRunDeps } from '@/lib/server/protocols/protocol-types'
import {
  appendProtocolEvent,
  persistRun,
} from '@/lib/server/protocols/protocol-agent-turn'
import {
  beginStep,
  buildParallelBranchState,
  finishStep,
  syncForEachParentFromChildRun,
} from '@/lib/server/protocols/protocol-step-helpers'

// Re-export so any external callers still find it here
export { syncForEachParentFromChildRun }

export async function resolveForEachItems(
  run: ProtocolRun,
  config: ProtocolForEachConfig,
): Promise<unknown[]> {
  const source = config.itemsSource
  if (source.type === 'literal') return source.items
  if (source.type === 'step_output') {
    const output = run.stepOutputs?.[source.stepId]
    if (!output?.structuredData) return []
    if (source.path) {
      const val = (output.structuredData as Record<string, unknown>)[source.path]
      return Array.isArray(val) ? val : []
    }
    const data = output.structuredData
    // If structuredData is itself an array-like value, extract items
    if (Array.isArray(data)) return data
    if ('items' in data && Array.isArray(data.items)) return data.items as unknown[]
    return [data]
  }
  if (source.type === 'artifact') {
    const artifacts = run.artifacts || []
    if (source.artifactId) {
      const found = artifacts.find((a) => a.id === source.artifactId)
      return found ? [found.content] : []
    }
    if (source.artifactKind) {
      return artifacts.filter((a) => a.kind === source.artifactKind).map((a) => a.content)
    }
    return artifacts.map((a) => a.content)
  }
  // llm_extract would require an LLM call — for now, return empty (to be extended)
  return []
}

export async function processForEachStep(run: ProtocolRun, step: ProtocolStepDefinition, deps?: ProtocolRunDeps): Promise<ProtocolRun> {
  const config = step.forEach
  if (!config) {
    throw new Error(`For-each step "${step.label}" is missing forEach config.`)
  }

  const started = beginStep(run, step, deps)
  const items = await resolveForEachItems(started, config)

  const maxItems = config.maxItems || 50
  const truncatedItems = items.slice(0, maxItems)

  if (truncatedItems.length === 0) {
    const policy = config.onEmpty || 'fail'
    if (policy === 'fail') {
      throw new Error(`For-each step "${step.label}" resolved zero items and onEmpty is "fail".`)
    }
    appendProtocolEvent(run.id, {
      type: 'for_each_expanded',
      stepId: step.id,
      summary: `For-each step "${step.label}" resolved zero items, policy: ${policy}.`,
      data: { itemCount: 0, policy },
    }, deps)
    if (policy === 'skip') {
      return finishStep(started, step, step.nextStepId || null, deps)
    }
    // 'advance'
    return finishStep(started, step, step.nextStepId || null, deps)
  }

  if (truncatedItems.length < items.length) {
    appendProtocolEvent(run.id, {
      type: 'warning',
      stepId: step.id,
      summary: `For-each items truncated from ${items.length} to ${maxItems} (maxItems limit).`,
    }, deps)
  }

  const branches: ProtocolRunParallelBranchState[] = []
  const branchRunIds: string[] = []
  const branchTemplate = config.branchTemplate

  const participantAgentIds = uniqueIds(
    branchTemplate.participantAgentIds && branchTemplate.participantAgentIds.length > 0
      ? branchTemplate.participantAgentIds
      : started.participantAgentIds,
    64,
  )

  appendProtocolEvent(run.id, {
    type: 'for_each_expanded',
    stepId: step.id,
    summary: `For-each step "${step.label}" expanding ${truncatedItems.length} items into branches.`,
    data: { itemCount: truncatedItems.length, alias: config.itemAlias },
  }, deps)

  // Lazy import to avoid circular dependency
  const { createProtocolRun, requestProtocolRunExecution } = require('@/lib/server/protocols/protocol-run-lifecycle') as typeof import('@/lib/server/protocols/protocol-run-lifecycle')

  for (let i = 0; i < truncatedItems.length; i++) {
    const item = truncatedItems[i]
    const branchId = `for_each_${i}`
    const itemLabel = typeof item === 'string' ? item.slice(0, 80) : `Item ${i + 1}`
    const childRun = createProtocolRun({
      title: `${started.title} — ${config.itemAlias}: ${itemLabel}`,
      templateId: 'custom',
      steps: branchTemplate.steps,
      entryStepId: branchTemplate.entryStepId || branchTemplate.steps[0]?.id || null,
      participantAgentIds,
      facilitatorAgentId: cleanText(branchTemplate.facilitatorAgentId, 64) || participantAgentIds[0] || null,
      sessionId: started.sessionId || null,
      sourceRef: {
        kind: 'protocol_run',
        runId: started.id,
        parentRunId: started.id,
        stepId: step.id,
        branchId,
      },
      autoStart: false,
      createTranscript: true,
      config: {
        ...(started.config || {}),
        goal: `Process ${config.itemAlias}: ${typeof item === 'string' ? item : JSON.stringify(item)}`,
        postSummaryToParent: false,
      },
      parentRunId: started.id,
      parentStepId: step.id,
      branchId,
      systemOwned: true,
    }, deps)
    // Inject item context into child run's operatorContext
    const itemContext = `[for_each] ${config.itemAlias} = ${typeof item === 'string' ? item : JSON.stringify(item)}`
    persistRun({
      ...childRun,
      operatorContext: [...(childRun.operatorContext || []), itemContext],
    })
    branchRunIds.push(childRun.id)
    branches.push(buildParallelBranchState(childRun, {
      branchId,
      label: itemLabel,
      runId: childRun.id,
      participantAgentIds,
    }))
  }

  const forEachStepState: ProtocolRunForEachStepState = {
    stepId: step.id,
    items: truncatedItems,
    branchRunIds,
    branches,
    waitingOnBranchIds: branchRunIds,
    joinReady: false,
    joinCompletedAt: null,
  }

  const updated = persistRun({
    ...started,
    forEachState: {
      ...(started.forEachState || {}),
      [step.id]: forEachStepState,
    },
    status: 'waiting',
    waitingReason: `Waiting for ${truncatedItems.length} for-each branch${truncatedItems.length === 1 ? '' : 'es'} to complete.`,
    updatedAt: now(deps),
  })

  for (const runId of branchRunIds) {
    requestProtocolRunExecution(runId, deps)
  }
  return updated
}

