/**
 * Chatroom Memory Bridge
 *
 * Persists chatroom interactions into the agent memory system so agents
 * can recall cross-context conversations (chatroom ↔ direct chat).
 */
import type { Agent } from '@/types'
import { log } from '@/lib/server/logger'

const TAG = 'chatroom-memory-bridge'

/** Truncate text to a max length, collapsing whitespace */
function truncate(text: string, max: number): string {
  const compact = String(text || '').replace(/\s+/g, ' ').trim()
  if (compact.length <= max) return compact
  return `${compact.slice(0, Math.max(0, max - 3))}...`
}

/**
 * Persist a structured memory entry after a meaningful chatroom turn.
 * Called after an agent responds in a chatroom (regular or protocol transcript).
 */
export async function persistChatroomInteractionMemory(params: {
  agentId: string
  agent: Agent | null
  chatroomId: string
  chatroomName: string
  senderName: string
  inboundText: string
  responseText: string
}): Promise<void> {
  const { agentId, chatroomId, chatroomName, senderName, inboundText, responseText } = params

  // Gate: skip empty, error-only, or system messages
  if (!responseText.trim()) return
  if (!inboundText.trim()) return
  if (senderName === 'System' || senderName === 'system') return

  try {
    const { getMemoryDb } = await import('@/lib/server/memory/memory-db')
    const memDb = getMemoryDb()
    const content = [
      `[Chatroom: "${truncate(chatroomName, 60)}"] ${truncate(senderName, 40)} said: "${truncate(inboundText, 300)}"`,
      `I responded: "${truncate(responseText, 400)}"`,
    ].join('\n')

    memDb.add({
      agentId,
      sessionId: null,
      category: 'interaction',
      title: `Chatroom interaction in "${truncate(chatroomName, 60)}"`,
      content,
      metadata: { chatroomId, source: 'chatroom' },
      pinned: false,
      sharedWith: undefined,
      references: undefined,
      filePaths: undefined,
      image: undefined,
      imagePath: undefined,
      linkedMemoryIds: undefined,
    })
  } catch (err: unknown) {
    // Non-critical — log and continue
    log.warn(TAG, 'Failed to persist interaction memory:', err instanceof Error ? err.message : String(err))
  }
}

/**
 * Summarize and consolidate raw chatroom interaction memories for a given chatroom.
 * Called during compaction when messages exceed the threshold.
 */
export async function summarizeAndConsolidateChatroomMemories(params: {
  chatroomId: string
  chatroomName: string
  agentId: string
  agent: Agent | null
}): Promise<void> {
  const { chatroomId, chatroomName, agentId } = params

  try {
    const { getMemoryDb } = await import('@/lib/server/memory/memory-db')
    const memDb = getMemoryDb()

    // Find all raw interaction memories for this chatroom+agent
    const results = memDb.search(`chatroom "${chatroomName}"`, agentId).slice(0, 50)
    const chatroomMemories = results.filter(
      (m) => m.category === 'interaction' && (m.metadata as Record<string, unknown>)?.chatroomId === chatroomId,
    )

    if (chatroomMemories.length < 5) return // Not enough to summarize

    // Build a summary from the raw memories
    const interactions = chatroomMemories
      .slice(0, 30) // Cap to avoid token overflow
      .map((m) => truncate(m.content, 200))
      .join('\n')

    try {
      const { buildLLM } = await import('@/lib/server/build-llm')
      const { HumanMessage } = await import('@langchain/core/messages')
      const { llm } = await buildLLM({ sessionId: null, agentId })
      const prompt = [
        `Summarize these chatroom interactions into a concise memory paragraph (3-5 sentences).`,
        `Focus on key topics discussed, decisions made, and important information exchanged.`,
        `Chatroom: "${chatroomName}"`,
        '',
        interactions,
      ].join('\n')

      const response = await llm.invoke([new HumanMessage(prompt)])
      const summary = String(response.content || '').trim()
      if (!summary) return

      // Write consolidated summary memory
      memDb.add({
        agentId,
        sessionId: null,
        category: 'interaction',
        title: `Summary of interactions in "${truncate(chatroomName, 60)}"`,
        content: summary,
        metadata: { chatroomId, source: 'chatroom_summary' },
        pinned: false,
        sharedWith: undefined,
        references: undefined,
        filePaths: undefined,
        image: undefined,
        imagePath: undefined,
        linkedMemoryIds: undefined,
      })
    } catch (llmErr: unknown) {
      // LLM summarization is best-effort
      log.warn(TAG, 'LLM summarization failed:', llmErr instanceof Error ? llmErr.message : String(llmErr))
    }
  } catch (err: unknown) {
    log.warn(TAG, 'Failed to consolidate memories:', err instanceof Error ? err.message : String(err))
  }
}
