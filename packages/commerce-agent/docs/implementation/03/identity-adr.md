# Identity ADR: OIDC and server-side business authorization

Status: accepted for 03 CODE_READY.

The commerce API uses OIDC Authorization Code with PKCE for authentication and an opaque, server-side session for browser requests. `jose` verifies signature, issuer, audience, expiration and nonce against JWKS. State is one-time and PKCE binds the token exchange. Cookies are `HttpOnly`, `Secure`, `SameSite=Strict` and `Path=/`; writes also require an allowlisted `Origin` and session-bound CSRF token.

OIDC claims do not grant tenant, shop or role access. The stable external `sub` is mapped to `commerce_memberships` and `commerce_shop_grants`. Session resolution re-reads membership version and active grants, so a role or membership change invalidates the old session. Raw session and CSRF secrets are never persisted.

The API is an independent Bun handler under `src/api/`. This avoids treating the host application's bearer token as commerce authorization. Host mounting may be added later without changing the principal contract.

Local signed IdP tests verify the full authorize/token/JWKS path. A real enterprise IdP and JWKS rotation remain an external acceptance gate.
