import { NextResponse } from 'next/server'
import { listDelegationJobs } from '@/lib/server/agents/delegation-jobs'

export const dynamic = 'force-dynamic'

const RECENT_WINDOW_MS = 30_000

export async function GET() {
  const cutoff = Date.now() - RECENT_WINDOW_MS
  const jobs = listDelegationJobs().filter((job) => {
    // Active jobs always included
    if (job.status === 'queued' || job.status === 'running') return true
    // Recently-completed jobs (within window)
    if (job.completedAt && job.completedAt >= cutoff) return true
    if (job.updatedAt >= cutoff) return true
    return false
  })
  return NextResponse.json(jobs)
}
