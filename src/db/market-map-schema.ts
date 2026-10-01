export const MARKET_MAP_SCHEMA = `
CREATE TABLE IF NOT EXISTS candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id TEXT,
  name TEXT NOT NULL,
  linkedin_url TEXT,
  email TEXT,
  phone TEXT,
  headline TEXT,
  current_role TEXT,
  current_org TEXT,
  org_url TEXT,
  location TEXT,
  dedupe_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'RAW',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_candidates_state ON candidates(state);

CREATE TABLE IF NOT EXISTS source_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL REFERENCES candidates(id),
  source TEXT NOT NULL,
  source_lane_id TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  retrieved_at TEXT NOT NULL,
  raw_payload_json TEXT NOT NULL,
  project_hint TEXT,
  org_hint TEXT,
  evidence_json TEXT NOT NULL,
  UNIQUE(source, source_lane_id, source_record_id)
);
CREATE INDEX IF NOT EXISTS idx_observations_candidate ON source_observations(candidate_id);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id TEXT,
  candidate_id INTEGER NOT NULL REFERENCES candidates(id),
  name TEXT,
  url TEXT,
  description TEXT,
  kernel_primary TEXT,
  kernel_secondary TEXT,
  project_visibility TEXT NOT NULL,
  project_alignment TEXT NOT NULL,
  status TEXT,
  evidence_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_candidate ON projects(candidate_id);

CREATE TABLE IF NOT EXISTS boundary_qualifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_qualification_id TEXT,
  candidate_id INTEGER NOT NULL REFERENCES candidates(id),
  project_id INTEGER NOT NULL REFERENCES projects(id),
  boundary_version TEXT NOT NULL,
  boundary_status TEXT NOT NULL,
  project_real TEXT NOT NULL,
  strategic_authority TEXT NOT NULL,
  ambition TEXT NOT NULL,
  intrinsic_complexity TEXT NOT NULL,
  professional_project_visibility TEXT NOT NULL,
  kernel_primary TEXT,
  kernel_secondary TEXT,
  failed_gates_json TEXT NOT NULL,
  missing_evidence_json TEXT NOT NULL,
  evidence_summary TEXT NOT NULL,
  confidence TEXT NOT NULL,
  reasoning TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_boundary_candidate ON boundary_qualifications(candidate_id, project_id, created_at);

CREATE TABLE IF NOT EXISTS signal_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_signal_id TEXT,
  candidate_id INTEGER NOT NULL REFERENCES candidates(id),
  project_id INTEGER NOT NULL REFERENCES projects(id),
  signal_type TEXT NOT NULL,
  source TEXT NOT NULL,
  event_date TEXT,
  evidence TEXT NOT NULL,
  strength INTEGER,
  mentionability TEXT NOT NULL DEFAULT 'UNKNOWN',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activation_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL REFERENCES candidates(id),
  project_id INTEGER NOT NULL REFERENCES projects(id),
  boundary_qualification_id INTEGER NOT NULL REFERENCES boundary_qualifications(id),
  intent_strength INTEGER,
  freshness TEXT NOT NULL,
  priority_tier TEXT NOT NULL,
  route TEXT NOT NULL,
  angle TEXT NOT NULL,
  channel_plan_json TEXT,
  reasoning TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activation_candidate ON activation_scores(candidate_id, project_id, created_at);

CREATE TABLE IF NOT EXISTS candidate_sequences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL REFERENCES candidates(id),
  project_id INTEGER NOT NULL REFERENCES projects(id),
  activation_score_id INTEGER NOT NULL REFERENCES activation_scores(id),
  version INTEGER NOT NULL,
  status TEXT NOT NULL,
  route TEXT NOT NULL,
  angle TEXT NOT NULL,
  hook_type TEXT NOT NULL,
  steps_json TEXT NOT NULL,
  lint_json TEXT NOT NULL,
  critique TEXT,
  playbook_version INTEGER,
  review_status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_candidate_sequences ON candidate_sequences(candidate_id, project_id, version);
`;
