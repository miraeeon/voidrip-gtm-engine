# Getting started: clone to first daily loop

This guide takes you from nothing to a working, scheduled GTM loop on your own machine. It takes about 15 minutes. Every command is shown for **Windows (PowerShell)** and **macOS / Linux (bash)** where they differ.

> **What you'll have at the end:**
> - A local copy of GTM Autopilot with its own database.
> - Your company onboarded in Max.
> - Claude Code connected through MCP.
> - The first batch of lead-specific sequences drafted into Overloop, still switched off and waiting for your review.
> - A weekday schedule that repeats all of this every morning.

---

## 0. What you need

| | Why | How to check / get it |
|---|---|---|
| **Node.js 22.13 or newer** | Runs the engine. The built-in SQLite means no database server to install | `node -v` · download from [nodejs.org](https://nodejs.org) (LTS) |
| **Git** | To clone the repo | `git --version` |
| **Max account** ([yourmax.ai](https://yourmax.ai)) **with an active plan** | Finds in-market leads from buying signals | [app.yourmax.ai/signup](https://app.yourmax.ai/signup). Signals can only be switched on with an active plan |
| **Max API key** | | Max → *Settings → API Keys* |
| **Overloop account** ([overloop.com](https://overloop.com)) with at least one connected sending address | Runs the email + LinkedIn outreach | Overloop → *Settings → Sending addresses* |
| **Overloop API key** | | Overloop → *Settings → API Keys* |
| **Claude Code** (recommended) or another MCP-capable agent | The brain: classification, routing, writing, reply triage, learning | `npm i -g @anthropic-ai/claude-code`, then run `claude` once to log in |

You do **not** need an Anthropic or OpenAI API key. The agent you're logged into is the brain.

---

## 1. Clone and install

```bash
git clone https://github.com/<you>/gtm-autopilot.git
cd gtm-autopilot
npm ci                 # installs exact versions from package-lock.json
```

---

## 2. Run the setup wizard

```bash
npm run setup
```

The wizard is safe to re-run at any time. Press **Enter** to keep a current value.

| Step | What happens |
|---|---|
| 1. Node.js | Verifies Node ≥ 22.13 |
| 2. Environment file | Creates `.env` from `.env.example` if it doesn't exist |
| 3. API keys | Asks for your Max and Overloop keys and **tests both live** |
| 4. Your company | Lists your Max businesses. Type an id, **or type your website** (e.g. `acme.com`) and Max analyses it and builds your ICP |
| 5. Database | Creates `data/gtm.db` with every table and seeds playbook v1. **No manual database setup is needed.** Schema upgrades also run automatically on every start |
| 6. Seller profile | Your value proposition, proof points and call to action. Proof points are the **only numbers** the agent may use in outreach |
| 7. Schedule and volume | Time and days for the daily run, plus daily caps |
| 8. Install schedule | Registers the daily run in Windows Task Scheduler or cron |
| 9. Health check | Node, database, agent CLI |

Non-interactive (for CI or scripts): put the keys and `MAX_BUSINESS_ID` in `.env`, then run `node bin/gtm.mjs wizard --yes`.

---

## 3. Check everything is green

```bash
npm run doctor
```

What to look for:
- `max.ok: true`, and `active_subscriptions` greater than 0. If it's 0, see step 4.
- `overloop.ok: true`, and `working_senders` greater than 0.
- `system.database.ok`, `system.agent_cli.ok` and `system.schedule.installed`.
- `send_mode: "locked"`. Leave it that way until you've reviewed your first sequences.

---

## 4. Choose your buying signals

Signals decide *who* shows up each morning. See what's available and what you have:

```bash
node bin/gtm.mjs setup            # ICP, subscriptions, every signal with its config schema
```

Subscribe to the ones that fit. Some good starters:

```bash
# People asking for what you sell (these can be mentioned in the first line)
node bin/gtm.mjs subscribe social-mentions --name "Asking for recommendations" \
  --config '{"keywords":["recommend a tool for X","looking for X"],"posted_limit":"P1W"}'

# Decision makers who just changed jobs
node bin/gtm.mjs subscribe job-changes --name "New leaders"

# Top up with plain ICP matches when other signals are quiet
node bin/gtm.mjs subscribe atlas-icp --name "ICP matches"
```

> **PowerShell tip:** inside single-quoted JSON, escape the double quotes: `--config '{\"keywords\":[\"looking for X\"]}'`. Or put the JSON in a file and use `--config (Get-Content cfg.json -Raw)`.

Signals are monitored asynchronously. New subscriptions usually start delivering leads within hours.

---

## 5. Tell the agent about your company

The wizard asked for the basics. You can refine them any time:

```bash
node bin/gtm.mjs seller --set '{
  "value_proposition": "One sentence on what you do and for whom.",
  "proof_points": ["Used by 300+ agencies", "Setup in 1 day"],
  "primary_cta": "15-minute walkthrough",
  "tone": "friendly, direct, no hype",
  "language": "English; French for FR/BE leads",
  "do_not_say": ["guaranteed", "cheapest"]
}'
```

Then read the rules the agent writes by: `node bin/gtm.mjs playbook`. To change them, edit `data/playbook.md` and run `node bin/gtm.mjs playbook --reload`.

---

## 6. Run your first loop, watching it

Open the folder in Claude Code:

```bash
claude
```

Claude Code loads the MCP server (`.mcp.json`), the skills (`.claude/skills`) and the permissions (`.claude/settings.json`) automatically. Type:

```
/gtm-daily-loop
```

You'll watch the agent work through each stage:
1. **Health check.**
2. **Replies:** new ones are detected and triaged.
3. **Learning:** from yesterday's results.
4. **Sourcing:** new Max leads are pulled and checked against your Overloop history.
5. **Classify and route:** each lead gets a tier and a channel plan.
6. **Write:** one sequence per lead, self-critiqued and linted.
7. **Push:** the sequences go to Overloop as **switched-off draft campaigns**.
8. **Brief:** the daily summary is written.

Prefer the terminal only? Run `npm run daily`. That's the same loop, unattended, with a log in `reports/`.

---

## 7. Review what it wrote

```bash
node bin/gtm.mjs report     # today's brief (also saved in reports/YYYY-MM-DD.md)
node bin/gtm.mjs review     # every drafted campaign with its literal copy + Overloop link
```

Every campaign is also visible in Overloop, named `[GTM-BOT] <date> · <person> @ <company> · <route>`.

Nothing is sent: the campaigns are `off`, set to manual enrollment only, with auto-send disabled and nobody enrolled.

---

## 8. Replies

When prospects answer (once you're live), each morning's run detects the reply. The agent then:
- gets the text, either from your mailbox connector (for example Gmail in Claude) or by asking you to paste it;
- classifies it and drafts an answer;
- stops the sequence, excludes anyone who unsubscribed, and assigns hot replies to you.

```bash
node bin/gtm.mjs replies                                   # hot first, with drafted answers
node bin/gtm.mjs reply-add --lead 1234 --text "…"          # paste a reply the agent couldn't fetch
node bin/gtm.mjs resolve 7 --meeting                       # you handled it (and booked a meeting)
```

The bot never sends answers. You send them from Overloop or your inbox.

---

## 9. Going live (when you're happy with the drafts)

1. Read at least 20 sequences with `gtm review`. Tune the seller profile and playbook until they sound like you.
2. In `.env`, set `SEND_MODE=live`.
3. Approve specific campaigns: `node bin/gtm.mjs approve 1234 5678` (`--revoke` to undo).
4. Send them: `node bin/gtm.mjs launch 1234 5678 --confirm SEND`.

Launch re-checks every prospect for replies, bounces and exclusion before enrolling. **Scheduled runs can never approve or launch.** Sending always takes a human.

---

## 10. Daily operation

| Want to… | Command |
|---|---|
| See the schedule | `node bin/gtm.mjs schedule status` |
| Change time or days | edit `GTM_SCHEDULE_TIME` / `GTM_SCHEDULE_DAYS` in `.env`, then `npm run schedule` |
| Pause the automation | `npm run unschedule` |
| Run now, unattended | `npm run daily` |
| Check health | `npm run doctor` |
| Back up the database | `npm run backup` (also automatic before every daily run) |

Everything else (backups, restore, logs, upgrades, running several companies) is in **[OPERATIONS.md](OPERATIONS.md)**. Every setting is in **[CONFIGURATION.md](CONFIGURATION.md)**.
