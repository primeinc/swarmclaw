import assert from 'node:assert/strict'
import test from 'node:test'

import { runWithTempDataDir } from '@/lib/server/test-utils/run-with-temp-data-dir'

test('missions routes list, detail, and events expose durable mission state', () => {
  const output = runWithTempDataDir<{
    listCount: number
    firstMissionId: string | null
    detailMissionId: string | null
    linkedTaskId: string | null
    parentMissionId: string | null
    eventsCount: number
    latestEventType: string | null
  }>(`
    const storageMod = await import('./src/lib/server/storage')
    const listRouteMod = await import('./src/app/api/missions/route')
    const detailRouteMod = await import('./src/app/api/missions/[id]/route')
    const eventsRouteMod = await import('./src/app/api/missions/[id]/events/route')
    const storage = storageMod.default || storageMod
    const listRoute = listRouteMod.default || listRouteMod
    const detailRoute = detailRouteMod.default || detailRouteMod
    const eventsRoute = eventsRouteMod.default || eventsRouteMod

    storage.saveAgents({
      agentA: {
        id: 'agentA',
        name: 'Agent A',
        provider: 'ollama',
        model: 'test-model',
        systemPrompt: 'test',
      },
    })

    storage.saveTasks({
      taskA: {
        id: 'taskA',
        title: 'Prepare release summary',
        description: 'Create the release summary.',
        status: 'backlog',
        agentId: 'agentA',
        createdAt: 1,
        updatedAt: 1,
        missionId: 'missionA',
      },
    })

    storage.saveMissions({
      missionParent: {
        id: 'missionParent',
        source: 'chat',
        sourceRef: { kind: 'chat', sessionId: 'sessionA' },
        objective: 'Parent mission',
        status: 'active',
        phase: 'planning',
        sessionId: 'sessionA',
        agentId: 'agentA',
        taskIds: [],
        childMissionIds: ['missionA'],
        dependencyMissionIds: [],
        dependencyTaskIds: [],
        createdAt: 1,
        updatedAt: 1,
      },
      missionA: {
        id: 'missionA',
        source: 'chat',
        sourceRef: { kind: 'chat', sessionId: 'sessionA' },
        objective: 'Prepare the release handoff',
        status: 'waiting',
        phase: 'waiting',
        sessionId: 'sessionA',
        agentId: 'agentA',
        parentMissionId: 'missionParent',
        rootMissionId: 'missionParent',
        taskIds: ['taskA'],
        childMissionIds: [],
        dependencyMissionIds: [],
        dependencyTaskIds: [],
        waitState: { kind: 'approval', reason: 'Waiting for release approval.' },
        plannerSummary: 'Track the release handoff.',
        currentStep: 'Wait for approval',
        createdAt: 2,
        updatedAt: 3,
      },
      missionB: {
        id: 'missionB',
        source: 'manual',
        sourceRef: { kind: 'manual' },
        objective: 'Unrelated completed mission',
        status: 'completed',
        phase: 'completed',
        sessionId: 'sessionB',
        agentId: 'agentA',
        taskIds: [],
        childMissionIds: [],
        dependencyMissionIds: [],
        dependencyTaskIds: [],
        createdAt: 1,
        updatedAt: 1,
      },
    })

    storage.saveMissionEvents({
      eventCreated: {
        id: 'eventCreated',
        missionId: 'missionA',
        type: 'created',
        source: 'chat',
        summary: 'Mission created.',
        sessionId: 'sessionA',
        createdAt: 2,
      },
      eventWaiting: {
        id: 'eventWaiting',
        missionId: 'missionA',
        type: 'waiting',
        source: 'system',
        summary: 'Waiting for release approval.',
        sessionId: 'sessionA',
        createdAt: 3,
      },
    })

    const listResponse = await listRoute.GET(new Request('http://local/api/missions?status=waiting&sessionId=sessionA&limit=1'))
    const listPayload = await listResponse.json()

    const detailResponse = await detailRoute.GET(
      new Request('http://local/api/missions/missionA'),
      { params: Promise.resolve({ id: 'missionA' }) },
    )
    const detailPayload = await detailResponse.json()

    const eventsResponse = await eventsRoute.GET(
      new Request('http://local/api/missions/missionA/events?limit=1'),
      { params: Promise.resolve({ id: 'missionA' }) },
    )
    const eventsPayload = await eventsResponse.json()

    console.log(JSON.stringify({
      listCount: Array.isArray(listPayload) ? listPayload.length : -1,
      firstMissionId: Array.isArray(listPayload) ? listPayload[0]?.id || null : null,
      detailMissionId: detailPayload?.mission?.id || null,
      linkedTaskId: Array.isArray(detailPayload?.linkedTasks) ? detailPayload.linkedTasks[0]?.id || null : null,
      parentMissionId: detailPayload?.parent?.id || null,
      eventsCount: Array.isArray(eventsPayload) ? eventsPayload.length : -1,
      latestEventType: Array.isArray(eventsPayload) ? eventsPayload[0]?.type || null : null,
    }))
  `, { prefix: 'swarmclaw-missions-route-' })

  assert.equal(output.listCount, 1)
  assert.equal(output.firstMissionId, 'missionA')
  assert.equal(output.detailMissionId, 'missionA')
  assert.equal(output.linkedTaskId, 'taskA')
  assert.equal(output.parentMissionId, 'missionParent')
  assert.equal(output.eventsCount, 1)
  assert.equal(output.latestEventType, 'waiting')
})

