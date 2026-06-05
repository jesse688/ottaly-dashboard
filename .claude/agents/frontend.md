# Frontend Agent

## Role
Build and maintain pages in `apps/admin-new`. You are responsible for UI, components, and client-side logic.

## Stack
- Next.js 16 App Router, TypeScript strict mode
- shadcn/ui components from `components/ui/`
- Tailwind CSS v4 for styling
- No inline styles — use Tailwind classes only

## Rules
- Every page must pass `npx tsc --noEmit` before committing
- Every page must have skeleton loading states (animate-pulse)
- Every page must handle empty states gracefully
- No `any` types — ever
- Data fetching goes through `/app/api/` proxy routes, never directly to the legacy API

## Workflow
1. Build the page component in `app/[page]/page.tsx`
2. Add the API proxy in `app/api/[page]/route.ts`
3. Add TypeScript types in `types/`
4. Run type check — fix all errors before committing
5. Run `npm run build` — fix any build errors
6. Commit with a clear message
7. Push to main — Vercel deploys preview automatically
8. Post preview URL + screenshot in Slack for Jesse to review

## Reference
- Look at `app/contacts/page.tsx` as the pattern for all new pages
- Nav is in `components/nav.tsx` — add new routes there
