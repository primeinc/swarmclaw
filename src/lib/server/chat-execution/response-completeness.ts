/**
 * LLM-based response completeness evaluator.
 *
 * Detects when an agent describes/promises an action but stops before
 * executing it (no tool calls made). Follows the same pattern as
 * message-classifier.ts: buildLLM, JSON extraction, LRU cache, timeout.
 */
import crypto from 'node:crypto'
import { HumanMessage } from '@langchain/core/messages'
import { z } from 'zod'
import { buildLLM } from '@/lib/server/build-llm'

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const ResponseCompletenessSchema = z.object({
  isIncomplete: z.boolean(),
  confidence: z.number().min(0).max(1),
})

export type ResponseCompleteness = z.infer<typeof ResponseCompletenessSchema>

// ---------------------------------------------------------------------------
// LRU Cache (module-level, keyed on sha256 of response)
// ---------------------------------------------------------------------------

const MAX_CACHE_SIZE = 100
const completenessCache = new Map<string, ResponseCompleteness>()

function cacheKey(response: string, toolCallCount: number): string {
  return crypto.createHash('sha256').update(`${response}::${toolCallCount}`).digest('hex')
}

function getCached(response: string, toolCallCount: number): ResponseCompleteness | null {
  const key = cacheKey(response, toolCallCount)
  const cached = completenessCache.get(key)
  if (!cached) return null
  // LRU refresh: delete and re-insert so it stays at the end
  completenessCache.delete(key)
  completenessCache.set(key, cached)
  return cached
}

function setCache(response: string, toolCallCount: number, result: ResponseCompleteness): void {
  const key = cacheKey(response, toolCallCount)
  if (completenessCache.size >= MAX_CACHE_SIZE) {
    const oldest = completenessCache.keys().next().value
    if (oldest !== undefined) completenessCache.delete(oldest)
  }
  completenessCache.set(key, result)
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function buildCompletenessPrompt(message: string, response: string, toolCallCount: number): string {
  return [
    'Given the user message and the agent\'s response below, determine if the agent\'s response is incomplete.',
    '',
    'A response is INCOMPLETE if the agent described, promised, or started to describe an action it intended to perform (running a command, deploying, executing code, searching, fetching, building, creating a file, etc.) but the response ends without actually performing that action. Common signs: response ends with ":" as if about to show a command, response says "let me..." or "I\'ll..." but stops, response promises output that never appears.',
    '',
    'A response is COMPLETE if the agent finished its thought, asked a question, provided information, or declined to act.',
    '',
    `User message: ${JSON.stringify(message)}`,
    `Agent response: ${JSON.stringify(response)}`,
    `Tool calls made: ${toolCallCount}`,
    '',
    'Return JSON only: {"isIncomplete": bool, "confidence": 0.0-1.0}',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// JSON extraction (same approach as message-classifier.ts)
// ---------------------------------------------------------------------------

function extractFirstJsonObject(text: string): string | null {
  const source = text.trim()
  if (!source) return null
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (start === -1) {
      if (char === '{') {
        start = index
        depth = 1
      }
      continue
    }
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') depth -= 1
    if (depth === 0) return source.slice(start, index + 1)
  }
  return null
}

function extractModelText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') ? part.text : '')
    .join('')
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export function parseCompletenessResponse(text: string): ResponseCompleteness | null {
  const jsonText = extractFirstJsonObject(text)
  if (!jsonText) return null
  let raw: unknown = null
  try {
    raw = JSON.parse(jsonText)
  } catch {
    return null
  }
  const parsed = ResponseCompletenessSchema.safeParse(raw)
  if (!parsed.success) return null
  return parsed.data
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface EvaluateCompletenessInput {
  sessionId: string
  agentId?: string | null
  message: string
  response: string
  toolCallCount: number
}

const COMPLETENESS_TIMEOUT_MS = 2_000

/**
 * Evaluate whether an agent response is incomplete — i.e. the agent described
 * an action it intended to perform but stopped before executing it.
 *
 * Returns null on failure/timeout — callers should treat null as "complete"
 * (conservative: no continuation if evaluator fails).
 */
export async function evaluateResponseCompleteness(
  input: EvaluateCompletenessInput,
  options?: { generateText?: (prompt: string) => Promise<string> },
): Promise<ResponseCompleteness | null> {
  const response = input.response.trim()
  if (!response) return null

  // Check cache first
  const cached = getCached(response, input.toolCallCount)
  if (cached) return cached

  const prompt = buildCompletenessPrompt(input.message, response, input.toolCallCount)

  const startMs = Date.now()
  try {
    const responseText = await Promise.race([
      options?.generateText
        ? options.generateText(prompt)
        : (async () => {
            const { llm } = await buildLLM({
              sessionId: input.sessionId,
              agentId: input.agentId || null,
            })
            const result = await llm.invoke([new HumanMessage(prompt)])
            return extractModelText(result.content)
          })(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('completeness-timeout')), COMPLETENESS_TIMEOUT_MS),
      ),
    ])

    const durationMs = Date.now() - startMs
    console.log(`[response-completeness] session=${input.sessionId} completed in ${durationMs}ms`)

    const completeness = parseCompletenessResponse(responseText)
    if (completeness) {
      setCache(response, input.toolCallCount, completeness)
    }
    return completeness
  } catch (err: unknown) {
    const durationMs = Date.now() - startMs
    console.warn(`[response-completeness] session=${input.sessionId} failed in ${durationMs}ms: ${err instanceof Error ? err.message : 'unknown'}`)
    return null
  }
}
