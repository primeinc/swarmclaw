import { NextResponse } from 'next/server'
import { notFound } from '@/lib/server/collection-helpers'
import { loadMissionById, performMissionAction } from '@/lib/server/missions/mission-service'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const mission = loadMissionById(id)
  if (!mission) return notFound()

  const body = await req.json().catch(() => ({}))
  const action = body?.action
  if (action !== 'resume' && action !== 'replan' && action !== 'cancel' && action !== 'retry_verification' && action !== 'wait') {
    return NextResponse.json({ error: 'Invalid mission action.' }, { status: 400 })
  }

  const result = performMissionAction({
    missionId: id,
    action,
    reason: typeof body.reason === 'string' ? body.reason : null,
    waitKind: typeof body.waitKind === 'string' ? body.waitKind : undefined,
    untilAt: typeof body.untilAt === 'number' ? body.untilAt : null,
  })
  if (!result) {
    return NextResponse.json({ error: 'Unable to update mission.' }, { status: 409 })
  }
  return NextResponse.json({
    ok: true,
    mission: result.mission,
    appendedEvent: result.event,
  })
}
