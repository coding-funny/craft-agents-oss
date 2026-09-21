import type { AuthenticatedPrincipal } from '../auth/contracts.ts'

export async function withPostgresSecurityContext<T>(
  sql: Bun.SQL,
  principal: AuthenticatedPrincipal,
  work: (scoped: Bun.SQL) => Promise<T>,
): Promise<T> {
  return sql.transaction(async scoped => {
    await scoped`SELECT set_config('app.tenant_id', ${principal.tenantId}, true)`
    await scoped`SELECT set_config('app.subject', ${principal.subject}, true)`
    await scoped`SELECT set_config('app.actor_id', ${principal.actorId}, true)`
    await scoped`SELECT set_config('app.shop_ids', ${principal.allowedShopIds.join(',')}, true)`
    return work(scoped)
  })
}
