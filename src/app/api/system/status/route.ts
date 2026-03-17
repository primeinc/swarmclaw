import { NextResponse } from 'next/server'
import { getDaemonHealthSummary } from '@/lib/server/runtime/daemon-state'
import packageJson from '../../../../../package.json'

export async function GET() {
  const summary = getDaemonHealthSummary()
  return NextResponse.json({
    ...summary,
    version: packageJson.version,
  })
}
