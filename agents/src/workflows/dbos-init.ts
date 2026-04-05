/**
 * DBOS runtime init for the orchestrator agent process — Plan v3 Phase 1c.
 *
 * The orchestrator agent runs as a one-shot process (spawn, run a workflow,
 * exit). DBOS persists workflow state to the same `dbos` schema in travel_db
 * that the harness already uses. When the agent crashes mid-workflow, the
 * NEXT agent invocation with the same WORKFLOW_ID resumes from the last
 * completed step — same process lifecycle, different process instance.
 *
 * The harness and the agent share the `dbos` schema but use DIFFERENT
 * application_version strings so their workflow inventories don't clash.
 * Orchestrator workflow IDs are also prefixed with `orch-` for safety
 * (see orchestrator.ts enforcement) so collisions with harness-side
 * decision workflows are impossible.
 */

import { DBOS } from '@dbos-inc/dbos-sdk';

let launched = false;

/**
 * Build a connection URL to travel_db for DBOS's system schema.
 * The orchestrator agent does NOT need PG credentials for anything else —
 * this is only for DBOS's internal workflow state.
 */
function buildSystemDatabaseUrl(): string {
	const url = process.env.DBOS_SYSTEM_DATABASE_URL;
	if (url) return url;
	// Default matches the Phase 1b harness config: same travel_db, dbos schema.
	const host = process.env.TRAVEL_DB_HOST ?? 'localhost';
	const port = process.env.TRAVEL_DB_PORT ?? '5433';
	const name = process.env.TRAVEL_DB_NAME ?? 'travel_db';
	const user = encodeURIComponent(process.env.TRAVEL_DB_USER ?? 'travel_admin');
	const password = encodeURIComponent(process.env.TRAVEL_DB_PASSWORD ?? 'travel_pass');
	return `postgres://${user}:${password}@${host}:${port}/${name}`;
}

export async function initAgentDbos(serviceName: string): Promise<void> {
	if (launched) return;

	const applicationVersion = process.env.DBOS_APP_VERSION ?? 'dazense-agent-dev';
	DBOS.setConfig({
		name: serviceName,
		systemDatabaseUrl: buildSystemDatabaseUrl(),
		applicationVersion,
		runAdminServer: false,
	});

	await DBOS.launch();
	launched = true;
	console.error(
		`[dbos] agent runtime initialized (schema=dbos, app_version=${applicationVersion}, service=${serviceName}) - pending workflows recovered`,
	);
}

export async function shutdownAgentDbos(): Promise<void> {
	if (!launched) return;
	try {
		await DBOS.shutdown();
		launched = false;
		console.error('[dbos] agent runtime shutdown complete');
	} catch (err) {
		console.error('[dbos] shutdown error:', (err as Error).message);
	}
}

export function isAgentDbosLaunched(): boolean {
	return launched;
}
