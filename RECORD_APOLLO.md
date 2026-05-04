# Recording The Apollo Workflow

Use this when Apollo UI steps need to be trained from a real browser run.

## Record Once

Run this from the project folder on your Mac:

```bash
npm run record:apollo
```

A browser will open. Do the Apollo workflow manually:

1. Log into Apollo.
2. Open the Apollo search URL.
3. Sort the search if needed.
4. Open the scrape/export menu.
5. Set the page count.
6. Start the scrape/export.
7. Stop when the first CSV download has started.

Playwright will save:

```text
recordings/apollo-workflow.recording.js
recordings/apollo-storage.json
```

## What Happens Next

The recording is not the final production script. It is the source material.

After recording, the automation should be cleaned up to:

- use stable selectors,
- keep credentials out of code,
- reuse the saved browser session,
- add waits and logging,
- handle downloads reliably.

## Safety

Do not commit real downloaded lead CSV files or secrets. The `recordings/` folder should be reviewed before committing.
