/**
 * OpenMetadata catalog client — implements ICatalogClient for OMD.
 *
 * To add a new catalog (Atlan, Collibra, Purview), create a new file
 * (e.g. atlan.ts) that implements ICatalogClient. Then register it
 * in the factory (index.ts).
 */

import type { ICatalogClient, CatalogTable, CatalogColumn, CatalogGlossaryTerm, CatalogLineageEdge } from './types.js';

export class OpenMetadataCatalogClient implements ICatalogClient {
	private baseUrl: string;
	private token: string | null = null;
	private email: string;
	private password: string;
	private serviceName: string;

	constructor(config: { url: string; token?: string; email?: string; password?: string; serviceName: string }) {
		this.baseUrl = config.url.replace(/\/$/, '');
		this.token = config.token ?? null;
		this.email = config.email ?? 'admin@open-metadata.org';
		this.password = config.password ?? 'admin';
		this.serviceName = config.serviceName;
	}

	private async getToken(): Promise<string> {
		if (this.token) return this.token;

		const b64Pass = Buffer.from(this.password).toString('base64');
		const resp = await fetch(`${this.baseUrl}/api/v1/users/login`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ email: this.email, password: b64Pass }),
		});
		const data = (await resp.json()) as { accessToken: string };
		this.token = data.accessToken;
		return this.token;
	}

	private async get(path: string, params?: Record<string, string>): Promise<unknown> {
		const token = await this.getToken();
		const url = new URL(`${this.baseUrl}${path}`);
		if (params) {
			for (const [k, v] of Object.entries(params)) {
				url.searchParams.set(k, v);
			}
		}
		const resp = await fetch(url.toString(), {
			headers: { Authorization: `Bearer ${token}` },
		});
		return resp.json();
	}

	async listTables(): Promise<CatalogTable[]> {
		const data = (await this.get('/api/v1/tables', {
			service: this.serviceName,
			limit: '50',
			fields: 'columns,tags,owners',
		})) as { data: Array<Record<string, unknown>> };

		return data.data
			.filter((t: any) => t.fullyQualifiedName?.includes('.public.'))
			.map((t: any) => {
				const columns: CatalogColumn[] = (t.columns ?? []).map((c: any) => {
					const colTags = (c.tags ?? []).map((tg: any) => tg.tagFQN as string);
					return {
						name: c.name,
						dataType: c.dataType ?? 'UNKNOWN',
						description: c.description ?? '',
						tags: colTags,
						isPii: colTags.some((tag: string) => tag.includes('PII') || tag.includes('Sensitive')),
					};
				});

				const tableTags = (t.tags ?? []).map((tg: any) => tg.tagFQN as string);
				const owners = (t.owners ?? []).map((o: any) => ({
					name: o.displayName ?? o.name ?? '',
					type: o.type ?? 'user',
				}));

				return {
					name: t.name,
					fqn: t.fullyQualifiedName,
					schema: 'public',
					description: t.description ?? '',
					columns,
					tags: tableTags,
					owners,
					piiColumns: columns.filter((c) => c.isPii).map((c) => c.name),
					tier: tableTags.find((tag: string) => tag.startsWith('Tier.')) ?? null,
					glossaryTerms: tableTags.filter((tag: string) => tag.includes('Glossary')),
				};
			});
	}

	async getPiiColumns(): Promise<Set<string>> {
		const tables = await this.listTables();
		const piiSet = new Set<string>();
		for (const table of tables) {
			for (const col of table.piiColumns) {
				piiSet.add(`public.${table.name}.${col}`);
			}
		}
		return piiSet;
	}

	async listGlossaryTerms(glossaryName?: string): Promise<CatalogGlossaryTerm[]> {
		const data = (await this.get('/api/v1/glossaryTerms', {
			limit: '50',
			fields: 'relatedTerms,synonyms,tags',
		})) as { data: Array<Record<string, unknown>> };

		return data.data
			.filter((t: any) => !glossaryName || t.fullyQualifiedName?.startsWith(glossaryName))
			.map((t: any) => ({
				name: t.name,
				fqn: t.fullyQualifiedName,
				description: t.description ?? '',
				synonyms: t.synonyms ?? [],
				relatedTerms: (t.relatedTerms ?? []).map((r: any) => r.name ?? ''),
				linkedTables: [],
			}));
	}

	async getLineage(tableFqn: string, depth: number = 3): Promise<CatalogLineageEdge[]> {
		try {
			const data = (await this.get(`/api/v1/lineage/table/name/${tableFqn}`, {
				upstreamDepth: String(depth),
				downstreamDepth: '1',
			})) as {
				nodes?: Array<{ name: string; fullyQualifiedName: string; id: string }>;
				upstreamEdges?: Array<{ fromEntity: string; toEntity: string }>;
				entity?: { id: string; fullyQualifiedName: string };
			};

			if (!data.upstreamEdges) return [];

			const nodeMap: Record<string, string> = {};
			if (data.entity) nodeMap[data.entity.id] = data.entity.fullyQualifiedName;
			for (const n of data.nodes ?? []) {
				nodeMap[n.id] = n.fullyQualifiedName;
			}

			return data.upstreamEdges.map((e) => ({
				from: nodeMap[e.fromEntity] ?? e.fromEntity,
				to: nodeMap[e.toEntity] ?? e.toEntity,
			}));
		} catch {
			return [];
		}
	}

	async sparql(query: string): Promise<Array<Record<string, { type: string; value: string }>>> {
		try {
			const token = await this.getToken();
			const resp = await fetch(`${this.baseUrl}/api/v1/rdf/sparql`, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ query }),
			});
			const data = (await resp.json()) as {
				results?: { bindings: Array<Record<string, { type: string; value: string }>> };
			};
			return data.results?.bindings ?? [];
		} catch {
			return [];
		}
	}

	async healthCheck(): Promise<boolean> {
		try {
			const resp = await fetch(`${this.baseUrl}/api/v1/system/version`);
			return resp.ok;
		} catch {
			return false;
		}
	}
}
