#!/usr/bin/env bun
import { resolve } from 'node:path'
import { CommerceError } from '../domain/errors.ts'
import { runCommerceSetup } from './setup-check.ts'

type CliOptions = {
  workspaceRoot?: string
  repoRoot: string
  bunPath: string
  mode: 'dry-run' | 'apply'
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    repoRoot: resolve(import.meta.dir, '../../../..'),
    bunPath: process.execPath,
    mode: 'apply',
  }
  for (let index = 0; index < args.length; index++) {
    const value = args[index]
    if (value === '--workspace' && args[index + 1]) options.workspaceRoot = resolve(args[++index]!)
    else if (value === '--repo' && args[index + 1]) options.repoRoot = resolve(args[++index]!)
    else if (value === '--bun' && args[index + 1]) options.bunPath = resolve(args[++index]!)
    else if (value === '--dry-run') options.mode = 'dry-run'
    else if (value === '--apply') options.mode = 'apply'
    else throw new CommerceError('INVALID_ARGUMENT', `Unknown or incomplete argument: ${value}`)
  }
  return options
}

export function usage(): string {
  return 'Usage: bun run commerce:setup --workspace <absolute-workspace-path> [--dry-run|--apply] [--repo <path>] [--bun <path>]'
}

if (import.meta.main) {
  try {
    const options = parseArgs(process.argv.slice(2))
    if (!options.workspaceRoot) throw new CommerceError('INVALID_ARGUMENT', `--workspace is required. ${usage()}`)
    const result = runCommerceSetup({
      workspaceRoot: options.workspaceRoot,
      repoRoot: options.repoRoot,
      bunPath: options.bunPath,
    }, options.mode)
    console.log(JSON.stringify(result, null, 2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
