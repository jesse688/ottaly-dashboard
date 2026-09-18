/**
 * Pull bounced leads from PlusVibe, classify them, and store them.
 *
 * Only `list_all_leads` with status=BOUNCED carries `bounce_msg`. The bulk
 * stats endpoint returns counts, which cannot tell you what to do — see
 * bounce.js for why the message text is the only reliable signal.
 *
 * Usage:
 *   node mailbox/bounce-ingest.js
 *   node mailbox/bounce-ingest.js --client=ShireRecoveries
 */

require('dotenv').config();
const store = require('./db');
const { PVMcp } = require('./pv-mcp');
const { classify, statusCode } = require('./bounce');

const PAGE = 100;

async function ingest({ only = null, log = console.error, pages = 5 } = {}) {
  const db = store.open();
  const mcp = new PVMcp(process.env.PLUSVIBE_API_KEY);

  const workspaces = db.prepare(`
    SELECT DISTINCT workspace_id, workspace_name FROM mailbox
    WHERE workspace_name NOT IN (SELECT workspace_name FROM client_state WHERE state='removed')
      AND (? IS NULL OR workspace_name = ?)
  `).all(only, only);

  // Map PlusVibe account ids to mailbox addresses, so a bounce can be tied to
  // the mailbox that sent it.
  const byId = {};
  for (const r of db.prepare(`SELECT pv_id, email FROM mailbox`).all()) byId[r.pv_id] = r.email;

  const up = db.prepare(`
    INSERT INTO bounce_event (lead_id, email, workspace, recipient, bounced_at,
      bounce_type, status_code, cause, action, bounce_msg)
    VALUES (@lead_id, @email, @workspace, @recipient, @bounced_at,
      @bounce_type, @status_code, @cause, @action, @bounce_msg)
    ON CONFLICT(lead_id) DO UPDATE SET
      cause=excluded.cause, action=excluded.action,
      status_code=excluded.status_code, bounce_msg=excluded.bounce_msg
  `);

  const before = db.prepare(`SELECT COUNT(*) c FROM bounce_event`).get().c;
  let total = 0, unknown = 0;
  for (const ws of workspaces) {
    let got = 0;
    for (let page = 0; page < pages; page++) {
      let leads;
      try {
        // NOTE: this endpoint pages with `page`, which is the opposite of
        // /account/list — that one rejects `page` outright and needs `skip`.
        // Passing skip here silently returns page 1 every time, so a run looks
        // like it fetched thousands of rows while storing the same hundred.
        const d = await mcp.call('list_all_leads', {
          workspace_id: ws.workspace_id, status: 'BOUNCED',
          limit: PAGE, page: page + 1,
        });
        const txt = String(d?.raw ?? '');
        const start = txt.indexOf('[');
        leads = start >= 0 ? JSON.parse(txt.slice(start)) : (Array.isArray(d) ? d : []);
      } catch (e) {
        log(`  ${ws.workspace_name}: ${e.message}`);
        break;
      }
      if (!leads.length) break;

      const rows = leads.map((l) => {
        const c = classify(l.bounce_msg);
        if (c.key === 'unknown') unknown++;
        return {
          lead_id: l._id,
          email: byId[l.email_account_id] || (l.email_acc_name || '').toLowerCase() || null,
          workspace: ws.workspace_name,
          recipient: l.email || null,
          bounced_at: l.modified_at || l.last_sent_at || null,
          bounce_type: l.bounce_type || null,
          status_code: statusCode(l.bounce_msg),
          cause: c.key,
          action: c.action,
          bounce_msg: l.bounce_msg || null,
        };
      });
      const tx = db.transaction(() => { for (const r of rows) up.run(r); });
      tx();
      got += rows.length;
      total += rows.length;
      if (leads.length < PAGE) break;
    }
    if (got) log(`  ${ws.workspace_name}: ${got} bounces`);
  }

  // Report rows actually added, not rows fetched: a paging bug shows up as a
  // big fetch count with nothing new stored, and that should be visible.
  const after = db.prepare(`SELECT COUNT(*) c FROM bounce_event`).get().c;
  const added = after - before;
  log(`bounces: ${total} fetched, ${added} new, ${unknown} unclassified, ${mcp.calls} MCP calls`);
  db.close();
  return { fetched: total, added, unknown, calls: mcp.calls };
}

if (require.main === module) {
  const arg = process.argv.find((a) => a.startsWith('--client='));
  ingest({ only: arg ? arg.split('=')[1] : null })
    .then((r) => { console.log(JSON.stringify(r)); process.exit(0); })
    .catch((e) => { console.error('BOUNCE INGEST FAILED:', e.message); process.exit(1); });
}

module.exports = { ingest };
