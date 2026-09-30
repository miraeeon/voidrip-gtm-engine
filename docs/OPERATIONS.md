# Operations runbook

## The daily run

`npm run daily` (and the scheduled task) runs `node bin/gtm.mjs daily`, which works in this order:

1. **Lock.** It takes `data/.daily.lock`, so two runs never overlap. A stale lock (older than the timeout) is taken over automatically.
2. **Backup.** A consistent SQLite snapshot goes to `data/backups/gtm-YYYYMMDD-HHMM.db`, keeping the newest `GTM_BACKUP_KEEP`.
3. **Housekeeping.** Logs and briefs older than `GTM_LOG_RETENTION_DAYS` are deleted.
4. **Agent.** It starts `GTM_AGENT_CMD` headless with `/gtm-daily-loop`. **These tools are disallowed on the command line:** approve, launch, cleanup, simulate, subscription and ICP changes, shell, and file writes. An unattended run can only draft, push inert campaigns, triage replies, learn and report.
5. **Report.** `reports/YYYY-MM-DD.md` is always written, even if the agent failed partway through.
6. **Log.** Output goes to `reports/run-YYYYMMDD-HHMM.log`, and a summary row goes to the `runs` table.

Useful variants:
```bash
node bin/gtm.mjs daily --dry-run                 # everything except starting the agent
node bin/gtm.mjs daily --note "Only tier A today"
```

## Scheduling

```bash
npm run schedule                    # install / update from GTM_SCHEDULE_TIME + GTM_SCHEDULE_DAYS
node bin/gtm.mjs schedule status    # installed? next run?
npm run unschedule                  # remove
```

- **Windows:** Task Scheduler task `VOIDRIP GTM daily loop - <folder>`. The PC must be on and you must be logged in at run time. The task starts late if the machine was asleep.
- **macOS / Linux:** a cron line tagged `# voidrip-gtm-engine:<path>`. It logs to `reports/cron.log`. On macOS, give your terminal Full Disk Access if cron can't read the folder.
- **Codex app:** use a heartbeat or recurring automation when you want the thread itself to coordinate the run. Keep `SEND_MODE=locked` during calibration.

The Codex CLI must be logged in for the scheduled user. Run `codex` once interactively.

## Health

```bash
npm run doctor
```
It checks:
- the Max and Overloop connections;
- the business and active signals;
- sending addresses;
- send mode;
- the Node version;
- the database;
- the agent CLI;
- the schedule and its next run;
- caps, sending window and the last daily run.

## Backups and restore

```bash
npm run backup                                   # snapshot now
# restore: stop the schedule, then copy a snapshot over the live DB
npm run unschedule
cp data/backups/gtm-20260928-0800.db data/gtm.db      # PowerShell: Copy-Item …
npm run schedule
```

## Upgrading

```bash
git pull
npm ci
npm run check        # typecheck + tests + MCP smoke test
```
Database migrations run automatically on the next command. They only ever add columns or tables.

## Several companies or clients on one machine

Give each one its own checkout, **or** its own env file and database:
```bash
# clients/acme.env contains its own keys, MAX_BUSINESS_ID, GTM_DB_PATH=./data/acme.db, GTM_REPORTS_DIR=./reports/acme
GTM_ENV_FILE=clients/acme.env node bin/gtm.mjs doctor
```
Separate checkouts are the simplest option, because each gets its own schedule entry automatically.

## Cleaning up test campaigns

```bash
node bin/gtm.mjs cleanup          # dry run: lists bot campaigns (by OVERLOOP_NAME_PREFIX)
node bin/gtm.mjs cleanup --yes    # deletes them, plus the prospects the bot created
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Invalid configuration … MAX_API_KEY missing` | Run `npm run setup`, or fill in `.env` |
| `MAX_BUSINESS_ID is not set` | `npm run setup`, or `gtm init --website acme.com` |
| Max `422 Active can only be enabled once your subscription is active` | The Max business has no active plan. Activate it in the Max app |
| Overloop `Your API key is wrong` | Use the raw key (no `Bearer`), with no quotes or spaces in `.env` |
| `No new leads from Max` | Signals are asynchronous. Check `gtm setup` for active subscriptions and add `atlas-icp` to top up |
| Daily run `agent_failed`, exit 127 | The agent CLI isn't on PATH for the scheduler. Set `GTM_AGENT_CMD` to its full path |
| Daily run `skipped: lock held` | Another run is in progress. A stale lock clears itself after `GTM_RUN_TIMEOUT_MIN` + 10 minutes |
| Replies show "text not yet fetched" | Connect an authorized mailbox connector, or paste the text: `gtm reply-add --lead <id> --text "…"` |
| Garbled accents in logs (Windows) | Use `npm run daily`. The runner writes UTF-8 |
