/** Workspace discovery excludes deleted packages without hiding live build failures. */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { build, type InlineConfig } from 'tsdown'
import { expect, it, onTestFinished } from 'vitest'
import { buildWorkspaces } from './build-workspaces.ts'

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-build-workspaces-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  write(root, 'package.json', JSON.stringify({ name: '@fixture/root', type: 'module' }))
  return root
}

function write(root: string, path: string, content = ''): void {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), content)
}

function buildConfig(root: string): InlineConfig {
  return {
    cwd: root, config: false, tsconfig: false, workspace: buildWorkspaces(root, false),
    entry: ['lib/types/{index,invariant,startup}.js'], format: ['esm'],
    dts: false, clean: false, write: false, report: false, logLevel: 'silent',
  }
}

it.each([false, true])('preserves the application allowlist (client=%s)', (client) => {
  const root = fixture()
  const shared = ['vendor/live', 'packages/util/live', 'apps/cli']
  const desktop = ['apps/desktop', 'apps/desktop-host']
  for (const path of [...shared, ...desktop, 'apps/web', 'website', 'native/system']) {
    write(root, `${path}/package.json`, '{}')
  }
  write(root, 'packages/util/deleted/node_modules/.keep')
  write(root, 'vendor/deleted/lib/types/index.js')
  expect(buildWorkspaces(root, client)).toEqual([...shared, ...(client ? [] : desktop)].sort())
})

it('bundles a live package beside manifest-less dependency and output residue', async () => {
  const root = fixture()
  write(root, 'packages/util/live/package.json', JSON.stringify({ name: '@fixture/live', type: 'module' }))
  write(root, 'packages/util/live/lib/types/index.js', 'export const marker = "live-workspace"\n')
  write(root, 'packages/util/deleted/node_modules/.keep')
  write(root, 'packages/util/renamed/lib/types/index.js', 'export const marker = "stale-workspace"\n')
  const bundles = await build(buildConfig(root))
  try {
    const code = bundles.flatMap(bundle => bundle.chunks)
      .flatMap(chunk => chunk.type === 'chunk' ? [chunk.code] : []).join('\n')
    expect(code).toContain('live-workspace')
    expect(code).not.toContain('stale-workspace')
    expect(existsSync(join(root, 'packages/util/deleted/node_modules/.keep'))).toBe(true)
  } finally {
    for (const bundle of bundles) await bundle[Symbol.asyncDispose]()
  }
})

it('still rejects a live package whose emitted entry is missing', async () => {
  const root = fixture()
  write(root, 'packages/util/live/package.json', JSON.stringify({ name: '@fixture/live', type: 'module' }))
  await expect(build(buildConfig(root))).rejects.toThrow('Cannot find entry')
})
