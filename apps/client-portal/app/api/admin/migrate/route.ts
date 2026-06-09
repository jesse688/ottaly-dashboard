import { NextResponse, type NextRequest } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import pool from '@/lib/db'

// POST — run idempotent schema migration
export async function POST(_req: NextRequest) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  await pool.query(`
    ALTER TABLE portal_clients ADD COLUMN IF NOT EXISTS hidden_fields TEXT[] DEFAULT '{}';

    CREATE TABLE IF NOT EXISTS portal_client_labels (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      client_id UUID NOT NULL REFERENCES portal_clients(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT 'purple',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS portal_lead_disputes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      lead_id TEXT NOT NULL,
      client_id UUID NOT NULL REFERENCES portal_clients(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      admin_note TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      resolved_at TIMESTAMPTZ,
      UNIQUE(lead_id, client_id)
    );

    CREATE TABLE IF NOT EXISTS portal_lead_data (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      lead_id TEXT NOT NULL,
      client_id UUID NOT NULL REFERENCES portal_clients(id) ON DELETE CASCADE,
      deal_value NUMERIC(12,2),
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(lead_id, client_id)
    );

    CREATE TABLE IF NOT EXISTS portal_invoices (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      client_id UUID NOT NULL REFERENCES portal_clients(id) ON DELETE CASCADE,
      invoice_number TEXT,
      description TEXT NOT NULL,
      amount NUMERIC(12,2) NOT NULL,
      currency TEXT NOT NULL DEFAULT 'GBP',
      status TEXT NOT NULL DEFAULT 'unpaid',
      due_date DATE,
      paid_date DATE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `)

  return NextResponse.json({ ok: true })
}
