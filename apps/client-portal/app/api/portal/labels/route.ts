import { NextResponse, type NextRequest } from 'next/server'
import { getSession } from '@/lib/auth'
import pool from '@/lib/db'

interface LabelRow {
  id: string
  name: string
  color: string
  prompts_value: boolean
}

// Sensible default pipeline so clients aren't staring at a blank, complicated setup.
// The value stages (Quote Sent, Won) prompt for a deal value when reached.
const DEFAULT_STAGES = [
  { name: 'Meeting Booked', color: 'blue',   prompts_value: false },
  { name: 'Quote Sent',     color: 'orange', prompts_value: true },
  { name: 'Won',            color: 'lime',   prompts_value: true },
  { name: 'Lost',           color: 'gray',   prompts_value: false },
]

// GET — client's deal stages. Seeds defaults on first use.
export async function GET(_req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let res = await pool.query(
    'SELECT id, name, color, prompts_value FROM portal_client_labels WHERE client_id = $1 ORDER BY sort_order ASC, created_at ASC',
    [session.clientId]
  )

  if (res.rows.length === 0) {
    for (let i = 0; i < DEFAULT_STAGES.length; i++) {
      const s = DEFAULT_STAGES[i]
      await pool.query(
        `INSERT INTO portal_client_labels (client_id, name, color, prompts_value, sort_order)
         VALUES ($1, $2, $3, $4, $5)`,
        [session.clientId, s.name, s.color, s.prompts_value, i]
      )
    }
    res = await pool.query(
      'SELECT id, name, color, prompts_value FROM portal_client_labels WHERE client_id = $1 ORDER BY sort_order ASC, created_at ASC',
      [session.clientId]
    )
  }

  return NextResponse.json(res.rows as LabelRow[])
}

// POST — create a custom deal stage
export async function POST(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { name, color, promptsValue } = await req.json() as { name: string; color: string; promptsValue?: boolean }
  if (!name || !color) return NextResponse.json({ error: 'name and color are required' }, { status: 400 })

  const ord = await pool.query('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM portal_client_labels WHERE client_id = $1', [session.clientId])
  const res = await pool.query(
    `INSERT INTO portal_client_labels (client_id, name, color, prompts_value, sort_order)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, name, color, prompts_value`,
    [session.clientId, name, color, !!promptsValue, ord.rows[0].n]
  )

  return NextResponse.json(res.rows[0] as LabelRow, { status: 201 })
}
