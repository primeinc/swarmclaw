import { NextResponse } from 'next/server'
import { notFound } from '@/lib/server/collection-helpers'
import { getMissionDetail } from '@/lib/server/missions/mission-service'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const mission = getMissionDetail(id)
  if (!mission) return notFound()
  return NextResponse.json(mission)
}
