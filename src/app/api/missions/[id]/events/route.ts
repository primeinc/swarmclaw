import { NextResponse } from 'next/server'
import { notFound } from '@/lib/server/collection-helpers'
import { listMissionEventsForMission, loadMissionById } from '@/lib/server/missions/mission-service'

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const mission = loadMissionById(id)
  if (!mission) return notFound()

  const { searchParams } = new URL(req.url)
  const limitParam = searchParams.get('limit')
  const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined
  return NextResponse.json(listMissionEventsForMission(id, Number.isFinite(limit) ? limit : undefined))
}
