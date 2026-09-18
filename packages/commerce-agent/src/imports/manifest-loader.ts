import { isAbsolute, relative, resolve, sep } from 'node:path'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { ImportManifestSchema, type ImportFileSchema, type ImportManifest } from '../data/contracts.ts'
import { sha256 } from '../data/hash.ts'
import { CommerceError } from '../domain/errors.ts'
import type { z } from 'zod'

export type LoadedImportFile = z.infer<typeof ImportFileSchema> & {
  absolutePath: string
  bytes: Uint8Array
}

export type LoadedImportManifest = {
  manifest: ImportManifest
  manifestPath: string
  manifestHash: string
  files: LoadedImportFile[]
}

function invalid(message: string, details?: Record<string, unknown>): never {
  throw new CommerceError('INVALID_ARGUMENT', message, details)
}

function denied(message: string, details?: Record<string, unknown>): never {
  throw new CommerceError('SCOPE_DENIED', message, details)
}

export async function loadImportManifest(manifestPath: string): Promise<LoadedImportManifest> {
  const absoluteManifestPath = resolve(manifestPath)
  let manifestBytes: Uint8Array
  let parsedJson: unknown
  try {
    manifestBytes = await readFile(absoluteManifestPath)
    parsedJson = JSON.parse(new TextDecoder().decode(manifestBytes))
  } catch (error) {
    invalid('Import manifest is unreadable or invalid JSON', {
      cause: error instanceof Error ? error.message : String(error),
    })
  }
  const parsedManifest = ImportManifestSchema.safeParse(parsedJson)
  if (!parsedManifest.success) {
    if (parsedManifest.error.issues.some(issue => issue.path.join('.') === 'source.authorizationRef')) {
      denied('Import source authorization declaration is invalid')
    }
    throw parsedManifest.error
  }
  const manifest = parsedManifest.data
  const manifestDirectory = await realpath(resolve(absoluteManifestPath, '..'))
  const files: LoadedImportFile[] = []

  for (const file of manifest.files) {
    if (isAbsolute(file.path)) denied('Import file paths must be relative to the manifest')
    const candidate = resolve(manifestDirectory, file.path)
    const relativePath = relative(manifestDirectory, candidate)
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
      denied('Import file path escapes the manifest directory', { path: file.path })
    }
    const stat = await lstat(candidate).catch(() => undefined)
    if (stat?.isSymbolicLink()) denied('Import file must not be a symbolic link', { path: file.path })
    if (!stat?.isFile()) {
      invalid('Import file must be a regular non-symlink file', { path: file.path })
    }
    const absolutePath = await realpath(candidate)
    const realRelative = relative(manifestDirectory, absolutePath)
    if (realRelative === '..' || realRelative.startsWith(`..${sep}`)) {
      denied('Import file resolves outside the manifest directory', { path: file.path })
    }
    const bytes = await readFile(absolutePath)
    const actualDigest = sha256(bytes)
    if (actualDigest !== file.sha256) {
      denied('Import file digest does not match the manifest', {
        path: file.path,
        expected: file.sha256,
        actual: actualDigest,
      })
    }
    files.push({ ...file, absolutePath, bytes })
  }

  return {
    manifest,
    manifestPath: absoluteManifestPath,
    manifestHash: sha256(manifestBytes),
    files,
  }
}
