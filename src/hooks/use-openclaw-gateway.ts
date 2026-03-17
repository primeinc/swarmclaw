'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/app/api-client'
import { errorMessage } from '@/lib/shared-utils'
import { useWs } from './use-ws'

/** Call an OpenClaw gateway RPC method via the proxy route. */
export function useOpenClawRpc<T = unknown>(method: string | null, params?: unknown) {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(!!method)
  const [error, setError] = useState<string | null>(null)
  const paramsRef = useRef(params)
  useEffect(() => { paramsRef.current = params })

  // doFetch only uses async callbacks for setState (no synchronous setState)
  const doFetch = useCallback(() => {
    if (!method) return
    api<{ ok: boolean; result: T; error?: string }>('POST', '/openclaw/gateway', {
      method,
      params: paramsRef.current,
    })
      .then((res) => {
        if (res.error) {
          setError(res.error)
        } else {
          setData(res.result)
        }
      })
      .catch((err: unknown) => {
        setError(errorMessage(err))
      })
      .finally(() => {
        setLoading(false)
      })
  }, [method])

  // Reset loading/error when method changes (render-time state adjustment)
  const [prevMethod, setPrevMethod] = useState(method)
  if (method !== prevMethod) {
    setPrevMethod(method)
    if (method) {
      setLoading(true)
      setError(null)
    } else {
      setLoading(false)
      setError(null)
      setData(null)
    }
  }

  useEffect(() => { doFetch() }, [doFetch])

  // refetch wraps doFetch with loading/error reset (called from event handlers)
  const refetch = useCallback(() => {
    setLoading(true)
    setError(null)
    doFetch()
  }, [doFetch])

  return { data, loading, error, refetch }
}

/** Subscribe to an OpenClaw event topic via the WS hub. */
export function useOpenClawEvent(topic: string, handler: () => void) {
  useWs(`openclaw:${topic}`, handler)
}

/** Check gateway connection status. */
export function useOpenClawConnected() {
  const [connected, setConnected] = useState(false)

  const check = useCallback(() => {
    api<{ connected: boolean }>('GET', '/openclaw/gateway')
      .then((res) => setConnected(res.connected))
      .catch(() => setConnected(false))
  }, [])

  useEffect(() => { check() }, [check])
  useWs('openclaw:agents', check)

  return connected
}
