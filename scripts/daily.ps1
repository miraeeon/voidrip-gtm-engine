# VOIDRIP GTM Engine — daily run (Windows). Thin wrapper around the cross-platform runner:
#   lock → DB backup → housekeeping → agent (/gtm-daily-loop, approve/launch disallowed) → report
# Schedule it with:  npm run schedule      (uses GTM_SCHEDULE_TIME / GTM_SCHEDULE_DAYS from .env)
param([string]$Note = '')
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
if ($Note) { node bin/gtm.mjs daily --note $Note } else { node bin/gtm.mjs daily }
exit $LASTEXITCODE
