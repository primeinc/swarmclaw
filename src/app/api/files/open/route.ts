import { NextResponse } from 'next/server'
import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { safeParseBody } from '@/lib/server/safe-parse-body'
import { resolveWorkspacePath } from '@/lib/server/resolve-workspace-path'

export async function POST(req: Request) {
  const { data: body, error } = await safeParseBody<{ path?: string; cwd?: string }>(req)
  if (error) return error
  const { path: targetPath, cwd } = body
  if (!targetPath || typeof targetPath !== 'string') {
    return NextResponse.json({ error: 'path is required' }, { status: 400 })
  }

  const resolved = resolveWorkspacePath(targetPath, cwd)

  if (!resolved) {
    return NextResponse.json({ error: 'Path does not exist' }, { status: 404 })
  }

  const isDir = fs.statSync(resolved).isDirectory()
  const platform = process.platform

  let command: string
  let args: string[]
  if (platform === 'darwin') {
    command = 'open'
    args = isDir ? [resolved] : ['-R', resolved]
  } else if (platform === 'win32') {
    command = 'explorer'
    args = isDir ? [resolved] : [`/select,${resolved}`]
  } else {
    command = 'xdg-open'
    args = [isDir ? resolved : path.dirname(resolved)]
  }

  return new Promise<NextResponse>((resolve) => {
    const child = spawn(command, args, { stdio: 'ignore' })
    child.once('error', (err) => {
      resolve(NextResponse.json({ error: err.message }, { status: 500 }))
    })
    child.once('spawn', () => {
      child.unref()
      resolve(NextResponse.json({ ok: true }))
    })
  })
}
