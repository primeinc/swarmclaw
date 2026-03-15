import { HumanMessage } from '@langchain/core/messages'
import { z } from 'zod'
import type {
  Message,
  MessageToolEvent,
  Mission,
  MissionPhase,
  MissionSummary,
  MissionWaitKind,
  Session,
  SessionQueuedTurn,
  SessionRunRecord,
} from '@/types'
import { buildLLM } from '@/lib/server/build-llm'

const MissionTurnDecisionSchema = z.object({
  action: z.enum(['none', 'attach_current', 'create_new']),
  confidence: z.number().min(0).max(1).optional(),
  objective: z.string().optional().nullable(),
  successCriteria: z.array(z.string()).optional(),
  currentStep: z.string().optional().nullable(),
  plannerSummary: z.string().optional().nullable(),
})

const MissionOutcomeSchema = z.object({
  verdict: z.enum(['continue', 'waiting', 'completed', 'failed', 'replan']),
  confidence: z.number().min(0).max(1).optional(),
  phase: z.enum(['planning', 'executing', 'verifying', 'waiting', 'completed', 'failed']).optional(),
  currentStep: z.string().optional().nullable(),
  verifierSummary: z.string().optional().nullable(),
  waitKind: z.enum(['human_reply', 'approval', 'external_dependency', 'provider', 'blocked_task', 'blocked_mission', 'scheduled', 'other']).optional(),
  waitReason: z.string().optional().nullable(),
})

const MissionPlannerSchema = z.object({
  decision: z.enum(['dispatch_task', 'dispatch_session_turn', 'spawn_child_mission', 'wait', 'verify_now', 'complete_candidate', 'replan', 'fail_terminal']),
  confidence: z.number().min(0).max(1).optional(),
  summary: z.string().optional().nullable(),
  currentStep: z.string().optional().nullable(),
  waitKind: z.enum(['human_reply', 'approval', 'external_dependency', 'provider', 'blocked_task', 'blocked_mission', 'scheduled', 'other']).optional(),
  waitReason: z.string().optional().nullable(),
  taskId: z.string().optional().nullable(),
  sessionMessage: z.string().optional().nullable(),
  childObjective: z.string().optional().nullable(),
  childSuccessCriteria: z.array(z.string()).optional(),
  childCurrentStep: z.string().optional().nullable(),
  childPlannerSummary: z.string().optional().nullable(),
})

export type MissionTurnDecision =
  | { action: 'none'; confidence: number }
  | {
      action: 'attach_current'
      confidence: number
      currentStep?: string
      plannerSummary?: string
    }
  | {
      action: 'create_new'
      confidence: number
      objective: string
      successCriteria: string[]
      currentStep?: string
      plannerSummary?: string
    }

export type MissionOutcomeDecision = {
  verdict: 'continue' | 'waiting' | 'completed' | 'failed' | 'replan'
  confidence: number
  phase?: MissionPhase
  currentStep?: string
  verifierSummary?: string
  waitKind?: MissionWaitKind
  waitReason?: string
}

export type MissionPlannerDecisionResult =
  | {
      decision: 'dispatch_task'
      confidence: number
      summary?: string
      currentStep?: string
      taskId: string
    }
  | {
      decision: 'dispatch_session_turn'
      confidence: number
      summary?: string
      currentStep?: string
      sessionMessage: string
    }
  | {
      decision: 'spawn_child_mission'
      confidence: number
      summary?: string
      currentStep?: string
      childObjective: string
      childSuccessCriteria: string[]
      childCurrentStep?: string
      childPlannerSummary?: string
    }
  | {
      decision: 'wait'
      confidence: number
      summary?: string
      currentStep?: string
      waitKind?: MissionWaitKind
      waitReason?: string
    }
  | {
      decision: 'verify_now' | 'complete_candidate' | 'replan' | 'fail_terminal'
      confidence: number
      summary?: string
      currentStep?: string
    }

