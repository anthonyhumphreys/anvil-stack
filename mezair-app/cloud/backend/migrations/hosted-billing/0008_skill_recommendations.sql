CREATE TABLE hosted_skill_recommendations (
  organization_id TEXT PRIMARY KEY REFERENCES hosted_organizations(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  sources_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
