# Validation notes

Validated for the saved-game, roster, drink standings and scoring update:

- `npm run check`: JavaScript syntax for the frontend, roster parser, Pages proxy and backend.
- `npm test`: 18 passing tests against the actual backend handlers and SQL using the Node SQLite D1 adapter.
- `CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm run test:browser`: passing Chromium smoke test on desktop and a 390px mobile viewport, with no browser JavaScript errors or mobile horizontal overflow.
- Worker dry-run compilation using Wrangler 4.151.1.
- Both migrations successfully applied through Wrangler's local D1 runtime.
- A populated legacy-database upgrade tested with foreign keys enabled, preserving teams, password hashes, sessions, venue ownership, attempts, photo metadata, adjustments and audit history.

Integration coverage includes one pending outcome across team devices; simultaneous different-bar claims; failure/veto/success unblocking; steals only after failure/veto; competing steal completion and automatic loss resolution; one point for a claim plus one for locking; duplicate submission rejection; selected-member validation; one drink per person/bar; drink history through failed challenges, steals and roster removal; undo/retry corrections; atomic CSV imports and passcode rotation; repeated team names and Google venue IDs in isolated games; cross-game access rejection; draft login gates; separate lobby and timer start; pause/end/resume clock accumulation; installation-wide podium nicknames and numeric defaults; authentication, CSRF and private media.

The browser smoke test uses real sessions, SQL, backend handlers, image processing and live WebSocket invalidations through a local Durable Object adapter. It checks roster import/editing, a stale claim form on a second device, the reporting popup, outcomes, live individual standings, podium defaults/nicknames, lobby/start controls, clock pause/resume, saved drafts and responsive layout. Google venue lookup is substituted with a test widget. The test never contacts the production game.

Limits:

- Production Cloudflare data has not been migrated or deployed by this change. Apply the migration and deploy the Worker/frontend together using the upgrade steps in `SETUP.md`.
- The test adapters do not replace an account-level Cloudflare rehearsal with the actual Durable Object, D1, private R2 bucket and Pages service binding.
- Real Google billing/key configuration and iPhone/Android camera behavior still need a device smoke test. HEIC depends on browser decoding; JPEG/PNG, a screenshot, or the camera option are the supported fallbacks.
- The game clock records elapsed time from its first start. It pauses with the game and has no automatic countdown expiry. An older event has no stored timer history to recover at migration.
- No offline submissions or background mobile notifications. An active browser tab receives live updates with a 20-second refresh fallback.
- Each saved game is fetched as a small private-event snapshot, not a large public-platform feed.
