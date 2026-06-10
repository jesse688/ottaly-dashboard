import { NextResponse, type NextRequest } from 'next/server'
import { getAdminSession, sha256, generateAccessCode } from '@/lib/auth'
import pool from '@/lib/db'
import { backfillWorkspace } from '@/lib/sync'
import { registerWebhook } from '@/lib/plusvibe'

export async function GET() {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const res = await pool.query(`
    SELECT pc.id, pc.username, pc.email, pc.company_name, pc.workspace_id, pc.active, pc.created_at,
           pc.cost_per_lead, pc.spend_visibility,
           w.name AS workspace_name
    FROM portal_clients pc
    LEFT JOIN esp_workspaces w ON w.id = pc.workspace_id AND w.source = 'plusvibe'
    ORDER BY pc.company_name ASC
  `)
  return NextResponse.json(res.rows)
}

export async function POST(req: NextRequest) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const b = await req.json() as {
    username?: string
    code?: string
    email?: string
    workspaceId: string
    companyName: string
    costPerLead?: number
  }
  const username = (b.username ?? '').trim()
  const workspaceId = b.workspaceId
  const companyName = b.companyName
  const code = (b.code ?? '').trim() || generateAccessCode()

  if (!username || !workspaceId || !companyName) {
    return NextResponse.json({ error: 'Username, company and workspace are required' }, { status: 400 })
  }

  const passwordHash = sha256(code)

  try {
    const res = await pool.query(
      `INSERT INTO portal_clients (username, email, password_hash, workspace_id, company_name, cost_per_lead)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [username, (b.email ?? '').toLowerCase() || null, passwordHash, workspaceId, companyName, Number(b.costPerLead) || 0]
    )

    // Auto-backfill this client's workspace (leads + real email threads) so they
    // have data immediately. Runs in the background — client creation returns now.
    backfillWorkspace(workspaceId)
      .then(r => console.log(`[client-create] backfilled ${companyName}:`, r))
      .catch(e => console.error(`[client-create] backfill failed for ${companyName}:`, e))

    // Best-effort: register the PlusVibe lead webhook for this workspace. No-ops
    // unless PLUSVIBE_WEBHOOK_CREATE_URL/TARGET_URL are configured (polling covers it otherwise).
    const hook = await registerWebhook(workspaceId)

    // Return the plaintext code ONCE so the admin can send it to the client.
    return NextResponse.json({ ok: true, id: res.rows[0].id, username, code, webhook: hook.ok ? 'registered' : hook.reason })
  } catch (err: unknown) {
    const pgErr = err as { code?: string }
    if (pgErr.code === '23505') {
      return NextResponse.json({ error: 'That username is already taken' }, { status: 409 })
    }
    console.error('[admin/clients POST]', err)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
}
