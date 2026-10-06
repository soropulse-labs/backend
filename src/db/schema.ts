import { sql } from 'drizzle-orm';
import { bigint, boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

const id = () => uuid('id').primaryKey().defaultRandom();
const time = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const users = pgTable('users', {
  id: id(), githubId: text('github_id').notNull().unique(), login: text('login').notNull(),
  createdAt: time('created_at').notNull().defaultNow(),
});

export const sessions = pgTable('sessions', {
  id: id(), userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(), csrfHash: text('csrf_hash').notNull(),
  expiresAt: time('expires_at').notNull(), revokedAt: time('revoked_at'),
});

export const oauthStates = pgTable('oauth_states', {
  stateHash: text('state_hash').primaryKey(), codeVerifierCipher: text('code_verifier_cipher').notNull(),
  expiresAt: time('expires_at').notNull(), createdAt: time('created_at').notNull().defaultNow(),
});

export const projects = pgTable('projects', {
  id: id(), ownerId: uuid('owner_id').notNull().references(() => users.id),
  name: text('name').notNull(), createdAt: time('created_at').notNull().defaultNow(),
}, (t) => [index('projects_owner_idx').on(t.ownerId)]);

export const environments = pgTable('environments', {
  id: id(), projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(), network: text('network').notNull().default('testnet'),
  epoch: text('epoch').notNull(), rpcUrl: text('rpc_url').notNull(),
  networkPassphrase: text('network_passphrase').notNull(), active: boolean('active').notNull().default(true),
  createdAt: time('created_at').notNull().defaultNow(),
}, (t) => [uniqueIndex('env_project_name_idx').on(t.projectId, t.name), index('env_epoch_idx').on(t.network, t.epoch)]);

export const apiKeys = pgTable('api_keys', {
  id: id(), projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  environmentId: uuid('environment_id').references(() => environments.id, { onDelete: 'cascade' }),
  name: text('name').notNull(), tokenHash: text('token_hash').notNull().unique(),
  scopes: text('scopes').array().notNull(), createdAt: time('created_at').notNull().defaultNow(),
  revokedAt: time('revoked_at'),
});

export const endpoints = pgTable('endpoints', {
  id: id(), environmentId: uuid('environment_id').notNull().references(() => environments.id, { onDelete: 'cascade' }),
  name: text('name').notNull(), activeVersionId: uuid('active_version_id'),
  disabledAt: time('disabled_at'), createdAt: time('created_at').notNull().defaultNow(),
}, (t) => [index('endpoints_env_idx').on(t.environmentId)]);

export const endpointVersions = pgTable('endpoint_versions', {
  id: id(), endpointId: uuid('endpoint_id').notNull().references(() => endpoints.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(), url: text('url').notNull(),
  signingSecretCipher: text('signing_secret_cipher').notNull(), signingKeyId: text('signing_key_id').notNull(),
  verifiedAt: time('verified_at'), createdAt: time('created_at').notNull().defaultNow(),
}, (t) => [uniqueIndex('endpoint_version_idx').on(t.endpointId, t.version)]);

export const subscriptions = pgTable('subscriptions', {
  id: id(), environmentId: uuid('environment_id').notNull().references(() => environments.id, { onDelete: 'cascade' }),
  endpointId: uuid('endpoint_id').notNull().references(() => endpoints.id),
  contractId: text('contract_id').notNull(), topic0Xdr: text('topic0_xdr'),
  decoder: text('decoder'),
  startLedger: bigint('start_ledger', { mode: 'number' }).notNull(), active: boolean('active').notNull().default(true),
  createdAt: time('created_at').notNull().defaultNow(),
}, (t) => [index('subscriptions_env_idx').on(t.environmentId)]);

export const streams = pgTable('ingestion_streams', {
  id: id(), subscriptionId: uuid('subscription_id').notNull().unique().references(() => subscriptions.id, { onDelete: 'cascade' }),
  nextLedger: bigint('next_ledger', { mode: 'number' }).notNull(),
  leaseToken: uuid('lease_token'), leaseUntil: time('lease_until'),
  lastError: text('last_error'), updatedAt: time('updated_at').notNull().defaultNow(),
});

export const capturedEvents = pgTable('captured_events', {
  id: id(), environmentId: uuid('environment_id').notNull().references(() => environments.id),
  network: text('network').notNull(), epoch: text('epoch').notNull(),
  contractId: text('contract_id').notNull(), rpcEventId: text('rpc_event_id').notNull(),
  txHash: text('tx_hash').notNull(), ledger: bigint('ledger', { mode: 'number' }).notNull(),
  ledgerClosedAt: time('ledger_closed_at'), topicXdr: text('topic_xdr').array().notNull(),
  valueXdr: text('value_xdr').notNull(), decoded: jsonb('decoded'),
  decoder: text('decoder'), decodeError: text('decode_error'),
  capturedAt: time('captured_at').notNull().defaultNow(),
}, (t) => [
  uniqueIndex('events_identity_idx').on(t.network, t.epoch, t.contractId, t.rpcEventId),
  index('events_env_ledger_idx').on(t.environmentId, t.ledger),
  index('events_env_tx_idx').on(t.environmentId, t.txHash),
]);

export const deliveries = pgTable('deliveries', {
  id: id(), eventId: uuid('event_id').notNull().references(() => capturedEvents.id),
  subscriptionId: uuid('subscription_id').notNull().references(() => subscriptions.id),
  endpointVersionId: uuid('endpoint_version_id').notNull().references(() => endpointVersions.id),
  status: text('status').notNull().default('queued'), attemptCount: integer('attempt_count').notNull().default(0),
  nextAttemptAt: time('next_attempt_at').notNull().defaultNow(), leaseToken: uuid('lease_token'),
  leaseUntil: time('lease_until'), attemptStartedAt: time('attempt_started_at'), replayPlanId: uuid('replay_plan_id'),
  acknowledgedAt: time('acknowledged_at'), createdAt: time('created_at').notNull().defaultNow(),
}, (t) => [
  uniqueIndex('delivery_initial_idx').on(t.eventId, t.subscriptionId).where(sql`${t.replayPlanId} IS NULL`),
  uniqueIndex('delivery_replay_idx').on(t.replayPlanId, t.eventId, t.subscriptionId).where(sql`${t.replayPlanId} IS NOT NULL`),
  index('delivery_queue_idx').on(t.status, t.nextAttemptAt),
]);

export const deliveryAttempts = pgTable('delivery_attempts', {
  id: id(), deliveryId: uuid('delivery_id').notNull().references(() => deliveries.id),
  attemptNumber: integer('attempt_number').notNull(), startedAt: time('started_at').notNull(),
  completedAt: time('completed_at').notNull(), durationMs: integer('duration_ms').notNull(),
  httpStatus: integer('http_status'), failureClass: text('failure_class'),
  responsePreview: text('response_preview'),
}, (t) => [uniqueIndex('attempt_number_idx').on(t.deliveryId, t.attemptNumber)]);

export const consumers = pgTable('consumers', {
  id: id(), environmentId: uuid('environment_id').notNull().references(() => environments.id, { onDelete: 'cascade' }),
  name: text('name').notNull(), createdAt: time('created_at').notNull().defaultNow(),
});

export const consumerCredentials = pgTable('consumer_credentials', {
  id: id(), consumerId: uuid('consumer_id').notNull().references(() => consumers.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(), createdAt: time('created_at').notNull().defaultNow(),
  revokedAt: time('revoked_at'),
});

export const processingReceipts = pgTable('processing_receipts', {
  id: id(), receiptId: text('receipt_id').notNull(), environmentId: uuid('environment_id').notNull().references(() => environments.id),
  consumerId: uuid('consumer_id').notNull().references(() => consumers.id),
  deliveryId: uuid('delivery_id').notNull().references(() => deliveries.id),
  eventId: uuid('event_id').notNull().references(() => capturedEvents.id),
  processingRunId: text('processing_run_id').notNull(), sequence: integer('sequence').notNull(),
  status: text('status').notNull(), observedAt: time('observed_at').notNull(),
  error: text('error'), businessReference: text('business_reference'),
  bodyHash: text('body_hash').notNull(), receivedAt: time('received_at').notNull().defaultNow(),
}, (t) => [
  uniqueIndex('receipt_identity_idx').on(t.consumerId, t.receiptId),
  uniqueIndex('receipt_run_sequence_idx').on(t.consumerId, t.deliveryId, t.processingRunId, t.sequence),
  index('receipt_delivery_idx').on(t.deliveryId, t.receivedAt),
]);

export const replayPlans = pgTable('replay_plans', {
  id: id(), environmentId: uuid('environment_id').notNull().references(() => environments.id),
  endpointVersionId: uuid('endpoint_version_id').notNull().references(() => endpointVersions.id),
  createdBy: uuid('created_by').notNull().references(() => users.id),
  reason: text('reason').notNull(), criteria: jsonb('criteria').notNull(), digest: text('digest').notNull(),
  expiresAt: time('expires_at').notNull(), status: text('status').notNull().default('previewed'),
  createdAt: time('created_at').notNull().defaultNow(), executedAt: time('executed_at'),
});

export const replayItems = pgTable('replay_items', {
  planId: uuid('plan_id').notNull().references(() => replayPlans.id),
  eventId: uuid('event_id').notNull().references(() => capturedEvents.id),
  subscriptionId: uuid('subscription_id').notNull().references(() => subscriptions.id),
  eligibility: text('eligibility').notNull(), reason: text('reason'),
}, (t) => [uniqueIndex('replay_item_idx').on(t.planId, t.eventId, t.subscriptionId)]);

export const coverageIncidents = pgTable('coverage_incidents', {
  id: id(), environmentId: uuid('environment_id').notNull().references(() => environments.id),
  subscriptionId: uuid('subscription_id').references(() => subscriptions.id),
  kind: text('kind').notNull(), status: text('status').notNull().default('open'),
  fromLedger: bigint('from_ledger', { mode: 'number' }), toLedger: bigint('to_ledger', { mode: 'number' }),
  evidence: jsonb('evidence').notNull(), createdAt: time('created_at').notNull().defaultNow(),
  resolvedAt: time('resolved_at'),
});

export const auditRecords = pgTable('audit_records', {
  id: id(), actorId: uuid('actor_id').references(() => users.id), projectId: uuid('project_id').references(() => projects.id),
  action: text('action').notNull(), detail: jsonb('detail').notNull(), createdAt: time('created_at').notNull().defaultNow(),
});

export const labSessions = pgTable('lab_sessions', {
  id: id(), environmentId: uuid('environment_id').notNull().references(() => environments.id),
  ownerId: uuid('owner_id').notNull().references(() => users.id), scenario: text('scenario').notNull(),
  budget: integer('budget').notNull(), used: integer('used').notNull().default(0),
  expiresAt: time('expires_at').notNull(), createdAt: time('created_at').notNull().defaultNow(),
});
