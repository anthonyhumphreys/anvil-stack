-- BILL-07 organizations for shared billing. Hosted organizations and
-- membership mirrors never own sync data; users retain their personal
-- billing_accounts and encrypted account mappings.

CREATE TABLE IF NOT EXISTS hosted_organizations (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  workos_organization_id TEXT UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('creating', 'active', 'failed', 'closed')),
  created_by_workos_user_id TEXT NOT NULL,
  create_lease_token TEXT,
  create_lease_until INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_hosted_organizations_status
  ON hosted_organizations (status, created_at);

CREATE TABLE IF NOT EXISTS hosted_organization_memberships (
  organization_id TEXT NOT NULL REFERENCES hosted_organizations(id),
  billing_account_id TEXT NOT NULL REFERENCES billing_accounts(id),
  workos_client_id TEXT NOT NULL,
  workos_user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  workos_membership_id TEXT UNIQUE,
  workos_sync_status TEXT NOT NULL DEFAULT 'synced' CHECK (workos_sync_status IN ('synced', 'pending')),
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  status TEXT NOT NULL CHECK (status IN ('active', 'inactive')),
  seat_opted_out INTEGER NOT NULL DEFAULT 0 CHECK (seat_opted_out IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (organization_id, workos_user_id)
);

CREATE INDEX IF NOT EXISTS idx_hosted_org_membership_user
  ON hosted_organization_memberships (billing_account_id, status, organization_id);

CREATE TABLE IF NOT EXISTS hosted_organization_invitations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES hosted_organizations(id),
  target_billing_account_id TEXT NOT NULL REFERENCES billing_accounts(id),
  target_workos_user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  invited_by_workos_user_id TEXT NOT NULL,
  workos_invitation_id TEXT UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('creating', 'pending', 'accepted', 'revoked', 'expired', 'failed')),
  workos_sync_status TEXT NOT NULL DEFAULT 'synced' CHECK (workos_sync_status IN ('synced', 'pending')),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_hosted_org_invitation_reconcile
  ON hosted_organization_invitations (state, updated_at);

CREATE INDEX IF NOT EXISTS idx_hosted_org_invitation_list
  ON hosted_organization_invitations (organization_id, state, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_hosted_org_invitation_pending_email
  ON hosted_organization_invitations (organization_id, email COLLATE NOCASE)
  WHERE state IN ('creating', 'pending');

CREATE TABLE IF NOT EXISTS hosted_team_seat_assignments (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES hosted_organizations(id),
  billing_account_id TEXT NOT NULL REFERENCES billing_accounts(id),
  invitation_id TEXT REFERENCES hosted_organization_invitations(id),
  state TEXT NOT NULL CHECK (state IN ('reserved', 'assigned', 'released')),
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_hosted_team_seats_org
  ON hosted_team_seat_assignments (organization_id, state, expires_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_hosted_team_seat_single_sponsor
  ON hosted_team_seat_assignments (billing_account_id)
  WHERE state IN ('reserved', 'assigned');

CREATE UNIQUE INDEX IF NOT EXISTS idx_hosted_team_seat_invitation
  ON hosted_team_seat_assignments (invitation_id)
  WHERE invitation_id IS NOT NULL AND state IN ('reserved', 'assigned');

CREATE TABLE IF NOT EXISTS hosted_workos_webhook_events (
  workos_event_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processed')),
  created_at INTEGER NOT NULL,
  processed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_hosted_workos_webhook_status
  ON hosted_workos_webhook_events (status, created_at);

-- A deliberately failing CHECK is a transaction guard for personal account
-- deletion. If the delete would remove the final active owner, D1 rolls back
-- the whole batch before any membership or seat is changed.
CREATE TABLE IF NOT EXISTS hosted_organization_delete_guard (
  denied INTEGER NOT NULL CHECK (denied = 0)
);
