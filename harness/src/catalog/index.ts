/**
 * Catalog factory — creates the right client based on scenario config.
 *
 * The harness never imports a specific catalog implementation directly.
 * It calls getCatalogClient() which returns an ICatalogClient.
 *
 * To add a new catalog:
 * 1. Create a new file (e.g. atlan.ts) implementing ICatalogClient
 * 2. Register it in the PROVIDERS map below
 * 3. Set provider: "atlan" in scenario.yml
 */

import { ScenarioLoader } from '../config/index.js';
import type { ICatalogClient } from './types.js';
import { OpenMetadataCatalogClient } from './openmetadata.js';

export type { ICatalogClient, CatalogTable, CatalogColumn, CatalogGlossaryTerm, CatalogLineageEdge } from './types.js';

// ─── Provider registry ───

type CatalogFactory = (config: { url: string; token?: string; serviceName: string }) => ICatalogClient;

const PROVIDERS: Record<string, CatalogFactory> = {
	openmetadata: (config) =>
		new OpenMetadataCatalogClient({
			url: config.url,
			token: config.token,
			serviceName: config.serviceName,
		}),
	// To add Atlan:
	// atlan: (config) => new AtlanCatalogClient({ url: config.url, token: config.token, ... }),
	// To add Collibra:
	// collibra: (config) => new CollibraCatalogClient({ url: config.url, token: config.token, ... }),
	// To add Purview:
	// purview: (config) => new PurviewCatalogClient({ url: config.url, token: config.token, ... }),
};

// ─── Singleton ───

let catalogClient: ICatalogClient | null = null;

export function initCatalog(scenarioPath: string): ICatalogClient | null {
	try {
		const loader = new ScenarioLoader(scenarioPath);
		const scenario = loader.scenario;
		const catalog = scenario.catalog;

		if (!catalog) {
			console.error('[catalog] No catalog config in scenario.yml');
			return null;
		}

		const provider = catalog.provider ?? 'openmetadata';
		const factory = PROVIDERS[provider];

		if (!factory) {
			console.error(`[catalog] Unknown provider: ${provider}. Available: ${Object.keys(PROVIDERS).join(', ')}`);
			return null;
		}

		catalogClient = factory({
			url: catalog.url,
			token: catalog.token,
			serviceName: catalog.service_name ?? scenario.name ?? 'default',
		});

		console.error(`[catalog] Provider: ${provider}`);
		return catalogClient;
	} catch (err) {
		console.error(`[catalog] Failed to init: ${(err as Error).message}`);
		return null;
	}
}

export function getCatalogClient(): ICatalogClient | null {
	return catalogClient;
}
