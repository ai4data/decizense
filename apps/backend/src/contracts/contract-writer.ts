import type { Contract } from '@dazense/shared/tools/build-contract';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

/**
 * Persist a contract to contracts/runs/{timestamp}_{contract_id}.json
 */
export function persistContract(contract: Contract, projectFolder: string): string {
	const runsDir = join(projectFolder, 'contracts', 'runs');

	if (!existsSync(runsDir)) {
		mkdirSync(runsDir, { recursive: true });
	}

	const timestamp = contract.created_at.replace(/[:.]/g, '-');
	const filename = `${timestamp}_${contract.contract_id}.json`;
	const filePath = join(runsDir, filename);

	writeFileSync(filePath, JSON.stringify(contract, null, 2), 'utf-8');
	return filePath;
}

/**
 * Load a contract by its contract_id from contracts/runs/
 */
export function loadContract(contractId: string, projectFolder: string): Contract | null {
	const runsDir = join(projectFolder, 'contracts', 'runs');

	if (!existsSync(runsDir)) {
		return null;
	}

	try {
		const files = readdirSync(runsDir);
		const match = files.find((f: string) => f.includes(`_${contractId}.json`));

		if (!match) {
			return null;
		}

		const content = readFileSync(join(runsDir, match), 'utf-8');
		return JSON.parse(content) as Contract;
	} catch (error) {
		console.error(`Error loading contract ${contractId}:`, error);
		return null;
	}
}
