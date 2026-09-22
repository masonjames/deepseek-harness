/** Manifest-based workspace discovery for the Host and Client tsdown passes. */
import { globSync } from 'node:fs'
import { dirname, sep } from 'node:path'

/**
 * Select live packages without admitting residue from deleted workspaces.
 * @param root - repository root used to resolve manifest globs.
 * @param client - whether to omit the Host-only desktop applications.
 * @returns sorted repository-relative package directories with POSIX separators.
 */
export function buildWorkspaces(root: string, client: boolean): string[] {
  const packages = ['vendor/*', 'packages/*/*', 'apps/cli']
  if (!client) packages.push('apps/desktop', 'apps/desktop-host')
  return globSync(packages.map(path => `${path}/package.json`), { cwd: root })
    .map(path => dirname(path).split(sep).join('/')).sort()
}
