import { NextResponse } from 'next/server'
import { q } from '@/lib/query'
import { getCacheFreshness } from '@/lib/freshness'

/**
 * Gateways — recipient mailbox-provider distribution from the `contacts` table.
 *
 * `contacts.mx_provider` is a coarse bucket the contact sync writes per lead:
 *   email_google  → Google Workspace / Gmail
 *   email_outlook → Microsoft 365 / Outlook
 *   email_other   → some other / gateway-fronted provider (Mimecast, Proofpoint,
 *                   self-hosted, etc.) — i.e. "gateway-filtered" from our POV
 *   NULL / ''     → unknown (never resolved)
 *
 * We GROUP BY workspace_id + bucket so the page can show an agency total split
 * plus a per-client breakdown. Workspace display names come from workspace_stats
 * (the only table that carries workspace_name keyed by workspace_id).
 */

type Bucket = 'google' | 'microsoft' | 'other' | 'unknown'

function classify(raw: string | null): Bucket {
  switch ((raw || '').trim()) {
    case 'email_google':
      return 'google'
    case 'email_outlook':
      return 'microsoft'
    case 'email_other':
      return 'other'
    default:
      return 'unknown'
  }
}

interface Split {
  google: number
  microsoft: number
  other: number
  unknown: number
}

export interface WorkspaceGateway {
  workspace_id: string
  name: string
  total: number
  split: Split
}

export interface GatewaysResponse {
  total: number
  split: Split
  workspaces: WorkspaceGateway[]
  syncedAt: string | null
  error?: string
}

interface Row {
  workspace_id: string | null
  mx_provider: string | null
  n: string // count() comes back as text from pg
}

function emptySplit(): Split {
  return { google: 0, microsoft: 0, other: 0, unknown: 0 }
}

export async function GET(req: Request) {
  try {
    // Optional date range — filters to contacts emailed in [start, end] via
    // last_emailed_at (TEXT/timestamp). No range = all contacts.
    const { searchParams } = new URL(req.url)
    const start = searchParams.get('start')
    const end = searchParams.get('end')
    const params: string[] = []
    let dateClause = ''
    if (start && end) {
      params.push(start, end)
      dateClause = `WHERE last_emailed_at IS NOT NULL
                      AND last_emailed_at::date >= $1::date
                      AND last_emailed_at::date <= $2::date`
    }
    const rows = await q<Row>(
      `SELECT COALESCE(workspace_id, 'unknown') AS workspace_id,
              mx_provider,
              COUNT(*) AS n
         FROM contacts
         ${dateClause}
        GROUP BY COALESCE(workspace_id, 'unknown'), mx_provider`,
      params,
      { tag: 'gateways:distribution', timeoutMs: 15000 },
    )

    // Names: workspace_id → workspace_name (best-effort; missing = id fallback).
    const nameRows = await q<{ workspace_id: string; workspace_name: string | null }>(
      `SELECT DISTINCT workspace_id, workspace_name FROM workspace_stats`,
      [],
      { tag: 'gateways:names', timeoutMs: 8000 },
    )
    const names = new Map<string, string>()
    for (const r of nameRows) {
      if (r.workspace_id && r.workspace_name) names.set(r.workspace_id, r.workspace_name)
    }

    const byWs = new Map<string, Split>()
    const agg = emptySplit()
    let total = 0

    for (const r of rows) {
      const ws = r.workspace_id || 'unknown'
      const bucket = classify(r.mx_provider)
      const n = Number(r.n) || 0
      if (!byWs.has(ws)) byWs.set(ws, emptySplit())
      const split = byWs.get(ws)!
      split[bucket] += n
      agg[bucket] += n
      total += n
    }

    const workspaces: WorkspaceGateway[] = [...byWs.entries()]
      .map(([workspace_id, split]) => ({
        workspace_id,
        name: names.get(workspace_id) || workspace_id,
        total: split.google + split.microsoft + split.other + split.unknown,
        split,
      }))
      .sort((a, b) => b.total - a.total)

    const { syncedAt } = await getCacheFreshness('contacts')

    const body: GatewaysResponse = { total, split: agg, workspaces, syncedAt }
    return NextResponse.json(body)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const body: GatewaysResponse = {
      total: 0,
      split: emptySplit(),
      workspaces: [],
      syncedAt: null,
      error: message,
    }
    return NextResponse.json(body, { status: 500 })
  }
}
