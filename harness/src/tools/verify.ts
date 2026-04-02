/**
 * OBSERVE & VERIFY tools — "Monitor, validate, self-correct"
 *
 * Post-execution checks. Did the agent use the correct measure?
 * Is the data fresh enough? Is the result consistent with business rules?
 *
 * This closes the feedback loop — agents don't just execute, they verify
 * their own output before delivering it to the user.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerVerifyTools(server: McpServer) {
  /**
   * verify_result — Post-execution governance check.
   *
   * After an agent generates a result, this tool checks:
   * - Did the query use the correct measures for this question? (intent match)
   * - Did the query respect business rules? (e.g. revenue excludes cancelled)
   * - Are the results within expected ranges?
   *
   * Returns verified (ok) or flagged (with what's wrong).
   */
  server.tool(
    "verify_result",
    "Verify an agent's result against business rules and intents",
    {
      agent_id: z.string().describe("Agent whose result is being verified"),
      question: z.string().describe("The original question"),
      result_summary: z.string().describe("Summary of the result to verify"),
      sql_used: z.string().optional().describe("The SQL query that produced the result"),
      measures_used: z.array(z.string()).optional().describe("Measures used in the query"),
    },
    async ({ agent_id, question, result_summary, sql_used, measures_used }) => {
      // TODO: Wire to context graph — match question against intents, check rules
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                _scaffold: true,
                agent_id,
                question,
                verified: true,
                checks: [
                  {
                    check: "intent_match",
                    status: "placeholder: did the agent use the right measures?",
                    passed: true,
                  },
                  {
                    check: "rule_compliance",
                    status: "placeholder: did the result respect business rules?",
                    passed: true,
                  },
                  {
                    check: "range_check",
                    status: "placeholder: are values within expected ranges?",
                    passed: true,
                  },
                ],
                warnings: [],
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
   * check_freshness — Is the data fresh enough for this decision?
   *
   * Compares the last observation timestamp against the SLA defined
   * in policy.yml. Critical during disruptions — stale flight data
   * can lead to wrong decisions.
   */
  server.tool(
    "check_freshness",
    "Check if data is fresh enough based on SLA expectations",
    {
      tables: z.array(z.string()).describe("Tables to check freshness for"),
    },
    async ({ tables }) => {
      // TODO: Wire to temporal context — compare observed_at vs SLA
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                _scaffold: true,
                tables,
                results: tables.map((table) => ({
                  table,
                  sla: "placeholder: max delay from policy",
                  last_updated: "placeholder: when data was last refreshed",
                  fresh: true,
                  warning: null,
                })),
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
   * check_consistency — Does the result align with known rules?
   *
   * Cross-references a result against applicable business rules.
   * Example: if revenue is reported, check that cancelled bookings
   * were excluded (rule: revenue_excludes_cancelled).
   */
  server.tool(
    "check_consistency",
    "Check if a result is consistent with applicable business rules",
    {
      agent_id: z.string().describe("Agent whose result is being checked"),
      result_summary: z.string().describe("The result to check"),
      applicable_rules: z.array(z.string()).optional().describe("Rules to check against (auto-detected if omitted)"),
    },
    async ({ agent_id, result_summary, applicable_rules }) => {
      // TODO: Wire to context graph — lookup rules, verify compliance
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                _scaffold: true,
                agent_id,
                result_summary,
                rules_checked: applicable_rules ?? ["placeholder: auto-detected rules"],
                consistent: true,
                violations: [],
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
   * get_confidence — Overall confidence score for a decision.
   *
   * Combines multiple signals:
   * - Data freshness (all tables within SLA?)
   * - Rule compliance (all applicable rules respected?)
   * - Coverage (were all relevant agents consulted?)
   * - Precedent (does this align with past decisions?)
   *
   * Returns HIGH / MEDIUM / LOW with explanation.
   */
  server.tool(
    "get_confidence",
    "Get overall confidence score for a decision based on freshness, rules, and coverage",
    {
      session_id: z.string().describe("Session to score"),
      tables_used: z.array(z.string()).describe("Tables that were queried"),
      rules_checked: z.array(z.string()).describe("Rules that were verified"),
      agents_consulted: z.array(z.string()).describe("Agents that contributed findings"),
    },
    async ({ session_id, tables_used, rules_checked, agents_consulted }) => {
      // TODO: Wire to all layers — freshness, rules, coverage, precedent
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                _scaffold: true,
                session_id,
                confidence: "high",
                score: 0.92,
                breakdown: {
                  freshness: { score: 1.0, detail: "placeholder: all tables within SLA" },
                  rule_compliance: { score: 0.9, detail: "placeholder: all rules respected" },
                  coverage: { score: 0.85, detail: "placeholder: 3 of 3 required agents consulted" },
                  precedent: { score: 0.9, detail: "placeholder: aligns with 4 similar past decisions" },
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
}
