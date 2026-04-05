/**
 * DBOS runtime initialization for the harness.
 *
 * Plan v3 Phase 1b: durable workflows. DBOS persists workflow state to
 * Postgres (in a separate `dbos` schema alongside our own tables in the
 * same database) so decision sessions can survive process crashes.
 *
 * On launch(), DBOS:
 *   1. Runs its internal migrations into the `dbos` schema
 *   2. Calls recoverPendingWorkflows for this executor ID — any workflow
 *      that was in-flight during a previous crash resumes from the last
 *      completed step.
 *
 * Plan v3 reference: Phase 1b. The idempotency primitive we rely on is
 * DBOS's dedupe-on-duplicate-workflowID behavior (same ID + same function =
 * return existing handle, different ID + different function = throw).
 */

import { DBOS } from '@dbos-inc/dbos-sdk';
import type { ScenarioConfig } from '../config/index.js';

let launched = false;

/**
 * Initialize and launch the DBOS runtime inside the harness process.
 * Must be called AFTER initDatabase so the Postgres server is reachable,
 * but BEFORE any workflow is started. Idempotent.
 *
 * The system database URL is constructed from the scenario's database config
 * so DBOS's `dbos` schema lives in the same database as our own tables
 * (decision_proposals, events, etc.) — no cross-database transactions, easy
 * audit correlation.
 */
export async function initDbos(scenario: ScenarioConfig): Promise<void> {
	if (launched) return;

	const db = scenario.database;
	const password = encodeURIComponent(db.password);
	const user = encodeURIComponent(db.user);
	const systemDatabaseUrl =
		process.env.DBOS_SYSTEM_DATABASE_URL ?? `postgres://${user}:${password}@${db.host}:${db.port}/${db.name}`;

	// Pin applicationVersion so hot-reload during development doesn't strand
	// in-flight workflows under an older version (see DBOS docs: applicationVersion).
	const applicationVersion = process.env.DBOS_APP_VERSION ?? 'dazense-dev';

	DBOS.setConfig({
		name: 'dazense-harness',
		systemDatabaseUrl,
		applicationVersion,
		runAdminServer: false, // we have our own HTTP server
	});

	await DBOS.launch();
	launched = true;

	console.error(`[dbos] initialized (schema=dbos, app_version=${applicationVersion}) — pending workflows recovered`);
}

/**
 * Graceful shutdown — flushes DBOS state. Call from the same SIGINT/SIGTERM
 * handler that already tears down the HTTP server and the tracing SDK.
 */
export async function shutdownDbos(): Promise<void> {
	if (!launched) return;
	try {
		await DBOS.shutdown();
		launched = false;
		console.error('[dbos] shutdown complete');
	} catch (err) {
		console.error('[dbos] shutdown error:', (err as Error).message);
	}
}

/**
 * Has DBOS been launched? Used by workflow tools to fail fast if the runtime
 * is not available (e.g., in stdio mode where we skip DBOS init).
 */
export function isDbosLaunched(): boolean {
	return launched;
}
