/**
 * Pull placement results from PlusVibe and store them.
 *
 * Runs unattended: the MCP endpoint is plain JSON-RPC over HTTP and takes the
 * API key in the URL, so no Claude session is needed.
 *
 * Only generic-content tests are stored — see placement.js for why.
 *
 * Usage:
 *   node mailbox/placement-pull.js                     all client workspaces
 *   node mailbox/placement-pull.js --client=ButterflyEco
 */

require('dotenv').config();
const store = require('./db');
const { PVMcp } = require('./pv-mcp');
const { ingestPlacement } = require('./placement');

async function pull({ only = null, log = console.error } = {}) {
  const db = store.open();
  const mcp = new PVMcp(process.env.PLUSVIBE_API_KEY);
  try {
    const out = await ingestPlacement(db, mcp, { log, only });
    log(`MCP calls: ${mcp.calls}`);
    return { ...out, calls: mcp.calls };
  } finally {
    db.close();
  }
}

if (require.main === module) {
  const arg = process.argv.find((a) => a.startsWith('--client='));
  pull({ only: arg ? arg.split('=')[1] : null })
    .then((r) => { console.log(JSON.stringify(r)); process.exit(0); })
    .catch((e) => { console.error('PLACEMENT PULL FAILED:', e.message); process.exit(1); });
}

module.exports = { pull };
