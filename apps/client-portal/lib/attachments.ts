import pool from '@/lib/db'
import {
  fetchPvAttachment,
  guessContentType,
  isRealAttachment,
  pvAttachmentName,
  type PVAttachmentRef,
  type PVReceivedEmail,
} from '@/lib/plusvibe'

// ── Inbound attachment ingest ────────────────────────────────────────────────
//
// PlusVibe hands us inbound files under `out_attachments` (yes, "out" — it is
// PV's own naming for the parts that came in on the message), each carrying an
// `s3_key` that is a PRESIGNED URL with X-Amz-Expires=86400.
//
// That 24h TTL is the whole design constraint. Storing the URL and rendering it
// as a link would work for a day and then 403 forever — verified against live
// data: a link from 11 Aug returns 403, one from today returns 200. So the bytes
// are copied into portal_attachments while the signature is still valid.
//
// The portal is a real inbox: EVERY part is stored, including signature logos.
// Nothing the sender sent is discarded. `is_inline` only tells the thread view
// which parts belong in the attachment chip bar (documents) and which are already
// visible in the body (inline images) — both remain downloadable.

export interface StoredAttachment {
  id: string
  filename: string
  size: number
  content_type: string
  is_inline: boolean
}

// Total bytes we are willing to pull for a single email. Guards the cron against
// one pathological message (a 20-file photo dump) eating the whole run.
const PER_EMAIL_BUDGET = 60 * 1024 * 1024
const PER_FILE_LIMIT = 25 * 1024 * 1024

// Fetch + persist every attachment on one inbound email. Returns metadata for the
// files actually stored, newest-call-wins on re-run (the unique index on
// (email_id, source_key) makes this idempotent).
//
// NEVER throws: an attachment problem must not cost us the email. Callers treat a
// [] result as "no files stored", not as failure.
export async function ingestInboundAttachments(
  emailId: string,
  workspaceId: string,
  parts: PVAttachmentRef[] | null | undefined,
): Promise<StoredAttachment[]> {
  if (!Array.isArray(parts) || !parts.length) return []

  const stored: StoredAttachment[] = []
  let spent = 0

  for (const [i, part] of parts.entries()) {
    const url = (part.s3_key ?? '').trim()
    if (!url) continue

    const filename = pvAttachmentName(part, i)
    const declared = Number(part.size ?? 0)
    // source_key identifies the PV part so a re-run cannot duplicate it. The
    // presigned URL's query string changes between fetches, so key on the stable
    // storage path only (everything before the '?').
    const sourceKey = (url.split('?')[0] || url).slice(0, 500)

    if (declared > PER_FILE_LIMIT) continue
    if (spent + declared > PER_EMAIL_BUDGET) break

    // Skip anything already stored for this email — cheap check before the network
    // call, so a backfill re-run over healthy rows costs nothing.
    try {
      const seen = await pool.query(
        `SELECT 1 FROM portal_attachments WHERE email_id = $1 AND source_key = $2 LIMIT 1`,
        [emailId, sourceKey],
      )
      if (seen.rows.length) continue
    } catch {
      // Index/column may not exist yet on an un-migrated DB — fall through and
      // let the INSERT decide rather than skipping a real file.
    }

    const bytes = await fetchPvAttachment(url, PER_FILE_LIMIT)
    if (!bytes) continue                     // expired presign / network / oversize
    spent += bytes.length

    const isInline = !isRealAttachment(part)
    try {
      const ins = await pool.query(
        `INSERT INTO portal_attachments
           (email_id, workspace_id, filename, content_type, size, content, is_inline, source_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (email_id, source_key) WHERE source_key IS NOT NULL DO NOTHING
         RETURNING id`,
        [emailId, workspaceId, filename, guessContentType(filename),
         bytes.length, bytes.toString('base64'), isInline, sourceKey],
      )
      if (!ins.rows.length) continue          // raced with another run — already stored
      stored.push({
        id: ins.rows[0].id as string,
        filename,
        size: bytes.length,
        content_type: guessContentType(filename),
        is_inline: isInline,
      })
    } catch (err) {
      console.error(`[attachments] persist failed email=${emailId} file=${filename}:`, err)
    }
  }

  return stored
}

// Mirror the stored metadata into portal_emails.raw->'attachments' — the key the
// thread route already reads. Inbound files arrive under `out_attachments`, which
// nothing rendered; writing the normalised list here is what makes them appear,
// and keeps inbound and outbound messages on ONE shape for the UI.
export async function linkAttachmentsToEmail(
  emailId: string,
  stored: StoredAttachment[],
): Promise<void> {
  if (!stored.length) return
  try {
    await pool.query(
      `UPDATE portal_emails
          SET raw = COALESCE(raw, '{}'::jsonb) || jsonb_build_object('attachments', $2::jsonb)
        WHERE id = $1`,
      [emailId, JSON.stringify(stored)],
    )
  } catch (err) {
    console.error(`[attachments] link failed email=${emailId}:`, err)
  }
}

// Convenience: ingest + link in one call, for the reconcile cron.
export async function ingestAndLink(
  emailId: string,
  workspaceId: string,
  email: Pick<PVReceivedEmail, 'out_attachments'>,
): Promise<number> {
  const stored = await ingestInboundAttachments(emailId, workspaceId, email.out_attachments)
  await linkAttachmentsToEmail(emailId, stored)
  return stored.length
}
