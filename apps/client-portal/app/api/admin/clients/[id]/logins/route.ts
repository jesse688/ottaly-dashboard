import { NextResponse, type NextRequest } from 'next/server'
import { getAdminSession, generateInviteToken, portalBaseUrl } from '@/lib/auth'
import pool from '@/lib/db'

// Admin management of multi-workspace logins (portal_user_access).
//
// Model: one `identifier` (email) + one access code can map to MANY workspaces.
// Each (identifier, client_id) is a row. Rows for the same identifier share an
// invite_token and password_hash, so the client sets their code ONCE and it
// unlocks every workspace they're granted. Admin never handles the password.
//
// The [id] in the path is the client whose page admin is on — used only as the
// default workspace to grant. Grants can target any client_id via workspaceIds.

// GET — list every login (identifier) that can reach THIS client's workspace,
// plus all workspaces each of those identifiers can reach (so the UI can show
// "this person also has access to: …").
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params

  const r = await pool.query(
    `SELECT ua.identifier,
            bool_or(ua.password_hash IS NOT NULL AND ua.password_hash <> '') AS has_code,
            json_agg(json_build_object(
              'clientId', c.id, 'company', c.company_name, 'workspaceId', c.workspace_id
            ) ORDER BY c.company_name) AS workspaces
       FROM portal_user_access ua
       JOIN portal_clients c ON c.id = ua.client_id
      WHERE lower(ua.identifier) IN (
              SELECT lower(identifier) FROM portal_user_access WHERE client_id = $1)
      GROUP BY lower(ua.identifier), ua.identifier
      ORDER BY ua.identifier`,
    [id]
  )
  return NextResponse.json({ logins: r.rows })
}

// POST { identifier, workspaceIds?: string[] } — grant a login access to one or
// more workspaces (defaults to the current client). Reuses the identifier's
// existing code if it already has one; otherwise issues an invite link.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  const body = await req.json().catch(() => ({})) as { identifier?: string; workspaceIds?: string[] }
  const identifier = (body.identifier ?? '').trim()
  if (!identifier) return NextResponse.json({ error: 'Email/identifier is required.' }, { status: 400 })

  const targets = (body.workspaceIds && body.workspaceIds.length ? body.workspaceIds : [id])
    .filter(Boolean)

  // Does this identifier already have a code / invite token somewhere? Reuse it
  // so a newly-granted workspace unlocks with the SAME login.
  const existing = await pool.query(
    `SELECT password_hash, invite_token FROM portal_user_access
      WHERE lower(identifier) = lower($1)
      ORDER BY (password_hash IS NOT NULL) DESC NULLS LAST LIMIT 1`,
    [identifier]
  )
  let hash: string | null = existing.rows[0]?.password_hash ?? null
  let token: string | null = existing.rows[0]?.invite_token ?? null
  // No code yet anywhere → mint one invite token shared across all rows.
  if (!hash && !token) token = generateInviteToken()

  for (const clientId of targets) {
    await pool.query(
      `INSERT INTO portal_user_access (identifier, password_hash, invite_token, client_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (identifier, client_id) DO UPDATE
         SET password_hash = COALESCE(portal_user_access.password_hash, EXCLUDED.password_hash),
             invite_token  = COALESCE(portal_user_access.invite_token,  EXCLUDED.invite_token)`,
      [identifier, hash, token, clientId]
    )
  }

  const inviteUrl = (!hash && token) ? `${portalBaseUrl(req)}/invite/u/${token}` : null
  return NextResponse.json({ ok: true, hasCode: !!hash, inviteUrl })
}

// DELETE { identifier, clientId? } — revoke a login from one workspace (clientId)
// or, if clientId omitted, from this client's workspace.
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  const body = await req.json().catch(() => ({})) as { identifier?: string; clientId?: string }
  const identifier = (body.identifier ?? '').trim()
  if (!identifier) return NextResponse.json({ error: 'identifier required' }, { status: 400 })
  const clientId = body.clientId || id

  await pool.query(
    `DELETE FROM portal_user_access WHERE lower(identifier) = lower($1) AND client_id = $2`,
    [identifier, clientId]
  )
  return NextResponse.json({ ok: true })
}
