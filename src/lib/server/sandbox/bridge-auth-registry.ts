type BridgeAuth = {
  token?: string
  password?: string
}

const AUTH_BY_PORT_MAX = 200
const authByPort = new Map<number, BridgeAuth>()

export function setBridgeAuthForPort(port: number, auth: BridgeAuth): void {
  if (!Number.isFinite(port) || port <= 0) return
  // FIFO eviction at cap
  if (!authByPort.has(port) && authByPort.size >= AUTH_BY_PORT_MAX) {
    const firstKey = authByPort.keys().next().value
    if (firstKey !== undefined) authByPort.delete(firstKey)
  }
  const token = typeof auth.token === 'string' ? auth.token.trim() : ''
  const password = typeof auth.password === 'string' ? auth.password.trim() : ''
  authByPort.set(port, {
    token: token || undefined,
    password: password || undefined,
  })
}

export function getBridgeAuthForPort(port: number): BridgeAuth | undefined {
  if (!Number.isFinite(port) || port <= 0) return undefined
  return authByPort.get(port)
}

export function deleteBridgeAuthForPort(port: number): void {
  if (!Number.isFinite(port) || port <= 0) return
  authByPort.delete(port)
}