export interface MissionTurnClassifierInput {
  sessionId: string
  agentId?: string | null
  message: string
  recentMessages?: Message[]
  currentMission?: MissionSummary | Mission | null
  session?: Session | null
}

export interface MissionOutcomeClassifierInput {
  sessionId: string
  agentId?: string | null
  userMessage: string
  assistantText?: string | null
  error?: string | null
  toolEvents?: MessageToolEvent[]
  currentMission: MissionSummary | Mission
  linkedTaskSummaries?: Array<{
    id: string
    title: string
    status: string
    result?: string | null
    error?: string | null
  }>
}

export interface MissionPlannerInput {
  sessionId: string
  agentId?: string | null
  mission: MissionSummary | Mission
  linkedTaskSummaries?: Array<{
    id: string
    title: string
    status: string
    result?: string | null
    error?: string | null
  }>
  childMissionSummaries?: MissionSummary[]
  recentRuns?: Array<Pick<SessionRunRecord, 'id' | 'status' | 'source' | 'queuedAt' | 'messagePreview' | 'resultPreview' | 'error'>>
  queuedTurns?: Array<Pick<SessionQueuedTurn, 'runId' | 'text' | 'queuedAt' | 'source'>>
  recentEvents?: Array<{
    type: string
    summary: string
    createdAt: number
  }>
}

function normalizeText(value: unknown, max = 400): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : ''
}

function normalizeLines(values: unknown, maxItems: number, maxChars = 160): string[] {
  const source = Array.isArray(values) ? values : []
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of source) {
    const normalized = normalizeText(value, maxChars)
    if (!normalized) continue
    const key = normalized.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(normalized)
    if (out.length >= maxItems) break
  }
  return out
}

function extractModelText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') ? part.text : '')
    .join('')
}

