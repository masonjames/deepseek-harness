/** Built Web readiness while an optional MCP's real stdio negotiation is held at a barrier. */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import { webGet } from './default-web-process.ts'

const repo = fileURLToPath(new URL('../../../../../../', import.meta.url))

it.for([false, true])('serves Web before MCP negotiation finishes and cleans up (release: %s)', async (release, test) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-background-mcp-'))
  test.onTestFinished(() => rm(root, { recursive: true, force: true }))
  const events = join(root, 'events.jsonl')
  const barrier = join(root, 'release')
  const patch = join(root, 'mcp.patch.yml')
  await writeFile(events, '')
  const observations = async (): Promise<{ event: string; pid: number }[]> => (await readFile(events, 'utf8'))
    .split('\n').filter(Boolean).map(line => JSON.parse(line) as { event: string; pid: number })
  await writeFile(patch, JSON.stringify([{ insert: [
    { id: 'background-mcp', name: '@deepseek-ai/dsh-mcp-client', config: {
      serverName: 'delayed', transport: 'stdio', startupMode: 'background', command: process.execPath,
      args: [join(repo, 'packages/mcp/mcp-client/tests/fixtures/negotiation-lifecycle.mjs'), events, barrier],
    } },
    { id: 'background-observer', name: new URL('./fixtures/background-mcp-observer.mjs', import.meta.url).href },
  ] }]))
  const launch = resolveExampleLaunch({
    srcBin: join(repo, 'apps/cli/src/bin.ts'), mode: 'lib',
    configArgs: ['web', '--patch', patch, '--host', '127.0.0.1', '--port', '0', '--no-open'],
    env: { DSH_HOME: join(root, 'home'), DSH_AGENTS_HOME: join(root, 'agents'),
      DSH_TELEMETRY_DISABLED: '1', DEEPSEEK_API_KEY: 'keyless-no-model-calls',
      NODE_OPTIONS: undefined, NODE_PATH: undefined, TSX_TSCONFIG_PATH: undefined },
  })
  const child = spawn(launch.command, launch.args, {
    cwd: root, env: { ...process.env, ...launch.env }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  let output = ''
  let exited = false
  let forced = false
  let spawnError: Error | undefined
  child.on('error', (error) => { spawnError = error })
  for (const stream of [child.stdout, child.stderr]) stream!.on('data', (data) => { output += String(data) })
  const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('close', (code, signal) => { exited = true; resolve({ code, signal }) })
  })
  let closing: Promise<Awaited<typeof completion>> | undefined
  const stop = (): Promise<Awaited<typeof completion>> => closing ??= (async () => {
    const watchdog = setTimeout(() => { if (!exited) { forced = true; child.kill('SIGKILL') } }, 10_000)
    try {
      if (!exited && child.connected) child.send('stop', () => {})
      return await completion
    } finally { clearTimeout(watchdog) }
  })()
  test.onTestFinished(async () => { await stop() })
  const abort = (): void => { void stop() }
  test.signal.addEventListener('abort', abort, { once: true })
  const tools = async (): Promise<string[]> => {
    const response = once(child, 'message', { signal: test.signal })
    child.send('tools')
    return (await response)[0] as string[]
  }
  try {
    // Readiness must precede the SDK's 60-second negotiation timeout.
    await expect.poll(() => {
      if (exited) throw new Error(output.replace(/token=[^\s)]+/g, 'token=[REDACTED]'))
      return /dsh web: (http:\/\/[^\s]+)/.exec(output)?.[1]
    }, { timeout: 30_000 }).toBeDefined()
    await expect.poll(async () => (await observations()).some(row => row.event === 'server/discover')).toBe(true)
    expect((await observations()).some(row => row.event === 'initialize')).toBe(false)
    expect(await tools()).not.toContain('mcp__delayed__ping')
    const url = /dsh web: (http:\/\/[^\s]+)/.exec(output)![1]!
    const auth = await webGet(url, test.signal)
    const cookie = auth.headers['set-cookie']?.[0]?.split(';')[0]
    expect(cookie).toBeDefined()
    const page = await webGet(new URL('/', url), test.signal, { cookie: cookie! })
    expect(page.status).toBe(200)
    expect(page.text).toContain('__DSH_BOOT__')
    if (release) {
      await writeFile(barrier, '')
      await expect.poll(tools, { timeout: 15_000 }).toContain('mcp__delayed__ping')
    }
  } finally {
    const result = await stop()
    test.signal.removeEventListener('abort', abort)
    expect(spawnError).toBeUndefined()
    expect(test.signal.aborted).toBe(false)
    expect(forced).toBe(false)
    expect(result).toEqual({ code: 0, signal: null })
    for (const row of (await observations()).filter(row => row.event === 'start')) {
      expect(() => process.kill(row.pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
    }
  }
})
