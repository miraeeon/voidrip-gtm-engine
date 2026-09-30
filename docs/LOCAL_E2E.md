# LOCAL E2E V1

Phase 9 validates the VOIDRIP pipeline without a live source or execution provider:

`CSV/JSON → Market Map → Person + Project → Boundary → priority → local draft → human review`

Nothing is pushed or sent.

## Import contract

Required fields:

- `source_record_id`
- `person_name`

Identity fields include `professional_profile_url`, `email`, `phone`, `headline`, `current_role`, `current_org`, `org_url` and `location`.

Visible project hints include `project_name_if_visible`, `project_url_if_visible` and `project_description_if_visible`. `evidence` is an array in JSON or a pipe-separated value in CSV. Unknown optional values may be omitted.

```bash
node bin/gtm.mjs import examples/candidates.sample.csv --lane M-A --source manual-calibration
```

The import deduplicates the person but never overwrites provenance: each source record becomes a `source_observation`.

## Codex workflow

Ask Codex to use the `gtm-local-e2e` skill. The workflow stops at `gtm_get_market_review_queue`; HeyReach begins only in Phase 10.

The legacy Max/Overloop pipeline remains readable and operational during the additive migration. `candidate_sequences` is the isolated Phase 9 local-draft store; converging it with the legacy `sequences` table requires a separately approved data migration.
