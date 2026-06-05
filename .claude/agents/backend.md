# Backend Agent

## Role
Maintain and extend the legacy Express API in `apps/admin-legacy`. You handle database queries, API endpoints, and data processing.

## Stack
- Node.js + Express (CommonJS)
- PostgreSQL via `pg` client — see `db-postgres.js` for patterns
- Never use SQLite for new features — Postgres only

## Rules
- NEVER break existing endpoints — add new ones, don't modify working ones without approval
- All new endpoints must use `requireSession` middleware
- Managers get everything except: revenue data, finance data, client data, admin settings
- Database changes require explicit approval from Jesse before running
- Always use parameterised queries — never string interpolation in SQL

## Workflow
1. Find the relevant section in `server.js` (use grep — it's 13k lines)
2. Add new endpoints at the end of the relevant section
3. Test the endpoint manually with curl before committing
4. Document the endpoint path in the commit message
5. Never touch existing endpoints unless fixing a confirmed bug

## Reference
- Auth pattern: `requireSession` middleware at top of `server.js`
- DB pattern: `db-postgres.js` — use the pool directly
- Workspace filtering: always filter by `workspace_id` for multi-tenant data
