-- Trust Layer v0.3 — PostgreSQL-compatible canonical migration.
-- The local MVP uses a transactional in-memory adapter; this migration is the
-- deployable relational shape and deliberately stores no URL/body/token payload.
CREATE TABLE IF NOT EXISTS participants (
  participant_id uuid PRIMARY KEY,
  token_hash text UNIQUE NOT NULL,
  invite_origin_group text NOT NULL,
  issued_at timestamptz NOT NULL,
  mature_at timestamptz NOT NULL,
  stopped_at timestamptz,
  detail_consent boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS sites (
  domain text PRIMARY KEY,
  first_observed_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'insufficient',
  state_reason text NOT NULL DEFAULT 'insufficient_volume'
);
CREATE TABLE IF NOT EXISTS site_aggregates (
  domain text PRIMARY KEY REFERENCES sites(domain),
  aggregate_window text NOT NULL DEFAULT 'rolling_90d',
  support_weight numeric NOT NULL DEFAULT 0,
  rejection_weight numeric NOT NULL DEFAULT 0,
  insufficient_weight numeric NOT NULL DEFAULT 0,
  provenance_group_count integer NOT NULL DEFAULT 0,
  model_family_count integer NOT NULL DEFAULT 0,
  max_group_share numeric NOT NULL DEFAULT 0,
  evidence_coverage text NOT NULL DEFAULT 'none',
  verification_coverage text NOT NULL DEFAULT 'not_sampled',
  state text NOT NULL,
  state_reason text NOT NULL,
  secondary_state_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_observed_at timestamptz,
  last_evaluated_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS site_aggregate_daily_rollups (
  domain text NOT NULL REFERENCES sites(domain),
  observed_utc_date date NOT NULL,
  provenance_group_hash text NOT NULL,
  agent_model_family text NOT NULL,
  support_weight numeric NOT NULL DEFAULT 0,
  rejection_weight numeric NOT NULL DEFAULT 0,
  insufficient_weight numeric NOT NULL DEFAULT 0,
  minimal_count integer NOT NULL DEFAULT 0,
  manifest_count integer NOT NULL DEFAULT 0,
  correction_delta numeric NOT NULL DEFAULT 0,
  PRIMARY KEY (domain, observed_utc_date, provenance_group_hash, agent_model_family)
);
CREATE TABLE IF NOT EXISTS assessment_event_receipts (
  receipt_id text PRIMARY KEY,
  domain text NOT NULL REFERENCES sites(domain),
  outcome text NOT NULL,
  reason_code text NOT NULL,
  rubric_version text NOT NULL,
  token_hash text NOT NULL,
  provenance_group_hash text NOT NULL,
  agent_model_name text NOT NULL,
  agent_model_family text NOT NULL,
  applied_weight numeric NOT NULL,
  event_hmac text NOT NULL,
  observed_at timestamptz NOT NULL,
  research_id uuid NOT NULL
);
CREATE TABLE IF NOT EXISTS research_manifests (
  research_id uuid PRIMARY KEY,
  intent_category text NOT NULL,
  claim_scope_tags jsonb NOT NULL,
  sensitivity text NOT NULL,
  source_count_total integer NOT NULL,
  batch_count integer NOT NULL,
  batch_state text NOT NULL,
  first_accepted_at timestamptz NOT NULL,
  token_hash text NOT NULL,
  rubric_version text NOT NULL,
  collection_mode text NOT NULL,
  final_domain text,
  final_outcome text,
  final_reason_code text
);
CREATE TABLE IF NOT EXISTS source_decisions (
  research_id uuid NOT NULL REFERENCES research_manifests(research_id),
  source_ref text NOT NULL,
  domain text NOT NULL,
  url_scope text NOT NULL,
  canonical_url text,
  source_disposition text NOT NULL,
  reason_codes jsonb NOT NULL,
  related_source_refs jsonb NOT NULL,
  source_type text NOT NULL,
  published_date_precision text NOT NULL,
  PRIMARY KEY (research_id, source_ref),
  CHECK ((url_scope = 'canonical_url' AND canonical_url IS NOT NULL) OR (url_scope = 'domain_only' AND canonical_url IS NULL))
);
CREATE TABLE IF NOT EXISTS manifest_id_tombstones (
  research_id_hmac text PRIMARY KEY,
  tombstone_state text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS verification_jobs (
  attestation_id text PRIMARY KEY,
  domain text NOT NULL,
  selected_reason text NOT NULL,
  checked_source_refs jsonb NOT NULL,
  fixed_result text NOT NULL,
  counterevidence_state text NOT NULL,
  audit_case_id text,
  model_family text NOT NULL,
  completed_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS site_verification_daily_rollups (
  domain text NOT NULL REFERENCES sites(domain),
  completed_utc_date date NOT NULL,
  passed_count integer NOT NULL DEFAULT 0,
  inconclusive_count integer NOT NULL DEFAULT 0,
  hold_count integer NOT NULL DEFAULT 0,
  reason_band text,
  PRIMARY KEY (domain, completed_utc_date)
);
CREATE TABLE IF NOT EXISTS aggregate_corrections (
  correction_id bigserial PRIMARY KEY,
  domain text NOT NULL REFERENCES sites(domain),
  support_delta numeric NOT NULL DEFAULT 0,
  rejection_delta numeric NOT NULL DEFAULT 0,
  insufficient_delta numeric NOT NULL DEFAULT 0,
  reason text NOT NULL,
  signal_version text NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS domain_holds (
  hold_id bigserial PRIMARY KEY,
  domain text NOT NULL REFERENCES sites(domain),
  hold_state text NOT NULL,
  reason text NOT NULL,
  started_at timestamptz NOT NULL,
  signal_version text NOT NULL,
  evidence_ref text,
  release_role text NOT NULL,
  release_condition text NOT NULL,
  expires_at timestamptz,
  released_at timestamptz,
  released_by_role text
);
CREATE TABLE IF NOT EXISTS model_family_map (
  model_name text PRIMARY KEY,
  model_family text NOT NULL,
  map_version text NOT NULL,
  effective_from timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS model_calibration_aggregates (
  model_name text NOT NULL,
  model_family text NOT NULL,
  rubric_version text NOT NULL,
  period_start date NOT NULL,
  observation_count integer NOT NULL DEFAULT 0,
  result_band jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (model_name, rubric_version, period_start)
);

CREATE INDEX IF NOT EXISTS idx_receipts_domain_observed ON assessment_event_receipts(domain, observed_at);
CREATE INDEX IF NOT EXISTS idx_manifest_tombstones_expiry ON manifest_id_tombstones(expires_at);
CREATE INDEX IF NOT EXISTS idx_rollups_expiry ON site_aggregate_daily_rollups(observed_utc_date);
