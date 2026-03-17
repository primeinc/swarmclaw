import { describe, it, expect } from 'vitest'
import { stripInternalJson, stripLoopDetectionMessages, stripAllInternalMetadata } from './strip-internal-metadata'

// ---------------------------------------------------------------------------
// stripInternalJson
// ---------------------------------------------------------------------------

describe('stripInternalJson', () => {
  it('removes single-line classification JSON', () => {
    const input = '{ "isDeliverableTask": true, "quality_score": 0.8, "isBroadGoal": false }'
    expect(stripInternalJson(input).trim()).toBe('')
  })

  it('removes classification JSON embedded in surrounding text', () => {
    const input = 'Here is the answer.\n{ "isDeliverableTask": true, "confidence": 0.9 }\nMore text follows.'
    const result = stripInternalJson(input)
    expect(result).toContain('Here is the answer.')
    expect(result).toContain('More text follows.')
    expect(result).not.toContain('isDeliverableTask')
  })

  it('preserves legitimate JSON that does not contain internal keys', () => {
    const input = 'The config is { "name": "test", "port": 3000 }'
    expect(stripInternalJson(input)).toBe(input)
  })

  it('preserves JSON with nested objects if no internal keys', () => {
    const input = '{ "user": { "name": "alice" } }'
    expect(stripInternalJson(input)).toBe(input)
  })

  it('removes JSON with nested objects when internal keys are present', () => {
    const input = '{ "walletIntent": "send", "details": { "amount": 100 } }'
    expect(stripInternalJson(input).trim()).toBe('')
  })

  it('handles multiple JSON blocks, only removing internal ones', () => {
    const input = '{ "isDeliverableTask": true } some text { "foo": "bar" }'
    const result = stripInternalJson(input)
    expect(result).not.toContain('isDeliverableTask')
    expect(result).toContain('{ "foo": "bar" }')
  })
})

// ---------------------------------------------------------------------------
// stripLoopDetectionMessages
// ---------------------------------------------------------------------------