function extractFirstJsonObject(text: string): string | null {
  const source = normalizeText(text, 12_000)
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
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
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

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

export function parseMissionTurnDecision(text: string): MissionTurnDecision | null {
  const jsonText = extractFirstJsonObject(text)
  if (!jsonText) return null
  const jsonValue = parseJsonObject(jsonText)
  if (!jsonValue) return null
  const parsed = MissionTurnDecisionSchema.safeParse(jsonValue)
  if (!parsed.success) return null
  const confidence = typeof parsed.data.confidence === 'number' ? parsed.data.confidence : 0
  if (parsed.data.action === 'none') return { action: 'none', confidence }
  if (parsed.data.action === 'attach_current') {
    return {
      action: 'attach_current',
      confidence,
      ...(normalizeText(parsed.data.currentStep, 200) ? { currentStep: normalizeText(parsed.data.currentStep, 200) } : {}),
      ...(normalizeText(parsed.data.plannerSummary, 320) ? { plannerSummary: normalizeText(parsed.data.plannerSummary, 320) } : {}),
    }
  }
  const objective = normalizeText(parsed.data.objective, 300)
  if (!objective) return null
  return {
    action: 'create_new',
    confidence,
    objective,
    successCriteria: normalizeLines(parsed.data.successCriteria, 6, 180),
    ...(normalizeText(parsed.data.currentStep, 200) ? { currentStep: normalizeText(parsed.data.currentStep, 200) } : {}),
    ...(normalizeText(parsed.data.plannerSummary, 320) ? { plannerSummary: normalizeText(parsed.data.plannerSummary, 320) } : {}),
  }
}

export function parseMissionOutcomeDecision(text: string): MissionOutcomeDecision | null {
  const jsonText = extractFirstJsonObject(text)
  if (!jsonText) return null
  const jsonValue = parseJsonObject(jsonText)
  if (!jsonValue) return null
  const parsed = MissionOutcomeSchema.safeParse(jsonValue)
  if (!parsed.success) return null
  return {
    verdict: parsed.data.verdict,
    confidence: typeof parsed.data.confidence === 'number' ? parsed.data.confidence : 0,
    ...(parsed.data.phase ? { phase: parsed.data.phase } : {}),
    ...(normalizeText(parsed.data.currentStep, 200) ? { currentStep: normalizeText(parsed.data.currentStep, 200) } : {}),
    ...(normalizeText(parsed.data.verifierSummary, 360) ? { verifierSummary: normalizeText(parsed.data.verifierSummary, 360) } : {}),
    ...(parsed.data.waitKind ? { waitKind: parsed.data.waitKind } : {}),
    ...(normalizeText(parsed.data.waitReason, 240) ? { waitReason: normalizeText(parsed.data.waitReason, 240) } : {}),
  }
}

export function parseMissionPlannerDecision(text: string): MissionPlannerDecisionResult | null {
  const jsonText = extractFirstJsonObject(text)
  if (!jsonText) return null
  const jsonValue = parseJsonObject(jsonText)
  if (!jsonValue) return null
  const parsed = MissionPlannerSchema.safeParse(jsonValue)
  if (!parsed.success) return null
  const confidence = typeof parsed.data.confidence === 'number' ? parsed.data.confidence : 0
  const summary = normalizeText(parsed.data.summary, 360) || undefined
  const currentStep = normalizeText(parsed.data.currentStep, 200) || undefined

  if (parsed.data.decision === 'dispatch_task') {
    const taskId = normalizeText(parsed.data.taskId, 64)
    if (!taskId) return null
    return {
      decision: 'dispatch_task',
      confidence,
      ...(summary ? { summary } : {}),
      ...(currentStep ? { currentStep } : {}),
      taskId,
    }
  }

  if (parsed.data.decision === 'dispatch_session_turn') {
    const sessionMessage = normalizeText(parsed.data.sessionMessage, 1600)
    if (!sessionMessage) return null
    return {
      decision: 'dispatch_session_turn',
      confidence,
      ...(summary ? { summary } : {}),
      ...(currentStep ? { currentStep } : {}),
      sessionMessage,
    }
  }

  if (parsed.data.decision === 'spawn_child_mission') {
    const childObjective = normalizeText(parsed.data.childObjective, 300)
    if (!childObjective) return null
    return {
      decision: 'spawn_child_mission',
      confidence,
      ...(summary ? { summary } : {}),
      ...(currentStep ? { currentStep } : {}),
      childObjective,
      childSuccessCriteria: normalizeLines(parsed.data.childSuccessCriteria, 6, 180),
      ...(normalizeText(parsed.data.childCurrentStep, 200) ? { childCurrentStep: normalizeText(parsed.data.childCurrentStep, 200) } : {}),
      ...(normalizeText(parsed.data.childPlannerSummary, 320) ? { childPlannerSummary: normalizeText(parsed.data.childPlannerSummary, 320) } : {}),
    }
  }

  if (parsed.data.decision === 'wait') {
    return {
      decision: 'wait',
      confidence,
      ...(summary ? { summary } : {}),
      ...(currentStep ? { currentStep } : {}),
      ...(parsed.data.waitKind ? { waitKind: parsed.data.waitKind } : {}),
      ...(normalizeText(parsed.data.waitReason, 240) ? { waitReason: normalizeText(parsed.data.waitReason, 240) } : {}),
    }
  }

  return {
    decision: parsed.data.decision,
    confidence,
    ...(summary ? { summary } : {}),
    ...(currentStep ? { currentStep } : {}),
  }
}

function buildRecentMessageContext(messages: Message[] | undefined): string {
  if (!Array.isArray(messages) || messages.length === 0) return '(none)'
  return messages.slice(-6).map((message) => {
    const role = message.role === 'assistant' ? 'assistant' : 'user'
    return `- ${role}: ${JSON.stringify(normalizeText(message.text, 220) || '(empty)')}`
  }).join('\n')
}

function summarizeMission(mission: MissionSummary | Mission | null | undefined): string {
  if (!mission) return '(none)'
  const rawSuccessCriteria = 'successCriteria' in mission ? mission.successCriteria : undefined
  const successCriteria = Array.isArray(rawSuccessCriteria) && rawSuccessCriteria.length > 0
    ? rawSuccessCriteria.join(' | ')
    : '(none)'
  return [
    `objective=${JSON.stringify(normalizeText(mission.objective, 260) || '(none)')}`,
    `status=${mission.status}`,
    `phase=${mission.phase}`,
    `current_step=${JSON.stringify(normalizeText(mission.currentStep, 160) || '(none)')}`,
    `success_criteria=${JSON.stringify(successCriteria)}`,
  ].join('\n')
}

function summarizeToolEvents(toolEvents: MessageToolEvent[] | undefined): string {
  if (!Array.isArray(toolEvents) || toolEvents.length === 0) return '(none)'
  return toolEvents.slice(0, 8).map((event) => JSON.stringify({
    name: normalizeText(event.name, 120) || 'unknown',
    input: normalizeText(event.input, 160) || null,
    output: normalizeText(event.output, 220) || null,
    error: event.error === true,
  })).join('\n')
}

function summarizeLinkedTasks(input: MissionOutcomeClassifierInput['linkedTaskSummaries']): string {
  if (!Array.isArray(input) || input.length === 0) return '(none)'
  return input.slice(0, 8).map((task) => JSON.stringify({
    id: task.id,
    title: normalizeText(task.title, 160),
    status: task.status,
    result: normalizeText(task.result, 180) || null,
    error: normalizeText(task.error, 180) || null,
  })).join('\n')
}

function summarizeChildMissions(children: MissionSummary[] | undefined): string {
  if (!Array.isArray(children) || children.length === 0) return '(none)'
  return children.slice(0, 8).map((child) => JSON.stringify({
    id: child.id,
    objective: normalizeText(child.objective, 180),
    status: child.status,
    phase: child.phase,
    currentStep: normalizeText(child.currentStep, 140) || null,
    waitingReason: normalizeText(child.waitingReason, 160) || null,
  })).join('\n')
}

function summarizeRecentRuns(runs: MissionPlannerInput['recentRuns']): string {
  if (!Array.isArray(runs) || runs.length === 0) return '(none)'
  return runs.slice(0, 6).map((run) => JSON.stringify({
    id: run.id,
    status: run.status,
    source: run.source,
    queuedAt: run.queuedAt,
    messagePreview: normalizeText(run.messagePreview, 180) || null,
    resultPreview: normalizeText(run.resultPreview, 180) || null,
    error: normalizeText(run.error, 160) || null,
  })).join('\n')
}

function summarizeQueuedTurns(turns: MissionPlannerInput['queuedTurns']): string {
  if (!Array.isArray(turns) || turns.length === 0) return '(none)'
  return turns.slice(0, 6).map((turn) => JSON.stringify({
    runId: turn.runId,
    source: turn.source || 'chat',
    queuedAt: turn.queuedAt,
    text: normalizeText(turn.text, 220) || '(empty)',
  })).join('\n')
}

function summarizeRecentEvents(events: MissionPlannerInput['recentEvents']): string {
  if (!Array.isArray(events) || events.length === 0) return '(none)'
  return events.slice(-8).map((event) => JSON.stringify({
    type: event.type,
    summary: normalizeText(event.summary, 220),
    createdAt: event.createdAt,
  })).join('\n')
}

function buildMissionPlannerPrompt(input: MissionPlannerInput): string {
  const verification = 'verificationState' in input.mission ? input.mission.verificationState : undefined
  return [
    'Decide the next durable mission-controller action.',
    'Return JSON only.',
    '',
    'Controller rules:',
    '- Choose exactly one decision.',
    '- Use "dispatch_task" only when there is a specific linked backlog task to queue now. You must provide taskId.',
    '- Use "dispatch_session_turn" when the next durable step should run as one mission-linked follow-up turn in the existing session. Provide sessionMessage.',
    '- Use "spawn_child_mission" only when the work should split into a durable child objective with its own lifecycle.',
    '- Use "wait" only for a real blocker, dependency, approval, human reply, provider outage, or scheduled resume. Provide waitKind and waitReason.',
    '- Use "verify_now" when the existing durable evidence is sufficient to verify completion without more execution.',
    '- Use "complete_candidate" only when the objective appears complete and should move into verification next.',
    '- Use "replan" when the mission should stay active but you do not want to dispatch work from this tick. Update currentStep or summary if helpful.',
    '- Use "fail_terminal" only for a genuine terminal failure that should stop the mission.',
    '- Do not mark work complete based on promises, planning prose, or partial progress.',
    '',
    'Output shape:',
    '{"decision":"dispatch_task|dispatch_session_turn|spawn_child_mission|wait|verify_now|complete_candidate|replan|fail_terminal","confidence":0-1,"summary":"optional","currentStep":"optional","taskId":"required for dispatch_task","sessionMessage":"required for dispatch_session_turn","waitKind":"required for wait","waitReason":"required for wait","childObjective":"required for spawn_child_mission","childSuccessCriteria":["optional"],"childCurrentStep":"optional","childPlannerSummary":"optional"}',
    '',
    `mission:\n${summarizeMission(input.mission)}`,
    verification ? `verification:\n${JSON.stringify({
      candidate: verification.candidate === true,
      requiredTaskIds: verification.requiredTaskIds || [],
      requiredChildMissionIds: verification.requiredChildMissionIds || [],
      requiredArtifacts: verification.requiredArtifacts || [],
      evidenceSummary: normalizeText(verification.evidenceSummary, 220) || null,
      lastVerdict: verification.lastVerdict || null,
    })}` : 'verification:\n(none)',
    `linked_tasks:\n${summarizeLinkedTasks(input.linkedTaskSummaries)}`,
    `child_missions:\n${summarizeChildMissions(input.childMissionSummaries)}`,
    `recent_runs:\n${summarizeRecentRuns(input.recentRuns)}`,
    `queued_turns:\n${summarizeQueuedTurns(input.queuedTurns)}`,
    `recent_events:\n${summarizeRecentEvents(input.recentEvents)}`,
  ].join('\n')
}

function buildMissionTurnPrompt(input: MissionTurnClassifierInput): string {
  return [
    'Classify whether the latest user turn should use durable mission tracking.',
    'Return JSON only.',
    '',
    'Mission policy:',
    '- Choose "create_new" only when the request is clearly multi-step, durable, resumable, deliverable-oriented, or likely to require follow-up action.',
    '- A small request that can be fully satisfied in the current turn should usually stay ordinary chat, even if it writes a file, produces an artifact, or could have future follow-up.',
    '- Do not create a mission just because the user might say more later. Unspecified future instructions alone are not durable mission state.',
    '- Choose "attach_current" when the new user turn is a continuation, refinement, correction, or next step for the current mission.',
    '- Choose "none" for one-shot questions, casual chat, simple factual replies, or turns that should not create durable execution state.',
    '- Be conservative. If the turn is not clearly mission-worthy, return {"action":"none","confidence":0}.',
    '- For "create_new", provide a concise durable objective, up to 6 success criteria, and an optional currentStep/plannerSummary.',
    '- For "attach_current", optionally provide a better currentStep/plannerSummary if the new turn changes the immediate next step.',
    '- Never rely on literal wording like "continue" alone. Decide from intent and context.',
    '',
    'Output shape:',
    '{"action":"none|attach_current|create_new","confidence":0-1,"objective":"for create_new","successCriteria":["optional"],"currentStep":"optional","plannerSummary":"optional"}',
    '',
    `current_mission:\n${summarizeMission(input.currentMission)}`,
    `recent_messages:\n${buildRecentMessageContext(input.recentMessages)}`,
    `latest_user_message: ${JSON.stringify(normalizeText(input.message, 500) || '(empty)')}`,
  ].join('\n')
}

function buildMissionOutcomePrompt(input: MissionOutcomeClassifierInput): string {
  return [
    'Evaluate the latest mission-scoped run outcome and decide the durable mission state.',
    'Return JSON only.',
    '',
    'Rules:',
    '- Choose "completed" only when the mission objective is actually satisfied by the latest work or the linked tasks are clearly complete.',
    '- Choose "waiting" when progress is blocked on a real external dependency, approval, human reply, provider outage, blocked task, or scheduled future action.',
    '- Choose "replan" when the mission should remain active but the next controller step needs to change before more work is dispatched.',
    '- Choose "failed" only for a real terminal failure that should stop the mission instead of waiting or continuing.',
    '- Choose "continue" for incomplete but still actionable work.',
    '- Be conservative about completion. Planning, partial edits, vague promises, or "I will" language are not completion.',
    '- Use the linked task summaries and tool results as stronger evidence than conversational tone.',
    '- Provide a short verifierSummary and an optional currentStep.',
    '',
    'Output shape:',
    '{"verdict":"continue|waiting|completed|failed|replan","confidence":0-1,"phase":"planning|executing|verifying|waiting|completed|failed","currentStep":"optional","verifierSummary":"optional","waitKind":"human_reply|approval|external_dependency|provider|blocked_task|blocked_mission|scheduled|other","waitReason":"optional"}',
    '',
    `mission:\n${summarizeMission(input.currentMission)}`,
    `linked_tasks:\n${summarizeLinkedTasks(input.linkedTaskSummaries)}`,
    `user_message: ${JSON.stringify(normalizeText(input.userMessage, 500) || '(empty)')}`,
    `assistant_text: ${JSON.stringify(normalizeText(input.assistantText, 1200) || '(none)')}`,
    `assistant_error: ${JSON.stringify(normalizeText(input.error, 320) || '(none)')}`,
    `tool_events:\n${summarizeToolEvents(input.toolEvents)}`,
  ].join('\n')
}

async function generateClassifierText(sessionId: string, agentId: string | null | undefined, prompt: string): Promise<string> {
  const { llm } = await buildLLM({
    sessionId,
    agentId: agentId || null,
  })
  const response = await llm.invoke([new HumanMessage(prompt)])
  return extractModelText(response.content)
}

export async function classifyMissionTurn(
  input: MissionTurnClassifierInput,
  options?: { generateText?: (prompt: string) => Promise<string> },
): Promise<MissionTurnDecision | null> {
  const prompt = buildMissionTurnPrompt(input)
  const responseText = options?.generateText
    ? await options.generateText(prompt)
    : await generateClassifierText(input.sessionId, input.agentId, prompt)
  return parseMissionTurnDecision(responseText)
}

export async function verifyMissionOutcome(
  input: MissionOutcomeClassifierInput,
  options?: { generateText?: (prompt: string) => Promise<string> },
): Promise<MissionOutcomeDecision | null> {
  const prompt = buildMissionOutcomePrompt(input)
  const responseText = options?.generateText
    ? await options.generateText(prompt)
    : await generateClassifierText(input.sessionId, input.agentId, prompt)
  return parseMissionOutcomeDecision(responseText)
}

export async function planMissionTick(
  input: MissionPlannerInput,
  options?: { generateText?: (prompt: string) => Promise<string> },
): Promise<MissionPlannerDecisionResult | null> {
  const prompt = buildMissionPlannerPrompt(input)
  const responseText = options?.generateText
    ? await options.generateText(prompt)
    : await generateClassifierText(input.sessionId, input.agentId, prompt)
  return parseMissionPlannerDecision(responseText)
}
