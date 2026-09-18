import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { CommerceError } from '../domain/errors.ts'
import { buildCommerceSourceFiles, type SourceTemplateOptions } from './source-template.ts'

export type SetupAction = {
  path: string
  action: 'create' | 'unchanged'
}

export type SetupResult = {
  mode: 'dry-run' | 'apply'
  workspaceRoot: string
  sourceSlug: 'commerce'
  actions: SetupAction[]
  transport: 'stdio'
}

function requireAbsolute(path: string, label: string): void {
  if (!isAbsolute(path)) throw new CommerceError('INVALID_ARGUMENT', `${label} must be an absolute path: ${path}`)
}

export function validateSetupInputs(options: SourceTemplateOptions): void {
  requireAbsolute(options.workspaceRoot, 'workspaceRoot')
  requireAbsolute(options.repoRoot, 'repoRoot')
  requireAbsolute(options.bunPath, 'bunPath')

  const required = [
    options.bunPath,
    resolve(options.repoRoot, 'packages/commerce-agent/src/mcp/server.ts'),
    resolve(options.repoRoot, 'packages/commerce-agent/fixtures/sales.json'),
    resolve(options.repoRoot, 'packages/commerce-agent/fixtures/inventory.json'),
    resolve(options.repoRoot, 'packages/commerce-agent/fixtures/promotions.json'),
    resolve(options.repoRoot, 'packages/commerce-agent/fixtures/ads.json'),
    resolve(options.repoRoot, 'packages/commerce-agent/fixtures/products.json'),
    resolve(options.repoRoot, 'packages/commerce-agent/fixtures/mock-platform-state.json'),
  ]
  const missing = required.filter(path => !existsSync(path))
  if (missing.length > 0) {
    throw new CommerceError('NOT_FOUND', 'Commerce setup prerequisites are missing', { missing })
  }
}

export function planCommerceSetup(options: SourceTemplateOptions): SetupAction[] {
  validateSetupInputs(options)
  const files = buildCommerceSourceFiles(options)
  return Object.entries(files).map(([relativePath, content]) => {
    const destination = resolve(options.workspaceRoot, relativePath)
    if (!existsSync(destination)) return { path: destination, action: 'create' as const }
    if (readFileSync(destination, 'utf8') === content) return { path: destination, action: 'unchanged' as const }
    throw new CommerceError('INVALID_ARGUMENT', `Refusing to overwrite existing source file: ${destination}`)
  })
}

export function runCommerceSetup(
  options: SourceTemplateOptions,
  mode: 'dry-run' | 'apply',
): SetupResult {
  const files = buildCommerceSourceFiles(options)
  const actions = planCommerceSetup(options)
  if (mode === 'apply') {
    for (const action of actions) {
      if (action.action === 'unchanged') continue
      const relativePath = Object.keys(files).find(candidate => resolve(options.workspaceRoot, candidate) === action.path)
      if (!relativePath) throw new CommerceError('INTERNAL', `No template content for ${action.path}`)
      mkdirSync(dirname(action.path), { recursive: true })
      const temporary = `${action.path}.commerce-setup.tmp`
      writeFileSync(temporary, files[relativePath]!, { encoding: 'utf8', flag: 'wx' })
      renameSync(temporary, action.path)
    }
  }
  return {
    mode,
    workspaceRoot: options.workspaceRoot,
    sourceSlug: 'commerce',
    actions,
    transport: 'stdio',
  }
}
