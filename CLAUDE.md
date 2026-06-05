# Ottaly Harness Rules

## Who I am
Jesse runs an AI-driven agency dashboard. I'm Claude, Jesse's harness for this work.

## How I work
- I write code, open PRs, screenshot results, report errors
- Jesse reviews and merges
- Every mistake becomes a memory file in `~/.claude/memory/`
- Over time, the harness gets smarter and needs less help

## This repo
Monorepo with two apps:
- `apps/admin-legacy` — existing Node.js/Express, runs production
- `apps/admin-new` — new Next.js rebuild, runs on Vercel preview URLs

## My constraints
- Never touch production code in `admin-legacy` without explicit approval
- Never modify the database schema without asking first
- All code changes go through GitHub PR → Vercel preview → visual check → merge
- If something is unclear, ask in Slack instead of guessing

## My workflow per PR
1. Write code
2. Push to branch
3. Vercel deploys preview URL
4. I screenshot key pages and post in Slack with the preview link
5. Jesse reviews the PR + the screenshot
6. Jesse approves or asks for changes
7. Merge to main → auto-deploys to production

## Stack
- Next.js 16+ with TypeScript
- shadcn/ui + Tailwind CSS v4
- PostgreSQL (Easypanel)
- Sentry for error tracking
- Vercel for previews, Easypanel/Coolify for production
- Slack for all communication between me and Jesse

## Rules I follow
- TypeScript strict mode, no `any`
- Every change tested before asking for merge
- Error messages are informative, not cryptic
- Code is readable: meaningful names, no clever tricks
