import { NextResponse } from 'next/server'
import type { MissionPhase, MissionSource, MissionStatus } from '@/types'
import { listMissions } from '@/lib/server/missions/mission-service'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const sessionId = searchParams.get('sessionId')
  const agentId = searchParams.get('agentId')
  const projectId = searchParams.get('projectId')
  const parentMissionId = searchParams.get('parentMissionId')
  const limitParam = searchParams.get('limit')
  const rawStatus = searchParams.get('status')
  const rawPhase = searchParams.get('phase')
  const rawSource = searchParams.get('source')
  const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined
  const status = rawStatus === 'non_terminal'
    || rawStatus === 'active'
    || rawStatus === 'waiting'
    || rawStatus === 'completed'
    || rawStatus === 'failed'
    || rawStatus === 'cancelled'
    ? rawStatus as MissionStatus | 'non_terminal'
    : undefined
  const phase = rawPhase === 'intake'
    || rawPhase === 'planning'
    || rawPhase === 'dispatching'
    || rawPhase === 'executing'
    || rawPhase === 'verifying'
    || rawPhase === 'waiting'
    || rawPhase === 'completed'
    || rawPhase === 'failed'
    ? rawPhase as MissionPhase
    : undefined
  const source = rawSource === 'chat'
    || rawSource === 'connector'
    || rawSource === 'heartbeat'
    || rawSource === 'main-loop-followup'
    || rawSource === 'task'
    || rawSource === 'schedule'
    || rawSource === 'delegation'
    || rawSource === 'manual'
    ? rawSource as MissionSource
    : undefined

  return NextResponse.json(listMissions({
    ...(sessionId ? { sessionId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(projectId ? { projectId } : {}),
    ...(parentMissionId ? { parentMissionId } : {}),
    ...(status ? { status } : {}),
    ...(phase ? { phase } : {}),
    ...(source ? { source } : {}),
    ...(Number.isFinite(limit) ? { limit } : {}),
  }))
}
