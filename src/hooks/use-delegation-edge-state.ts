'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useWs } from './use-ws'
import { api } from '@/lib/app/api-client'
import type { Agent, DelegationJobRecord } from '@/types'

export interface EdgeLiveState {
  active: boolean
  direction: 'down' | 'up'
  snippet: string | null
  color: 'indigo' | 'emerald' | 'red'
}

function truncate(s: string | null | undefined, max: number): string | null {
  if (!s) return null
  return s.length > max ? s.slice(0, max) + '...' : s
}

/**
 * Subscribes to delegation job changes and derives per-edge live state
 * for animating org chart edges during active delegation.
 */
export function useDelegationEdgeState(agents: Record<string, Agent>): Map<string, EdgeLiveState> {
  const [edgeMap, setEdgeMap] = useState<Map<string, EdgeLiveState>>(() => new Map())
  const fadeTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const refresh = useCallback(async () => {
    let jobs: DelegationJobRecord[]
    try {
      jobs = await api<DelegationJobRecord[]>('GET', '/delegation-jobs')
    } catch {
      return
    }
    if (!jobs || jobs.length === 0) {
      setEdgeMap((prev) => prev.size === 0 ? prev : new Map())
      return
    }

    const next = new Map<string, EdgeLiveState>()

    for (const job of jobs) {
      const childId = job.agentId
      if (!childId) continue
      const child = agents[childId]
      if (!child) continue
      const parentId = child.orgChart?.parentId
      if (!parentId || !agents[parentId]) continue

      const edgeKey = `${parentId}-${childId}`
      const status = job.status

      let direction: 'down' | 'up' = 'down'
      let snippet: string | null = null
      let color: 'indigo' | 'emerald' | 'red' = 'indigo'

      switch (status) {
        case 'queued':
        case 'running':
          direction = 'down'
          snippet = truncate(job.task, 100)
          color = 'indigo'
          break
        case 'completed':
          direction = 'up'
          snippet = truncate(job.resultPreview, 100)
          color = 'emerald'
          break
        case 'failed':
        case 'cancelled':
          direction = 'up'
          snippet = status
          color = 'red'
          break
      }

      next.set(edgeKey, { active: true, direction, snippet, color })
    }

    setEdgeMap((prev) => {
      // Schedule fade timers for terminal jobs
      for (const [key, state] of next) {
        if (state.color === 'emerald' || state.color === 'red') {
          if (!fadeTimers.current.has(key)) {
            fadeTimers.current.set(key, setTimeout(() => {
              fadeTimers.current.delete(key)
              setEdgeMap((current) => {
                const updated = new Map(current)
                updated.delete(key)
                return updated
              })
            }, 4000))
          }
        }
      }

      // Merge: keep existing fade entries that aren't in next
      const merged = new Map(next)
      for (const [key, state] of prev) {
        if (!merged.has(key) && fadeTimers.current.has(key)) {
          merged.set(key, state)
        }
      }
      return merged
    })
  }, [agents])

  useWs('delegation_jobs', refresh, 3000)

  // Initial fetch
  useEffect(() => {
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Cleanup timers on unmount
  useEffect(() => {
    const timers = fadeTimers.current
    return () => {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    }
  }, [])

  return edgeMap
}
