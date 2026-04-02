/**
 * ADMIN tools — For governance teams, not for agents during sessions.
 *
 * These tools help data governance teams audit the system, find coverage
 * gaps, and simulate changes. They are NOT called by agents during
 * normal operation — they're for humans reviewing the governance setup.
 *
 * In production, these would be behind a separate admin MCP endpoint
 * or exposed through a governance dashboard.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerAdminTools(server: McpServer) {
  /**
   * find_governance_gaps — Where is governance coverage missing?
   *
   * Scans the context graph for:
   * - PII columns classified but not blocked by policy
   * - Tables in bundles without business rules
   * - Measures without applicable rules
   * - Tables not in any bundle (orphans)
   */
  server.tool(
    "find_governance_gaps",
    "[Admin] Find gaps in governance coverage — unblocked PII, ungoverned measures, orphan tables",
    {
      check: z
        .enum(["pii", "models", "rules", "all"])
        .optional()
        .default("all")
        .describe("Which gaps to check for"),
    },
    async ({ check }) => {
      // TODO: Wire to GovernanceGraph.findGaps() + findUnblockedPiiColumns()
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                _scaffold: true,
                check,
                gaps: [
                  {
                    node_id: "placeholder",
                    node_type: "placeholder",
                    missing_edge: "placeholder",
                    description: "placeholder: what governance is missing",
                  },
                ],
                total_gaps: 0,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  /**
   * simulate_removal — What breaks if we remove an entity?
   *
   * Non-destructive simulation: temporarily removes nodes from the graph
   * and reports new governance gaps that would appear.
   */
  server.tool(
    "simulate_removal",
    "[Admin] Simulate removing entities and report what breaks",
    {
      removals: z.array(z.string()).describe("Entity IDs to simulate removing"),
    },
    async ({ removals }) => {
      // TODO: Wire to GovernanceGraph.simulate()
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                _scaffold: true,
                removals,
                impact: {
                  removed_nodes: removals,
                  new_gaps: [
                    {
                      node_id: "placeholder",
                      node_type: "placeholder",
                      missing_edge: "placeholder",
                      description: "placeholder: governance gap created",
                    },
                  ],
                },
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  /**
   * graph_stats — Overview of the governance graph.
   *
   * Node and edge counts by type. Quick health check of
   * governance coverage.
   */
  server.tool(
    "graph_stats",
    "[Admin] Get governance graph statistics — node and edge counts by type",
    {},
    async () => {
      // TODO: Wire to GovernanceGraph.stats()
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                _scaffold: true,
                nodes_by_type: {
                  Table: 0,
                  Column: 0,
                  Measure: 0,
                  Rule: 0,
                  GlossaryTerm: 0,
                },
                edges_by_type: {
                  BLOCKS: 0,
                  CLASSIFIES: 0,
                  APPLIES_TO: 0,
                  PIPELINE_FEEDS: 0,
                },
                total_nodes: 0,
                total_edges: 0,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  /**
   * audit_decisions — Query past decisions for compliance.
   *
   * Search the decision store by time range, agent, outcome, or question.
   * For compliance reporting and governance audits.
   */
  server.tool(
    "audit_decisions",
    "[Admin] Query past decisions for compliance and audit",
    {
      from_date: z.string().optional().describe("Start date (ISO format)"),
      to_date: z.string().optional().describe("End date (ISO format)"),
      agent_id: z.string().optional().describe("Filter by agent"),
      confidence: z.enum(["high", "medium", "low"]).optional().describe("Filter by confidence"),
      limit: z.number().optional().default(20).describe("Max results"),
    },
    async ({ from_date, to_date, agent_id, confidence, limit }) => {
      // TODO: Wire to decision store — query with filters
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                _scaffold: true,
                filters: { from_date, to_date, agent_id, confidence },
                decisions: [
                  {
                    decision_id: "placeholder",
                    question: "placeholder",
                    decision: "placeholder",
                    confidence: "high",
                    agents_involved: [],
                    cost_usd: 0,
                    timestamp: "placeholder",
                  },
                ],
                total: 0,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
