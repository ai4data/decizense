/**
 * Load the repo-root `.env` into process.env so AZURE_OPENAI_* and other
 * secrets are available to CLI scripts (orchestrator.ts, booking.ts,
 * flight-ops.ts, customer-service.ts, test-*.ts).
 *
 * Uses Node 20.6+ `process.loadEnvFile` — no dotenv dependency. Silently
 * no-ops when the file isn't present (e.g. tests with explicit env injection)
 * or when running on an older Node that lacks the API.
 *
 * Checks `./.env` then `../.env` so it works whether the script is invoked
 * from the repo root or from `agents/`.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export function loadRepoEnv(): void {
	const repoEnvPath = resolve(process.cwd(), '.env');
	const fallbackEnvPath = resolve(process.cwd(), '..', '.env');
	const envPath = existsSync(repoEnvPath) ? repoEnvPath : existsSync(fallbackEnvPath) ? fallbackEnvPath : null;
	if (envPath && typeof (process as { loadEnvFile?: (p: string) => void }).loadEnvFile === 'function') {
		(process as { loadEnvFile: (p: string) => void }).loadEnvFile(envPath);
	}
}
