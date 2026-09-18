import { CraftMcpClient } from '@craft-agent/shared/mcp'
import { fileURLToPath } from 'node:url'
import type { McpToolClient } from '../agent/tool-dispatcher.ts'

export type ScopedCommerceClientOptions = {
  shopId: string
  reportDir: string
  dbPath: string
  traceFile?: string
} & (
  | { dataMode?: 'fixture'; fixtureDir: string }
  | { dataMode: 'imported'; tenantId: string; snapshotId: string }
)

/**
 * Starts the commerce MCP server with an explicit environment allowlist.
 * Provider credentials and the parent process environment are never inherited.
 */
export function createScopedCommerceClient(options: ScopedCommerceClientOptions): McpToolClient {
  const serverPath = fileURLToPath(new URL('./server.ts', import.meta.url))
  const client = new CraftMcpClient({
    transport: 'stdio',
    command: process.execPath,
    args: ['run', serverPath],
    inheritEnv: false,
    env: {
      COMMERCE_MODE: 'readonly',
      COMMERCE_DATA_MODE: options.dataMode ?? 'fixture',
      ...(options.dataMode !== 'imported'
        ? { COMMERCE_FIXTURE_DIR: options.fixtureDir }
        : { COMMERCE_TENANT_ID: options.tenantId, COMMERCE_SNAPSHOT_ID: options.snapshotId }),
      COMMERCE_SHOP_ID: options.shopId,
      COMMERCE_REPORT_DIR: options.reportDir,
      COMMERCE_DB_PATH: options.dbPath,
      ...(options.traceFile ? { COMMERCE_TRACE_FILE: options.traceFile } : {}),
    },
  })
  return client
}
