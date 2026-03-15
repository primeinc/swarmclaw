import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  parseMissionOutcomeDecision,
  parseMissionPlannerDecision,
  parseMissionTurnDecision,
} from '@/lib/server/missions/mission-intent'

describe('mission-intent parsing', () => {
  it('parses mission turn decisions from structured JSON output', () => {
    const decision = parseMissionTurnDecision([
      'Here is the result.',
      '{"action":"create_new","confidence":0.91,"objective":"Ship the release prep flow","successCriteria":["README updated","release verified"],"currentStep":"Audit the repo","plannerSummary":"Turn the release request into a tracked mission."}',
    ].join('\n'))

    assert.deepEqual(decision, {
      action: 'create_new',
      confidence: 0.91,
      objective: 'Ship the release prep flow',
      successCriteria: ['README updated', 'release verified'],
      currentStep: 'Audit the repo',
      plannerSummary: 'Turn the release request into a tracked mission.',
    })
  })

  it('returns null for malformed mission turn JSON instead of throwing', () => {
    assert.equal(parseMissionTurnDecision('{"action":"create_new",'), null)
    assert.equal(parseMissionTurnDecision('not json at all'), null)
  })

  it('parses mission outcome decisions from structured JSON output', () => {
    const decision = parseMissionOutcomeDecision([
      'done',
      '{"verdict":"waiting","confidence":0.72,"phase":"waiting","currentStep":"Wait for approval","verifierSummary":"The mission is blocked on a human approval.","waitKind":"approval","waitReason":"Resume approval still pending."}',
    ].join('\n'))

    assert.deepEqual(decision, {
      verdict: 'waiting',
      confidence: 0.72,
      phase: 'waiting',
      currentStep: 'Wait for approval',
      verifierSummary: 'The mission is blocked on a human approval.',
      waitKind: 'approval',
      waitReason: 'Resume approval still pending.',
    })
  })

  it('parses mission planner decisions from structured JSON output', () => {
    const decision = parseMissionPlannerDecision([
      'planner',
      '{"decision":"dispatch_session_turn","confidence":0.84,"summary":"Queue the next durable turn.","currentStep":"Summarize the release blockers","sessionMessage":"Continue the mission and summarize the remaining release blockers."}',
    ].join('\n'))

    assert.deepEqual(decision, {
      decision: 'dispatch_session_turn',
      confidence: 0.84,
      summary: 'Queue the next durable turn.',
      currentStep: 'Summarize the release blockers',
      sessionMessage: 'Continue the mission and summarize the remaining release blockers.',
    })
  })
})
