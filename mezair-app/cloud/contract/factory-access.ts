/** Server-authorized organisation discovery and recipient-bound encrypted snapshots. */
export type OrganizationFactoryRole = 'viewer' | 'operator' | 'owner';
export interface OrganizationFactoryPolicy {
  organizationId: string;
  visibility: 'organization' | 'team' | 'restricted';
  teamId?: string;
  members: Array<{ userId: string; role: OrganizationFactoryRole }>;
}
export interface FactorySource {
  host: 'github.com';
  owner: string;
  repo: string;
}
export interface FactoryKeyWrap {
  ephemeral: string;
  nonce: string;
  tag: string;
  ciphertext: string;
  publicKey: string;
}
export interface SealedFactorySnapshot {
  nonce: string;
  tag: string;
  ciphertext: string;
  keys: Record<string, FactoryKeyWrap>;
}
export interface FactoryDirectoryEntry {
  id: string;
  revision: number;
  registryVersion?: number;
  definitionDigest?: string;
  policy: OrganizationFactoryPolicy;
  source?: FactorySource;
  role: OrganizationFactoryRole;
  organizationAdmin: boolean;
  executionOwner: boolean;
  ownerId?: string;
  snapshot: SealedFactorySnapshot | null;
  status?: 'draft' | 'active' | 'paused' | 'inactive';
  activeRevision?: number;
  activatedAt?: string | null;
  accessPending: boolean;
  accessRequired?: boolean;
  updatedAt?: number;
}
export type FactoryOrganizationCommandAction =
  'pause' | 'resume' | 'deactivate' | 'cancel' | 'retry' | 'approve-merge' | 'takeover';
export interface FactoryOrganizationCommand {
  id: string;
  factoryId: string;
  runId?: string;
  action: FactoryOrganizationCommandAction;
  expectedHeadSha?: string;
  actorId: string;
  createdAt: string;
}
export const FACTORY_ORG_OPERATIONS = [
  'factory.organizations',
  'factory.source.check',
  'factory.issue.claim',
  'factory.key.register',
  'factory.members',
  'factory.registry.upsert',
  'factory.registry.list',
  'factory.registry.read',
  'factory.registry.authorize',
  'factory.snapshot.publish',
  'factory.snapshot.rewrap',
  'factory.run.list',
  'factory.run.read',
  'factory.command.send',
  'factory.command.take',
  'factory.command.complete',
] as const;
