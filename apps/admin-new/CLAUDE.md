# Ottaly Admin Dashboard v2

## What this is
Rebuilding the admin dashboard from Node.js/Express monolith into Next.js. This runs alongside the legacy Express app at `/apps/admin-legacy` — no cutover until feature parity.

## Key rules

### Database
- PostgreSQL at `ottaly_ottaly-postgres:5432` (Easypanel)
- Use `pg` client in `/apps/admin-legacy/db-postgres.js` as reference
- New endpoints must be type-safe: write migrations first, types after

### Pages to build (priority order)
1. Contacts + Lead Management
2. Campaign Management
3. Email Account Management
4. Clients & Workspaces
5. Domains
6. Health & Diagnostics
7. Finance & Reporting

### Don't touch
- `/apps/admin-legacy` — it's running in production. Bug fixes only.
- Database schema changes without approval
- The Express API — only add new routes if absolutely needed

### API Routes
- Live in `/apps/admin-new/app/api/`
- Call the existing Express API for data until rewritten
- Proxy pattern: Next.js routes → Express backend

### UI Components
- shadcn/ui + Tailwind CSS v4
- Organize in `/components/` by domain: `contacts/`, `campaigns/`, `workspaces/`
- Tables for large datasets, use shadcn/data-table addon

### Errors & Logging
- Sentry is wired. Agents can query it via MCP.
- All errors must be caught and sent to Sentry
- Include context: workspace_id, user_id, action being performed

### TypeScript
- Strict mode always
- No `any` types
- Database queries must be typed with `pg.QueryResult<T>`

### Testing
- Playwright tests in `e2e/` for critical flows
- Run before every PR: `npm test`
- Agent must screenshot the preview URL and verify visually

@AGENTS.md