describe('stripLoopDetectionMessages', () => {
  it('strips tool frequency "called N times" messages', () => {
    const input = 'Tool "shell" called 30 times this turn. Excessive repetition — wrap up with available results.'
    expect(stripLoopDetectionMessages(input).trim()).toBe('')
  })

  it('strips tool frequency "would be called" messages', () => {
    const input = 'Tool "shell" would be called 31 times this turn. Excessive repetition — wrap up with available results.'
    expect(stripLoopDetectionMessages(input).trim()).toBe('')
  })

  it('strips "nearing overuse" messages', () => {
    const input = 'Tool "read" is nearing overuse (15 calls this turn). Consider whether another call is needed.'
    expect(stripLoopDetectionMessages(input).trim()).toBe('')
  })

  it('strips generic repeat "You called" messages', () => {
    const input = 'You called "browser" 6 times with identical input. Input: "{"action":"screenshot"}" — State your blocker or deliver what you have.'
    expect(stripLoopDetectionMessages(input).trim()).toBe('')
  })

  it('strips generic repeat "You called" warning messages', () => {
    const input = 'You called "search" 4 times with identical input. Input: "query" — Try a fundamentally different approach or deliver partial results.'
    expect(stripLoopDetectionMessages(input).trim()).toBe('')
  })

  it('strips "would repeat the same input" messages', () => {
    const input = '"search" would repeat the same input 12 times. Input: "query" — State your blocker or deliver what you have.'
    expect(stripLoopDetectionMessages(input).trim()).toBe('')
  })

  it('strips "is about to repeat the same input" messages', () => {
    const input = '"search" is about to repeat the same input 6 times. Input: "query" — Try a different approach.'
    expect(stripLoopDetectionMessages(input).trim()).toBe('')
  })

  it('strips circuit breaker messages', () => {
    const input = 'Circuit breaker: "shell" called 20 times with identical input. Halting to prevent runaway.'
    expect(stripLoopDetectionMessages(input).trim()).toBe('')
  })

  it('strips circuit breaker preview messages', () => {
    const input = 'Circuit breaker: "shell" would be called 20 times with identical input. Halting before another runaway call.'
    expect(stripLoopDetectionMessages(input).trim()).toBe('')
  })

  it('strips polling stall messages', () => {
    const input = 'Polling stall: "status_check" returned identical output 8 times consecutively. The polled resource is not changing.'
    expect(stripLoopDetectionMessages(input).trim()).toBe('')
  })

  it('strips ping-pong "are alternating" messages', () => {
    const input = 'Ping-pong: "read" and "write" are alternating with identical results (5 cycles). Breaking the loop.'
    expect(stripLoopDetectionMessages(input).trim()).toBe('')
  })

  it('strips ping-pong "may be stuck" messages', () => {
    const input = 'Ping-pong: "read" and "write" may be stuck in an alternating loop (3 cycles).'
    expect(stripLoopDetectionMessages(input).trim()).toBe('')
  })

  it('strips output stagnation messages', () => {
    const input = 'Output stagnation: last 8 tool calls all produced identical output. The approach is not working — try something fundamentally different or report the blocker.'
    expect(stripLoopDetectionMessages(input).trim()).toBe('')
  })

  it('strips output stagnation warning messages', () => {
    const input = 'Output stagnation: 6 of the last 8 tool calls produced identical output. Your tools may not be making progress.'
    expect(stripLoopDetectionMessages(input).trim()).toBe('')
  })

  it('strips error convergence messages', () => {
    const input = 'Error convergence: 5 of the last 6 tool calls returned errors. Stop retrying and report the underlying issue (likely an infrastructure or configuration problem).'
    expect(stripLoopDetectionMessages(input).trim()).toBe('')
  })

  it('strips error convergence warning messages', () => {
    const input = 'Error convergence: 4 of the last 6 tool calls returned errors. You may be hitting a systemic issue — consider a different approach or report the blocker.'
    expect(stripLoopDetectionMessages(input).trim()).toBe('')
  })

  it('strips messages wrapped in [Error: ...] brackets', () => {
    const input = '[Error: You called "browser" 6 times with identical input. Input: "{"action":"screenshot"}" — State your blocker or deliver what you have.]'
    expect(stripLoopDetectionMessages(input).trim()).toBe('')
  })

  it('strips [Error: ...] wrapped tool frequency messages', () => {
    const input = '[Error: Tool "shell" called 30 times this turn. Excessive repetition — wrap up with available results.]'
    expect(stripLoopDetectionMessages(input).trim()).toBe('')
  })

  it('strips [Error: ...] wrapped output stagnation messages', () => {
    const input = '[Error: Output stagnation: last 8 tool calls all produced identical output.]'
    expect(stripLoopDetectionMessages(input).trim()).toBe('')
  })

  it('preserves normal text that mentions tools', () => {
    const input = 'I used the shell tool to run the command.'
    expect(stripLoopDetectionMessages(input)).toBe(input)
  })

  it('strips loop message embedded in surrounding text', () => {
    const input = 'Working on it.\nTool "shell" called 30 times this turn. Excessive repetition — wrap up with available results.\nHere are the results.'
    const result = stripLoopDetectionMessages(input)
    expect(result).toContain('Working on it.')
    expect(result).toContain('Here are the results.')
    expect(result).not.toContain('called 30 times')
  })
})

// ---------------------------------------------------------------------------
// stripAllInternalMetadata (combined)
// ---------------------------------------------------------------------------

describe('stripAllInternalMetadata', () => {
  it('strips both classification JSON and loop detection in one pass', () => {
    const input = [
      '{ "isDeliverableTask": true, "confidence": 0.8 }',
      'Here is my analysis.',
      'Tool "shell" called 30 times this turn. Excessive repetition — wrap up with available results.',
      'The answer is 42.',
    ].join('\n')
    const result = stripAllInternalMetadata(input)
    expect(result).not.toContain('isDeliverableTask')
    expect(result).not.toContain('called 30 times')
    expect(result).toContain('Here is my analysis.')
    expect(result).toContain('The answer is 42.')
  })

  it('collapses excessive newlines after stripping', () => {
    const input = 'Hello.\n\n\n\n{ "isDeliverableTask": true }\n\n\n\nWorld.'
    const result = stripAllInternalMetadata(input)
    expect(result).not.toMatch(/\n{3,}/)
  })

  it('returns empty string for purely internal content', () => {
    const input = '{ "isDeliverableTask": true, "quality_score": 0.9 }'
    expect(stripAllInternalMetadata(input)).toBe('')
  })

  it('leaves normal messages untouched', () => {
    const input = 'Here is a normal response with no internal metadata.'
    expect(stripAllInternalMetadata(input)).toBe(input)
  })

  it('preserves code blocks with JSON that happen to have similar-looking keys', () => {
    // JSON in code blocks uses real braces, so the regex will match the block.
    // But since 'name' and 'age' are not internal keys, it should be preserved.
    const input = 'Result: { "name": "Alice", "age": 30 }'
    expect(stripAllInternalMetadata(input)).toBe(input)
  })
})
