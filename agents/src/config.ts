/**
 * Agent runtime config for talking to ContextGraph-MCP.
 *
 * HARNESS_MODE documents/gates which server operators run during the Phase 2
 * dual-run period:
 *   - 'embedded' (default): this repo's in-tree harness/ (legacy, pre-cutover)
 *   - 'external': the standalone ContextGraph-MCP server (../contextgraph-mcp)
 *
 * Both modes use the same HTTP client + URL — the flag is the rollout switch,
 * not a transport change. Default stays 'embedded' until the A-items land and a
 * clean shadow run is observed (see docs/contextgraph-mcp-phase-2-backlog.md).
 */
export const HARNESS_MODE: 'embedded' | 'external' = process.env.HARNESS_MODE === 'external' ? 'external' : 'embedded';

export const HARNESS_HTTP_URL = process.env.HARNESS_HTTP_URL ?? 'http://127.0.0.1:9080/mcp';
