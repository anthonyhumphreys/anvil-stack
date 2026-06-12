CREATE TABLE IF NOT EXISTS policy_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  version text NOT NULL,
  config_json jsonb NOT NULL,
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS policy_configs_name_version_idx ON policy_configs(name, version);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS policy_configs_active_idx ON policy_configs(name, active);
