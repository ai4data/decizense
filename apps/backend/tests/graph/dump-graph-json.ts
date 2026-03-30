/**
 * Dump TS GovernanceGraph as sorted JSON to stdout.
 *
 * Usage:
 *   bun apps/backend/tests/graph/dump-graph-json.ts [project-path]
 *
 * Defaults to the example/ directory at the repo root.
 */
import { resolve } from 'path';

// Set DAZENSE_DEFAULT_PROJECT_PATH before importing modules that read env
const projectPath = process.argv[2]
	? resolve(process.argv[2])
	: resolve(import.meta.dirname, '..', '..', '..', '..', 'example');

process.env.DAZENSE_DEFAULT_PROJECT_PATH = projectPath;

const { buildFromProject } = await import('../../src/graph/graph-builder');

const graph = buildFromProject(projectPath);
const json = graph.toJSON();

// Normalize: sort nodes by id, sort edges by (from, to, type)
json.nodes.sort((a, b) => a.id.localeCompare(b.id));
json.edges.sort((a, b) => {
	const cmpFrom = a.from.localeCompare(b.from);
	if (cmpFrom !== 0) {
		return cmpFrom;
	}
	const cmpTo = a.to.localeCompare(b.to);
	if (cmpTo !== 0) {
		return cmpTo;
	}
	return a.type.localeCompare(b.type);
});

process.stdout.write(JSON.stringify(json, null, 2));
