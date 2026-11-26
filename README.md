# Pharmacy Finder Bot

Telegram pharmacy search in English, Uzbek and Russian. Share your location in
a private chat to find up to five nearby pharmacies, save favorites and repeat
recent searches. Search radii: 1, 3 or 5 km.

## Setup

Requires Node.js 22 or newer and npm.

```bash
cd app
npm ci
cp -n .env.example .env
```

Open `.env` and put your own BotFather token after `TELEGRAM_BOT_TOKEN=`. Keep
your token private. Then run:

```bash
npm start
```

Open the bot in Telegram and send `/start`. Stop it with Ctrl+C. SIGINT and
SIGTERM cancel map requests and finish pending database writes.

## Updating an existing installation

1. Stop the old bot process.
2. Back up your current app directory.
3. Copy the updated `.mjs` files, `package.json`, `package-lock.json`, `test/`,
   `.env.example`, `.gitignore` and this README into the existing directory.
4. Keep your existing `.env` and current `pharmacy-data.json`. This archive
   contains the database from your upload unchanged; do not overwrite newer
   live data with that older copy.
5. Run `npm ci`, then `npm start`. Open `/menu` or `/recent` again to replace
   old recent-search buttons. Preferences and favorites are preserved.

Run just one process per bot token and database file. JSON storage is intended
for a small bot on one machine; multiple instances need a shared transactional
database and an update delivery strategy.

## Commands

| Command | Action |
| --- | --- |
| `/start` | Welcome message and location keyboard |
| `/menu` | Main menu |
| `/search` | Request your location |
| `/radius` | Choose the search radius |
| `/favorites` | Browse saved pharmacies |
| `/recent` | Repeat a recent location search |
| `/language` | Change English / Uzbek / Russian |
| `/help` | Usage help |
| `/privacy` | Explain location storage and map requests |
| `/clearhistory` | Cancel a pending search and clear active location history |

## Data and recovery

- `.env` is loaded from the app directory, even when launched elsewhere.
- The default data file is `pharmacy-data.json`. Optionally set
  `PHARMACY_DATA_FILE` to a different path. Relative paths use the app directory.
- Saves are queued, written to a private temporary file, synced and atomically
  renamed. `pharmacy-data.json.bak` retains the previous valid version.
- If the primary file is corrupt and the backup is valid, recovery preserves
  the corrupt original as `pharmacy-data.json.corrupt-*` before restoring data.
- If neither file is usable, startup stops and preserves the files for manual
  recovery. It never silently replaces an unreadable database with empty data.
- Location history contains up to five searches per user. `/clearhistory`
  clears active history; backups can still contain older records. The operator
  controls backup retention. Treat database files and backups as private.

## Search behavior

The bot queries OpenStreetMap's public Overpass servers. Searches have bounded
timeouts and fall back to alternative servers. Incomplete responses are
retried. One search per user and four simultaneous searches in total are
allowed. Results are sorted by straight-line distance, which can differ from
walking or driving distance. Polygon results use their bounding-box center.

Map coverage, phone numbers and opening hours may be incomplete or outdated.
The bot does not verify current opening status or medicine availability.
Google Maps opens directions from the location selected in Maps.

## Verification

```bash
npm run check
npm test
npm audit --omit=dev
```

The automated suite uses simulated Telegram and map responses. It includes
the actual Telegram library, startup, polling, graceful shutdown, group privacy,
language changes, stable history, favorites, map failures and database recovery.
It sends no real Telegram messages and never uses your token or production
database. Verification was run with Node.js 24.22.3. A final live check with
your own bot token is still needed after installation.

## Changes in 1.1.0

- Blocked private history, favorites and searches in groups and inline contexts.
- Replaced shifting history indexes with persistent search identifiers.
- Refreshed language keyboards and accepted old translated Menu buttons.
- Made favorite add/remove actions safe to repeat and added pagination.
- Preserved original search distances when viewing older results.
- Added database backups, corruption recovery and validation.
- Delayed polling until startup completes; handled shutdown and fatal failures.
- Added command registration, privacy information and history clearing.
- Updated the Telegram library to 2.4.1 and removed its deprecated dependency
  tree. The installation audit reported zero known vulnerabilities at verification.
- Added installation instructions, npm scripts and automated regression tests.
