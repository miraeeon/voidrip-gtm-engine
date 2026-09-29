# Kept for convenience — the scheduler is built into the CLI (works on Windows, macOS and Linux):
#   npm run schedule                 # install / update from GTM_SCHEDULE_TIME + GTM_SCHEDULE_DAYS in .env
#   node bin/gtm.mjs schedule status
#   node bin/gtm.mjs schedule remove
param([switch]$Remove)
Set-Location (Split-Path -Parent $PSScriptRoot)
if ($Remove) { node bin/gtm.mjs schedule remove } else { node bin/gtm.mjs schedule install }
