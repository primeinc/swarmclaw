import { NextResponse } from 'next/server'
import { loadStoredItem, upsertStoredItem, active } from '@/lib/server/storage'
import { notFound } from '@/lib/server/collection-helpers'
import { materializeStreamingAssistantArtifacts } from '@/lib/chat/chat-streaming-state'
import { appendSessionNote } from '@/lib/server/session-note'
import { getSessionRunState } from '@/lib/server/runtime/session-run-manager'
import type { Message, Session } from '@/types'
import { safeParseBody } from '@/lib/server/safe-parse-body'

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = loadStoredItem('sessions', id) as Session | null
  if (!session) return notFound()
  session.messages = Array.isArray(session.messages) ? session.messages : []

  // Check both persisted fields AND in-memory runtime state.
  // The persisted session doesn't have active/currentRunId set during runs —
  // those are only computed at runtime from the active map and run ledger.
  const sessionClaimsActive = session.active === true
    || (typeof session.currentRunId === 'string' && session.currentRunId.trim().length > 0)
    || active.has(id)
    || !!getSessionRunState(id).runningRunId
  if (!sessionClaimsActive && materializeStreamingAssistantArtifacts(session.messages)) {
    upsertStoredItem('sessions', id, session)
  }

  const url = new URL(req.url)
  const limitParam = url.searchParams.get('limit')
  const beforeParam = url.searchParams.get('before')

  const allMessages = Array.isArray(session.messages) ? session.messages : []
  const total = allMessages.length

  // If no limit param, return all messages (backward compatible)
  if (!limitParam) {
    return NextResponse.json(allMessages)
  }

  const limit = Math.max(1, Math.min(500, parseInt(limitParam) || 100))
  const before = beforeParam !== null ? parseInt(beforeParam) : total

  // Return `limit` messages ending just before `before` index
  const start = Math.max(0, before - limit)
  const end = Math.max(0, before)
  const messages = allMessages.slice(start, end)

  return NextResponse.json({
    messages,
    total,
    hasMore: start > 0,
    startIndex: start,
  })
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { data: body, error } = await safeParseBody<{
    kind?: string
    role?: Message['role']
    text?: string
    messageKind?: Message['kind']
  }>(req)
  if (error) return error

  if (body.kind === 'context-clear') {
    const session = loadStoredItem('sessions', id) as Session | null
    if (!session) return notFound()

    session.messages.push({
      role: 'user',
      text: '',
      kind: 'context-clear',
      time: Date.now(),
    })
    upsertStoredItem('sessions', id, session)
    return NextResponse.json({ ok: true })
  }

  if (body.kind === 'note') {
    const inserted = appendSessionNote({
      sessionId: id,
      text: body.text || '',
      role: body.role || 'assistant',
      kind: body.messageKind || 'system',
    })
    if (!inserted) {
      const session = loadStoredItem('sessions', id) as Session | null
      if (!session) return notFound()
      return NextResponse.json({ error: 'Note text is required' }, { status: 400 })
    }
    return NextResponse.json(inserted)
  }

  return NextResponse.json({ error: 'Only context-clear and note kinds are supported' }, { status: 400 })
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { data: body, error } = await safeParseBody<{ messageIndex: number; bookmarked: boolean }>(req)
  if (error) return error
  const session = loadStoredItem('sessions', id) as Session | null
  if (!session) return notFound()

  const { messageIndex, bookmarked } = body
  if (typeof messageIndex !== 'number' || messageIndex < 0 || messageIndex >= session.messages.length) {
    return NextResponse.json({ error: 'Invalid message index' }, { status: 400 })
  }

  session.messages[messageIndex].bookmarked = bookmarked
  upsertStoredItem('sessions', id, session)
  return NextResponse.json(session.messages[messageIndex])
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { data: body, error } = await safeParseBody<{ messageIndex: number }>(req)
  if (error) return error
  const session = loadStoredItem('sessions', id) as Session | null
  if (!session) return notFound()

  const { messageIndex } = body
  if (typeof messageIndex !== 'number' || messageIndex < 0 || messageIndex >= session.messages.length) {
    return NextResponse.json({ error: 'Invalid message index' }, { status: 400 })
  }

  // Only allow deleting context-clear markers (safety guard)
  if (session.messages[messageIndex].kind !== 'context-clear') {
    return NextResponse.json({ error: 'Only context-clear markers can be removed' }, { status: 400 })
  }

  session.messages.splice(messageIndex, 1)
  upsertStoredItem('sessions', id, session)
  return NextResponse.json({ ok: true })
}
