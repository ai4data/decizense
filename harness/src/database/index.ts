/**
 * Database client — governed PostgreSQL query execution.
 *
 * Provides a connection pool and a query method with timeout enforcement.
 * The governance layer calls this AFTER all policy checks have passed.
 */

import pg from 'pg';

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function initDatabase(config: { host: string; port: number; database: string; user: string; password: string }) {
	pool = new Pool({
		host: config.host,
		port: config.port,
		database: config.database,
		user: config.user,
		password: config.password,
		max: 10,
		idleTimeoutMillis: 30000,
		connectionTimeoutMillis: 5000,
	});
}

export async function executeQuery(
	sql: string,
	timeoutMs: number = 30000,
): Promise<{ rows: Record<string, unknown>[]; rowCount: number; durationMs: number }> {
	if (!pool) {
		throw new Error('Database not initialized. Call initDatabase() first.');
	}

	const start = Date.now();
	const client = await pool.connect();

	try {
		// Set statement timeout
		await client.query(`SET statement_timeout = ${timeoutMs}`);
		const result = await client.query(sql);
		const durationMs = Date.now() - start;

		return {
			rows: result.rows as Record<string, unknown>[],
			rowCount: result.rowCount ?? 0,
			durationMs,
		};
	} finally {
		client.release();
	}
}

export async function closeDatabase() {
	if (pool) {
		await pool.end();
		pool = null;
	}
}