test('mission actions route validates input and persists operator wait actions', () => {
  const output = runWithTempDataDir<{
    invalidStatus: number
    invalidError: string | null
    waitStatus: number
    waitOk: boolean
    missionStatus: string | null
    missionPhase: string | null
    waitKind: string | null
    waitReason: string | null
    eventType: string | null
    eventAction: string | null
  }>(`
    const storageMod = await import('./src/lib/server/storage')
    const actionsRouteMod = await import('./src/app/api/missions/[id]/actions/route')
    const storage = storageMod.default || storageMod
    const actionsRoute = actionsRouteMod.default || actionsRouteMod

    storage.saveMissions({
      missionA: {
        id: 'missionA',
        source: 'chat',
        sourceRef: { kind: 'chat', sessionId: 'sessionA' },
        objective: 'Prepare the release handoff',
        status: 'active',
        phase: 'planning',
        sessionId: 'sessionA',
        taskIds: [],
        childMissionIds: [],
        dependencyMissionIds: [],
        dependencyTaskIds: [],
        createdAt: 1,
        updatedAt: 1,
      },
    })

    const invalidResponse = await actionsRoute.POST(
      new Request('http://local/api/missions/missionA/actions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'ship_it' }),
      }),
      { params: Promise.resolve({ id: 'missionA' }) },
    )
    const invalidPayload = await invalidResponse.json()

    const waitResponse = await actionsRoute.POST(
      new Request('http://local/api/missions/missionA/actions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'wait',
          reason: 'Waiting for operator confirmation.',
          waitKind: 'approval',
        }),
      }),
      { params: Promise.resolve({ id: 'missionA' }) },
    )
    const waitPayload = await waitResponse.json()

    console.log(JSON.stringify({
      invalidStatus: invalidResponse.status,
      invalidError: invalidPayload?.error || null,
      waitStatus: waitResponse.status,
      waitOk: waitPayload?.ok === true,
      missionStatus: waitPayload?.mission?.status || null,
      missionPhase: waitPayload?.mission?.phase || null,
      waitKind: waitPayload?.mission?.waitState?.kind || null,
      waitReason: waitPayload?.mission?.waitState?.reason || null,
      eventType: waitPayload?.appendedEvent?.type || null,
      eventAction: waitPayload?.appendedEvent?.data?.action || null,
    }))
  `, { prefix: 'swarmclaw-missions-route-' })

  assert.equal(output.invalidStatus, 400)
  assert.match(String(output.invalidError || ''), /invalid mission action/i)
  assert.equal(output.waitStatus, 200)
  assert.equal(output.waitOk, true)
  assert.equal(output.missionStatus, 'waiting')
  assert.equal(output.missionPhase, 'waiting')
  assert.equal(output.waitKind, 'approval')
  assert.equal(output.waitReason, 'Waiting for operator confirmation.')
  assert.equal(output.eventType, 'operator_action')
  assert.equal(output.eventAction, 'wait')
})
