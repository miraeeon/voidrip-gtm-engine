#!/usr/bin/env bash
# VOIDRIP GTM Engine — daily run (macOS / Linux). Thin wrapper around the cross-platform runner:
#   lock → DB backup → housekeeping → agent (/gtm-daily-loop, approve/launch disallowed) → report
# Schedule it with:  npm run schedule      (installs a cron entry from GTM_SCHEDULE_* in .env)
set -euo pipefail
cd "$(dirname "$0")/.."
if [ $# -gt 0 ]; then exec node bin/gtm.mjs daily --note "$*"; else exec node bin/gtm.mjs daily; fi
