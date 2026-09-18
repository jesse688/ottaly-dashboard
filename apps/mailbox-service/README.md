# mailbox-service

Mailbox health for the Ottaly estate: what each mailbox has spent, how it is
placing, why it bounces, and what to do about it.

Runs standalone so a problem here cannot take the admin dashboard down with it.

## Why it exists

PlusVibe reports rates. It does not report **causes**, and it cannot aggregate
across clients. Both gaps cost real money:

- PV shows a mailbox at "sender bounce 11.1%" and advises checking SPF/DKIM/
  DMARC. The actual cause was the shared Microsoft tenant ceiling, where DNS is
  irrelevant and the fix is less volume.
- A tenant limit is shared across clients, so no per-client rate can see it. On
  17-18 Sep 2026 it hit 10 clients at once while every individual client's
  bounce rate looked survivable.

## What it does

| | |
|---|---|
| **Burn** | Lifetime sends per mailbox, stitched from PlusVibe's 90-day windows |
| **Placement** | Generic-content placement tests, per mailbox and per recipient provider |
| **Bounces** | Classified by cause from the message text, not counted |
| **Recovery** | Rest vs replace per flagged mailbox, with cost |
| **Rotation** | One mailbox per domain per round, on a credit budget |
| **Actions** | Pause a mailbox in PlusVibe (backs up first, dry-run by default) |

Dashboard at `/mailboxes`. API under `/api/mailbox`.

## Deploy (EasyPanel)

Build from the monorepo root with `apps/mailbox-service/Dockerfile`.

**Volume is required.** Mount one at `/data`. Cumulative sends are stitched
from 90-day windows and cannot be re-derived once a day falls out of
PlusVibe's reach — losing the volume costs history, not just a resync.

Environment:

```
PLUSVIBE_API_KEY=...        # required
PV_WEBHOOK_SECRET=...       # optional; verifies bounce webhook payloads
MAILBOX_DB=/data/mailbox.db
MAILBOX_BACKUP_DIR=/data/backups
PORT=3002
GIT_SHA=<commit>            # build arg; /healthz reports it
```

Bump `ARG CACHEBUST` in the Dockerfile on every deploy. EasyPanel's Docker
cache has shipped stale code from a "successful" build before; admin-new and
admin-legacy carry the same guard.

## First run

```bash
npm run backfill      # once: walks PV back to each mailbox's creation
npm run bounces       # bounce history
npm run placement     # generic placement test results
```

Then on a schedule:

```bash
npm run nightly       # daily, ~85s, 56 API calls
npm run bounces       # hourly during sending hours
npm run placement     # weekly
```

## Bounce webhooks

Faster and cheaper than polling: PlusVibe pushes each bounce as it happens, at
no API cost. Register per workspace with event type `BOUNCED_EMAIL`, pointing
at:

```
https://<this service>/api/mailbox/bounce-webhook
```

Webhooks only cover new bounces, so the polling job stays as history and as a
safety net — a webhook that silently stops looks exactly like a quiet period.

## Writes

Only one thing here writes to PlusVibe: pausing a mailbox, which sets
`daily_limit` to 0 so cold sending stops while warmup continues. It writes a
restore file first and is dry-run unless the caller passes `apply: true`.

Note that PlusVibe keeps reporting a paused mailbox as "Active" — paused is
derived from the limit, not the status.
