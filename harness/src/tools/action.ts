/**
 * ACTION tools — "Execute in the real world"
 *
 * Governed execution of queries and external actions. The agent just calls
 * query_data with SQL — the harness INTERNALLY runs the full governance
 * pipeline (authenticate, check bundle, validate SQL, block PII, check joins,
 * enforce limits) before executing.
 *
 * The agent never calls policy checks directly. It just gets back:
 * - results (if allowed)
 * - a block message with reason (if denied)
 *
 * This is the "locked doors enforce themselves" pattern.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { evaluateGovernance, filterPiiFromResults } from "../governance/index.js";
import { executeQuery } from "../database/index.js";

export function registerActionTools(server: McpServer) {
  /**
   * query_data — Governed SQL execution.
   *
   * The agent provides SQL. The harness INTERNALLY:
   * 1. Authenticates the agent
   * 2. Validates SQL (read-only, single statement, has LIMIT)
   * 3. Checks tables are within the agent's bundle
   * 4. Blocks PII columns
   * 5. Checks joins against allowlist
   * 6. Enforces time filter requirements
   * 7. Builds an audit contract
   * 8. Executes against the database
   * 9. Filters any remaining PII from results
   * 10. Returns results (or block reason)
   *
   * The agent sees: results or "blocked: reason". Never the internal checks.
   */
  server.tool(
    "query_data",
    "Execute a SQL query — governance is enforced automatically by the harness",
    {
      agent_id: z.string().describe("Agent executing the query"),
      sql: z.string().describe("SQL query to execute"),
      reason: z.string().optional().describe("Why this query is needed (for audit trail)"),
    },
    async ({ agent_id, sql, reason }) => {
      // Step 1: Run full governance pipeline internally
      const governance = await evaluateGovernance({
        agent_id,
        sql,
      });

      if (!governance.allowed) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "blocked",
                  reason: governance.reason,
                  blocked_columns: governance.blocked_columns,
                  suggestion: "Adjust your query to comply with policy, then retry.",
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // Step 2: Execute query against PostgreSQL
      try {
        const result = await executeQuery(sql, 30000);

        // Step 3: Filter PII from results (defense in depth)
        const filtered = filterPiiFromResults(
          result.rows,
          governance.blocked_columns ?? []
        );

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "success",
                  rows: filtered,
                  row_count: result.rowCount,
                  execution_time_ms: result.durationMs,
                  contract_id: governance.contract_id,
                  applicable_rules: governance.applicable_rules,
                  warnings: governance.warnings,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "error",
                  reason: `Query execution failed: ${(err as Error).message}`,
                  contract_id: governance.contract_id,
                },
                null,
                2
              ),
            },
          ],
        };
      }
    }
  );

  /**
   * query_metrics — Semantic layer query.
   *
   * The agent requests pre-defined measures and dimensions. The harness:
   * 1. Validates measures exist in the semantic model
   * 2. Checks the agent's bundle covers the underlying tables
   * 3. Generates correct SQL with baked-in filters
   * 4. Runs full governance pipeline
   * 5. Executes and returns results
   *
   * This ensures consistent metrics — "total_revenue" always excludes
   * cancelled bookings, regardless of which agent asks.
   */
  server.tool(
    "query_metrics",
    "Query semantic measures and dimensions — governance enforced automatically",
    {
      agent_id: z.string().describe("Agent executing the query"),
      measures: z.array(z.string()).describe("Measure names (e.g. ['bookings.total_revenue'])"),
      dimensions: z.array(z.string()).optional().describe("Dimensions to group by"),
      filters: z
        .array(
          z.object({
            dimension: z.string(),
            operator: z.string(),
            value: z.string(),
          })
        )
        .optional()
        .describe("Filters to apply"),
    },
    async ({ agent_id, measures, dimensions, filters }) => {
      // Step 1: Validate measures exist in semantic model
      // Step 2: Resolve underlying tables
      // Step 3: Run governance pipeline
      const governance = await evaluateGovernance({
        agent_id,
        metric_refs: measures,
      });

      if (!governance.allowed) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "blocked",
                  reason: governance.reason,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // Step 4: Generate SQL from semantic model (TODO: wire to semantic engine)
      // Step 5: Execute and return
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                _scaffold: true,
                status: "success",
                measures,
                dimensions,
                filters,
                result: [{ placeholder: "metric results" }],
                generated_sql: "placeholder: SQL from semantic engine",
                contract_id: governance.contract_id,
                applicable_rules: governance.applicable_rules,
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
   * execute_action — Trigger an external action with approval gate.
   *
   * For actions that affect the real world (send notification, trigger
   * rebooking, issue compensation). High-cost actions require human
   * approval before execution.
   *
   * The harness checks:
   * - Is this agent authorized to trigger this action type?
   * - Does the cost exceed the approval threshold?
   * - Is a human-in-the-loop required?
   */
  server.tool(
    "execute_action",
    "Trigger an external action (notification, rebooking) — approval enforced automatically",
    {
      agent_id: z.string().describe("Agent requesting the action"),
      action_type: z
        .enum(["notify_customer", "rebook_passenger", "issue_compensation", "escalate_to_human"])
        .describe("Type of action"),
      parameters: z.record(z.string()).describe("Action-specific parameters"),
      reason: z.string().describe("Why this action is needed (for audit)"),
    },
    async ({ agent_id, action_type, parameters, reason }) => {
      // TODO: Wire to action engine
      // Check: is this agent authorized for this action type?
      // Check: does estimated cost exceed threshold? → require approval
      // Check: is human-in-the-loop required for this action type?
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                _scaffold: true,
                agent_id,
                action_type,
                parameters,
                reason,
                status: "queued",
                requires_approval: action_type !== "notify_customer",
                message:
                  action_type === "notify_customer"
                    ? "Notification sent"
                    : "Action queued for human approval",
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
