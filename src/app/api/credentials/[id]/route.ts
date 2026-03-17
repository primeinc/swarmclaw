import { NextResponse } from 'next/server'
import { loadCredentials, deleteCredential } from '@/lib/server/storage'
import { notFound } from '@/lib/server/collection-helpers'
import { log } from '@/lib/server/logger'

const TAG = 'api-credentials'

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: credId } = await params
  const creds = loadCredentials()
  if (!creds[credId]) {
    return notFound()
  }
  deleteCredential(credId)
  log.info(TAG, `deleted ${credId}`)
  return new NextResponse('OK')
}
