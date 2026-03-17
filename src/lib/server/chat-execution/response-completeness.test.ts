import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  parseCompletenessResponse,
  evaluateResponseCompleteness,
} from '@/lib/server/chat-execution/response-completeness'

describe('response-completeness', () => {
  describe('parseCompletenessResponse', () => {
    it('parses a valid incomplete response', () => {
      const result = parseCompletenessResponse('{"isIncomplete": true, "confidence": 0.95}')
      assert.deepEqual(result, { isIncomplete: true, confidence: 0.95 })
    })

    it('parses a valid complete response', () => {
      const result = parseCompletenessResponse('{"isIncomplete": false, "confidence": 0.8}')
      assert.deepEqual(result, { isIncomplete: false, confidence: 0.8 })
    })

    it('extracts JSON from surrounding text', () => {
      const result = parseCompletenessResponse('Here is the result: {"isIncomplete": true, "confidence": 0.9} done.')
      assert.deepEqual(result, { isIncomplete: true, confidence: 0.9 })
    })

    it('returns null for invalid JSON', () => {
      assert.equal(parseCompletenessResponse('not json'), null)
    })

    it('returns null for missing fields', () => {
      assert.equal(parseCompletenessResponse('{"isIncomplete": true}'), null)
    })

    it('returns null for out-of-range confidence', () => {
      assert.equal(parseCompletenessResponse('{"isIncomplete": true, "confidence": 1.5}'), null)
    })
  })

  describe('evaluateResponseCompleteness', () => {
    it('detects incomplete response ending with colon', async () => {
      const result = await evaluateResponseCompleteness(
        {
          sessionId: 'test-session',
          agentId: 'test-agent',
          message: 'Deploy the app',
          response: "I'll run the deployment:",
          toolCallCount: 0,
        },
        {
          generateText: async () => '{"isIncomplete": true, "confidence": 0.95}',
        },
      )
      assert.deepEqual(result, { isIncomplete: true, confidence: 0.95 })
    })

    it('detects complete response with URL after colon', async () => {
      const result = await evaluateResponseCompleteness(
        {
          sessionId: 'test-session',
          agentId: 'test-agent',
          message: 'What is the URL?',
          response: "Here's the URL: https://example.com",
          toolCallCount: 0,
        },
        {
          generateText: async () => '{"isIncomplete": false, "confidence": 0.9}',
        },
      )
      assert.deepEqual(result, { isIncomplete: false, confidence: 0.9 })
    })

    it('returns null on timeout', async () => {
      const result = await evaluateResponseCompleteness(
        {
          sessionId: 'test-session',
          agentId: 'test-agent',
          message: 'Deploy',
          response: "I'll deploy:",
          toolCallCount: 0,
        },
        {
          generateText: () => new Promise((resolve) => setTimeout(() => resolve('{"isIncomplete": true, "confidence": 0.9}'), 5000)),
        },
      )
      assert.equal(result, null)
    })

    it('returns null for empty response', async () => {
      const result = await evaluateResponseCompleteness(
        {
          sessionId: 'test-session',
          agentId: 'test-agent',
          message: 'Deploy',
          response: '',
          toolCallCount: 0,
        },
        {
          generateText: async () => '{"isIncomplete": true, "confidence": 0.9}',
        },
      )
      assert.equal(result, null)
    })

    it('caches results for identical inputs', async () => {
      let callCount = 0
      const generateText = async () => {
        callCount++
        return '{"isIncomplete": true, "confidence": 0.85}'
      }

      const input = {
        sessionId: 'test-session',
        agentId: 'test-agent',
        message: 'Run tests',
        response: "I'll run the test suite:",
        toolCallCount: 0,
      }

      await evaluateResponseCompleteness(input, { generateText })
      await evaluateResponseCompleteness(input, { generateText })
      assert.equal(callCount, 1)
    })
  })
})
