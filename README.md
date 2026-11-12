# Battle for New York

Mobile-first, dark-themed game website for Cloudflare Pages, with a Cloudflare Worker, Durable Object, D1 and private R2 photo storage.

**Start with [SETUP.md](SETUP.md).** It walks through the exact resource creation, configuration, deployments, Google API setup, and first game.

## Your assets

- Game logo: `public/branding/logo.png` (optional; a built-in text logo appears until you add yours).
- Cards: `public/cards/1.png` through `public/cards/30.png`.
- The supplied card PNGs are already included. Files `31.png` through `36.png` are retained as original assets but excluded from the game picker.
- Original guides: `public/rules/rules.png` and `public/rules/how-to-play.png`.
- Card names/aliases: `worker/challenges.js`; see `CARD_INDEX.md` for the full mapping.
- Admin can upload/replace the logo after deployment, without editing the repository.

## Rules implemented

- One point per owned, unlocked venue; two points per owned, locked venue. Locking adds one point.
- Original owner can lock only after claiming.
- Original failure/veto keeps ownership but opens the venue to steal attempts.
- Stealing is only available after the original owner's failure/veto.
- Multiple challengers may attempt a steal. Only the first completed lock transfers ownership.
- Failed/vetoed challengers cannot retry that venue. Other challengers can still try.
- Losing concurrent attempts become `lost` when someone locks the venue.
- Teams must select a challenge for completed, failed and vetoed attempts. A pending outcome prevents the team from claiming another venue or starting a steal, including from another device.
- Photos required for claims/steal starts, optional for outcomes.
- Each checked member records one drink per bar, independent of challenge outcome or later ownership changes. The individual standings update alongside team scores.
- Drafts are admin-only. Enabling a game opens its lobby; the separate timer start opens claims and outcomes. Pause/end freeze the elapsed game clock. Individual challenge timing and curses stay outside the website.
- Scores are calculated from current ownership and lock status, plus any explicit admin adjustment.
- A shared rank is displayed for tied scores.

## How it works

Pages serves the website. Its `public/_worker.js` forwards `/api/*` to the private `bfny-game` Worker via a service binding. The Worker routes requests to a single game Durable Object. That object serializes read/check/write operations and writes related D1 changes in atomic batches. It pushes WebSocket invalidations so each signed-in device fetches fresh state. A 20-second fallback refresh and reconnect handling cover interruptions.

The installation supports multiple saved games, each with its own draft, teams, passcodes, rosters, bars, photos, feed, clock and scores. Admins select a saved game; teams select an enabled game when signing in. Podium nicknames are installation-wide and default to 1, 2, 3. Snapshots are sized for private group events, not a large public tournament platform. Submissions require connectivity.

D1 stores saved games, teams, hashed passcodes, expiring sessions, members, drink records, venue ownership, attempts, media metadata and an audit trail. R2 stores uploaded photos privately. A removed photo is inaccessible through the app; its stored object is retained for recovery. Cards and the logo are public static assets; player uploads and the scoreboard require a session for their game. An uploaded logo is public so it can appear on the login screen.

## Development and verification

There are no framework/package dependencies and no build step. Do not run `npm ci`; there is intentionally no dependency lockfile. Run with Node.js 24:

```sh
npm run check
npm test
```

The test suite exercises the actual backend handlers and SQL using Node's SQLite adapter and in-memory media storage. The 18 tests cover claim races across devices, competing steals, lock idempotency, two-point scoring, roster CSV parsing/import, drink deduplication, game isolation, draft/lobby gates, clock pause/resume, global podium defaults, a populated database upgrade, permissions, CSRF, media access, passcode rotation and admin corrections. Wrangler 4.151.1 was used for packaging checks; see `VALIDATION.md` for limits.

Do not edit the database directly during a live game; admin actions maintain the ownership/attempt relationships and emit live updates. The audit log records corrections, including the previous venue state. Use a separate saved game for rehearsal if you want a clean event history.

Optional Chromium smoke test (requires the Playwright developer tool and its Chromium browser):

```sh
npm install --no-save --package-lock=false playwright
npx playwright install chromium
npm run test:browser
```

For an installed system Chromium, set `CHROMIUM_EXECUTABLE_PATH` to its path. Set `BROWSER_ARTIFACT_DIR` to save screenshots. This test serves the actual backend/frontend locally, substitutes Google venue lookup, and checks CSV import, editable rosters, a stale claim form on a second device, the outcome popup, live drink standings, two-point scores, lobby/timer controls, shared podium nicknames and separate saved drafts. It never connects to the production game.

## Upgrading an existing installation

Apply `migrations/0002_games_rosters_drinks.sql` through Wrangler before deploying the updated backend. It preserves the existing event as the first saved game, including passcodes, sessions, venue history, photos and adjustments. Existing locked bars become worth two points. See the upgrade steps in `SETUP.md`.
