/**
 * Generates concise abstracts (~100 tokens) for memory entries.
 * Inspired by OpenViking's L0/L1/L2 tiered context representations.
 *
 * Used in proactive recall to inject summaries instead of truncated raw content,
 * reducing token waste and preserving semantic meaning.
 */
import { HumanMessage } from '@langchain/core/messages'

const ABSTRACT_TIMEOUT_MS = 15_000

/**
 * Generate a short abstract (~100 tokens) summarizing memory content.
 * Falls back to a truncated prefix if LLM generation fails or is unavailable.
 */
export async function generateAbstract(content: string, title?: string): Promise<string | null> {
  if (!content || content.length <= 200) return null

  try {
    const { buildLLM } = await import('@/lib/server/build-llm')
    const { llm } = await buildLLM()

    const prompt = [
      'Summarize the following memory entry in 1-2 concise sentences (max ~100 tokens).',
      'Preserve the key facts, decisions, or conclusions. Do not add commentary.',
      title ? `Title: ${title}` : '',
      `Content: ${content.slice(0, 2000)}`,
    ].filter(Boolean).join('\n')

    const response = await Promise.race([
      llm.invoke([new HumanMessage(prompt)]),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('abstract-timeout')), ABSTRACT_TIMEOUT_MS),
      ),
    ])

    const text = extractText(response.content)
    return text || fallbackAbstract(content)
  } catch {
    return fallbackAbstract(content)
  }
}

function fallbackAbstract(content: string): string {
  return content.slice(0, 150) + (content.length > 150 ? '...' : '')
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === 'string') return part.trim()
      if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
        return part.text.trim()
      }
    }
  }
  return ''
}
