CREATE TABLE IF NOT EXISTS packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  scope text,
  upstream_registry text NOT NULL DEFAULT 'npmjs',
  metadata_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS package_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id uuid NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  package_name text NOT NULL,
  version text NOT NULL,
  published_at timestamptz,
  tarball_url text,
  integrity text,
  shasum text,
  weekly_downloads integer,
  cached_tarball_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(package_name, version)
);

CREATE TABLE IF NOT EXISTS analysis_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  package_name text NOT NULL,
  version text NOT NULL,
  analyser_version text NOT NULL,
  policy_version text NOT NULL,
  report_identity_key text NOT NULL DEFAULT '||',
  tarball_integrity text,
  tarball_shasum text,
  status text NOT NULL DEFAULT 'complete',
  score integer NOT NULL,
  signals_json jsonb NOT NULL,
  manifest_diff_json jsonb,
  dependency_diff_json jsonb,
  file_diff_json jsonb,
  report_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE analysis_reports ADD COLUMN IF NOT EXISTS report_identity_key text NOT NULL DEFAULT '||';
ALTER TABLE analysis_reports ADD COLUMN IF NOT EXISTS tarball_integrity text;
ALTER TABLE analysis_reports ADD COLUMN IF NOT EXISTS tarball_shasum text;
UPDATE analysis_reports SET report_identity_key = id::text WHERE report_identity_key = '||';

CREATE INDEX IF NOT EXISTS analysis_reports_lookup_idx ON analysis_reports(package_name, version);
CREATE INDEX IF NOT EXISTS analysis_reports_version_idx ON analysis_reports(analyser_version, policy_version);
CREATE UNIQUE INDEX IF NOT EXISTS analysis_reports_identity_idx ON analysis_reports(package_name, version, policy_version, report_identity_key);

CREATE TABLE IF NOT EXISTS llm_risk_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  package_name text NOT NULL,
  version text NOT NULL,
  tarball_integrity text,
  tarball_shasum text,
  analyser_version text,
  provider text NOT NULL,
  model text NOT NULL,
  risk_level text NOT NULL,
  confidence text NOT NULL,
  review_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE llm_risk_reviews ADD COLUMN IF NOT EXISTS tarball_integrity text;
ALTER TABLE llm_risk_reviews ADD COLUMN IF NOT EXISTS tarball_shasum text;
ALTER TABLE llm_risk_reviews ADD COLUMN IF NOT EXISTS analyser_version text;

CREATE INDEX IF NOT EXISTS llm_risk_reviews_lookup_idx ON llm_risk_reviews(package_name, version);
CREATE INDEX IF NOT EXISTS llm_risk_reviews_identity_idx ON llm_risk_reviews(package_name, version, tarball_integrity, tarball_shasum, analyser_version);
CREATE INDEX IF NOT EXISTS llm_risk_reviews_provider_idx ON llm_risk_reviews(provider, model);

CREATE TABLE IF NOT EXISTS node_base_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL,
  project_name text,
  report_type text NOT NULL,
  summary_json jsonb,
  report_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS node_base_reports_created_idx ON node_base_reports(created_at);
CREATE INDEX IF NOT EXISTS node_base_reports_type_idx ON node_base_reports(report_type);

CREATE TABLE IF NOT EXISTS policy_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  package_name text NOT NULL,
  version text NOT NULL,
  action text NOT NULL,
  score integer NOT NULL,
  reasons_json jsonb NOT NULL,
  explanation text NOT NULL,
  policy_version text NOT NULL,
  decision_identity_key text NOT NULL DEFAULT '||',
  tarball_integrity text,
  tarball_shasum text,
  analyser_version text,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(package_name, version, policy_version, decision_identity_key)
);

ALTER TABLE policy_decisions ADD COLUMN IF NOT EXISTS decision_identity_key text NOT NULL DEFAULT '||';
ALTER TABLE policy_decisions ADD COLUMN IF NOT EXISTS tarball_integrity text;
ALTER TABLE policy_decisions ADD COLUMN IF NOT EXISTS tarball_shasum text;
ALTER TABLE policy_decisions ADD COLUMN IF NOT EXISTS analyser_version text;
UPDATE policy_decisions SET decision_identity_key = id::text WHERE decision_identity_key = '||';

CREATE INDEX IF NOT EXISTS policy_decisions_package_version_idx ON policy_decisions(package_name, version, policy_version);

CREATE TABLE IF NOT EXISTS overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  package_name text NOT NULL,
  version text,
  action text NOT NULL,
  reason text NOT NULL,
  requested_by text,
  approved_by text,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS overrides_lookup_idx ON overrides(package_name, version);

CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor text,
  event_type text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  metadata_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS policy_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  version text NOT NULL,
  config_json jsonb NOT NULL,
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS policy_configs_name_version_idx ON policy_configs(name, version);
CREATE INDEX IF NOT EXISTS policy_configs_active_idx ON policy_configs(name, active);
