# Recording The Full Workflow

Use this to train the automation from the exact browser steps you already do manually.

## Record Once

Run this from the project folder on your Mac:

```bash
npm run record:workflow
```

A browser will open. Do the whole workflow manually:

1. Log into Apollo.
2. Open the Apollo search URL.
3. Sort the search if needed.
4. Run the scrape/export flow.
5. Upload the CSV back to Apollo if that is part of the current process.
6. Create/select the Apollo list.
7. Export the saved contacts CSV.
8. Open Google Drive.
9. Upload the Apollo export into the verifier folder.
10. Wait for the verifier file to appear.
11. Download the verified CSV.
12. Open PlusVibe.
13. Upload the verified leads / create the campaign.
14. Stop once the campaign/leads are confirmed.

Playwright will save:

```text
recordings/full-workflow.recording.js
recordings/browser-session.json
```

## What Happens Next

The recording is not the final production script. It is the source material.

After recording, the automation should be cleaned up to:

- use stable selectors,
- keep credentials out of code,
- reuse the saved browser session,
- add waits and logging,
- handle uploads/downloads reliably,
- replace browser steps with APIs where safer and more reliable.

## Important

Do not commit lead CSVs, downloaded verifier files, screenshots with private data, or secrets.

The browser session file can contain login cookies, so it is ignored by git.

## Dashboard Automation Browser

The deployed dashboard can also start a persistent browser session from the Automation page.

Required deployment settings:

```bash
APOLLO_SESSION_DIR=/data/apollo-session
AUTOMATION_NOVNC_PORT=6080
```

EasyPanel must expose port `6080` for the Ottaly app. Then use:

1. Automation page
2. Start Browser
3. Open Browser
4. Log into Apollo, Google Drive, and PlusVibe once
5. Leave the session saved for future automation runs
