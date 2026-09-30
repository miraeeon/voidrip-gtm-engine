# GTM Autopilot — instructions for Codex and other coding agents

Read `CLAUDE.md` first. The same rules apply to every agent.

Setup for Codex:
```bash
codex mcp add gtm-autopilot -- node bin/gtm-mcp.mjs
```

To run the daily loop, follow `.claude/skills/gtm-daily-loop/SKILL.md` step by step with the `gtm_*` tools. The sub-steps are in:
- `.claude/skills/gtm-classify-route/SKILL.md`
- `.claude/skills/gtm-write-sequence/SKILL.md`
- `.claude/skills/gtm-learn/SKILL.md`

Without MCP, every tool is available from the shell:
```bash
node bin/gtm.mjs tools                       # list
node bin/gtm.mjs tool gtm_status             # call with no args
node bin/gtm.mjs tool gtm_get_drafting_queue '{"limit":5}'
```

Safety: `SEND_MODE=locked` is the default. Enrollment, activation and auto-send are blocked in code. Never try to work around this.

Architecture:
- `src/adapters/source.ts` and `src/adapters/execution.ts` are the stable provider ports.
- Provider clients are implementation details and may only be imported by their adapter or composition boundary.
- Core modules under `src/pipeline/` must depend on adapter contracts, never on Max, Overloop or another provider client.
