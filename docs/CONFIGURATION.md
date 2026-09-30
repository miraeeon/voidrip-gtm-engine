# Configuration reference

All settings live in `.env` at the repo root (or the file named by `GTM_ENV_FILE`).
- `npm run setup` fills in the important ones.
- An empty value (`KEY=`) means "use the default".
- Invalid values stop the program with a message naming the key.

Changes take effect on the next command, with one exception: **schedule** changes need `npm run schedule` to be re-registered with the OS.

## Bundled adapter credentials

The engine, SQLite store and MCP server start without provider credentials. These values become required only when the corresponding bundled adapter is invoked.

| Variable | Default | Description |
|---|---|---|
| `MAX_API_KEY` | – | Required by the bundled Max `SourceAdapter`. Sent as `Authorization: Bearer …` |
| `OVERLOOP_API_KEY` | – | Required by the bundled Overloop `ExecutionAdapter`. Sent raw in `Authorization` |
| `MAX_BUSINESS_ID` | set by setup | The Max business (your company) the loop runs for |
| `MAX_API_URL` | `https://api.yourmax.ai/api/v1` | Override only for testing |
| `OVERLOOP_API_URL` | `https://api.overloop.ai/public/v2` | Override only for testing |

## Safety

| Variable | Default | Description |
|---|---|---|
| `SEND_MODE` | `locked` | `locked`: enrollment, activation, auto-send, sourcing triggers and replies are blocked in code. `live`: sending is possible **only** through `approve` + `launch --confirm SEND` |
| `OVERLOOP_NAME_PREFIX` | `[GTM-BOT]` | Prefix of every campaign the bot creates. `gtm cleanup` only touches campaigns with this prefix |

## Overloop campaign settings

These are applied to every campaign the bot creates.

| Variable | Default | Description |
|---|---|---|
| `OVERLOOP_TIMEZONE` | `Europe/Brussels` | IANA timezone of the sending window |
| `OVERLOOP_SENDING_DAYS` | `MON,TUE,WED,THU,FRI` | Days Overloop may send |
| `OVERLOOP_SEND_START` | `09:00` | Start of the daily sending window (HH:MM) |
| `OVERLOOP_SEND_END` | `17:00` | End of the daily sending window (HH:MM) |
| `OVERLOOP_SENDER_ID` | – | Overloop user id to send as (default: the API key's user) |

## Daily volume

| Variable | Default | Description |
|---|---|---|
| `GTM_DAILY_NEW_LEADS` | `40` | Leads classified per day. Extra leads wait in the queue |
| `GTM_DAILY_SEQUENCES` | `25` | Sequences finalized per day |
| `GTM_DAILY_PUSH_LIMIT` | `25` | New Overloop campaigns per day |
| `GTM_SOURCE_MAX_PAGES` | `10` | Pages of 100 leads pulled from Max per run |
| `GTM_ENRICH_FROM_OVERLOOP` | `true` | Check each new lead against Overloop history (read-only) |

A good ramp while you're testing: 10 → 25 → 50 pushes per day. Watch deliverability in Overloop as you increase it.

## Scheduler and daily runner

| Variable | Default | Description |
|---|---|---|
| `GTM_SCHEDULE_ENABLED` | `true` | Informational; `npm run schedule` / `unschedule` actually add or remove it |
| `GTM_SCHEDULE_TIME` | `08:00` | Local time of the daily run (HH:MM) |
| `GTM_SCHEDULE_DAYS` | `MON,TUE,WED,THU,FRI` | Days of the daily run |
| `GTM_AGENT_CMD` | `claude` | Agent CLI the runner starts. `claude` (Claude Code) or `codex` |
| `GTM_MODEL` | `claude-opus-5-5` | Model for unattended runs |
| `GTM_RUN_TIMEOUT_MIN` | `90` | A run taking longer than this is stopped |
| `GTM_LOOP_NOTE` | – | Extra instructions for every run, e.g. `Only tier A and B today.` |

The scheduler entry is unique per checkout (`GTM Autopilot daily loop - <folder>` on Windows; a tagged cron line on macOS/Linux). That lets several clones run side by side.

## Storage and housekeeping

| Variable | Default | Description |
|---|---|---|
| `GTM_DB_PATH` | `data/gtm.db` | SQLite database. Created and migrated automatically |
| `GTM_REPORTS_DIR` | `reports/` | Daily briefs (`YYYY-MM-DD.md`) and run logs (`run-*.log`) |
| `GTM_BACKUP_DIR` | `data/backups/` | Database snapshots |
| `GTM_BACKUP_KEEP` | `14` | Snapshots kept. One is taken before every daily run. `0` disables them |
| `GTM_LOG_RETENTION_DAYS` | `30` | Run logs and briefs older than this are deleted |
| `GTM_ENV_FILE` | `.env` | *(set in the shell, not in .env)* Use another env file, e.g. one per client |

## Files you can edit besides `.env`

| File | What it controls |
|---|---|
| `data/playbook.md` | Tiering, routing, writing rules, signal sensitivity. Reload with `gtm playbook --reload`. The learning step also versions it |
| Seller profile (`gtm seller --set`) | Value proposition, proof points, CTA, tone, language, do-not-say |
| `.claude/skills/*/SKILL.md` | How the agent runs each stage (daily loop, classify, write, replies, learn) |
| `.claude/settings.json` | Which tools Claude Code may use without asking (approve / launch / cleanup always ask) |
| `src/pipeline/sequence.ts` → `lintSequence` | Lint rules: length, spam words, clichés, claims, channel plan |
| `src/pipeline/route.ts` | Hard routing rules |
