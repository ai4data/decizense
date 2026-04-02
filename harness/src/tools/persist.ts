/**
 * PERSIST tools — "Durable state across sessions" (shared workspace)
 *
 * The decision store is the agent collaboration surface. Each agent writes
 * intermediate findings. The orchestrator reads all findings to combine
 * into a decision. Decisions become precedent for future sessions.
 *
 * This is the "filesystem" equivalent from the agent harness article —
 * structured, governed, queryable shared state.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerPersistTools(server: McpServer) {
  /**
   * write_finding — Agent stores an intermediate result.
   *
   * During a multi-agent session, each domain agent writes its findings
   * to the shared workspace. The orchestrator reads all findings to
   * combine into a final decision.
   *
   * PII is stripped from findings. Findings are append-only (tamper-evident).
   */
  server.tool(
    "write_finding",
    "Store an intermediate finding for the current session (shared workspace)",
    {
      session_id: z.string().describe("Current decision session ID"),
      agent_id: z.string().describe("Agent writing the finding"),
      finding: z.string().describe("The finding content (PII must not be included)"),
      confidence: z.enum(["high", "medium", "low"]).describe("Confidence in this finding"),
      data_sources: z.array(z.string()).optional().describe("Tables/measures used to produce this finding"),
    },
    async ({ session_id, agent_id, finding, confidence, data_sources }) => {
      // TODO: Wire to decision store — insert finding into PostgreSQL
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                _scaffold: true,
                session_id,
                agent_id,
                finding_id: "placeholder-uuid",
                stored: true,
                timestamp: new Date().toISOString(),
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
   * read_findings — Read all findings in the current session.
   *
   * The orchestrator calls this to see what domain agents have found.
   * Agents can also read each other's findings to avoid duplicate work.
   *
   * Returns findings filtered by session. Agents can only read findings
   * from the same session.
   */
  server.tool(
    "read_findings",
    "Read all agent findings for the current session",
    {
      session_id: z.string().describe("Session to read findings from"),
      agent_filter: z.string().optional().describe("Only return findings from this agent"),
    },
    async ({ session_id, agent_filter }) => {
      // TODO: Wire to decision store — query findings by session_id
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                _scaffold: true,
                session_id,
                agent_filter,
                findings: [
                  {
                    finding_id: "placeholder",
                    agent_id: "placeholder",
                    finding: "placeholder: agent finding content",
                    confidence: "high",
                    timestamp: "placeholder",
                  },
                ],
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
   * log_decision — Record the final decision with full reasoning chain.
   *
   * Called by the orchestrator after combining all agent findings.
   * The decision becomes searchable precedent for future sessions.
   *
   * Includes: question, agents involved, each agent's finding, final
   * decision, confidence score, cost, and reasoning.
   */
  server.tool(
    "log_decision",
    "Record a final decision with full reasoning chain (becomes precedent)",
    {
      session_id: z.string().describe("Session this decision belongs to"),
      question: z.string().describe("The original question"),
      decision: z.string().describe("The final decision/answer"),
      reasoning: z.string().describe("How the decision was reached"),
      confidence: z.enum(["high", "medium", "low"]).describe("Confidence in the decision"),
      agents_involved: z.array(z.string()).describe("Agent IDs that contributed"),
      cost_usd: z.number().optional().describe("Total LLM cost for this decision"),
    },
    async ({ session_id, question, decision, reasoning, confidence, agents_involved, cost_usd }) => {
      // TODO: Wire to decision store — insert decision with full trace
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                _scaffold: true,
                decision_id: "placeholder-uuid",
                session_id,
                question,
                decision,
                confidence,
                agents_involved,
                cost_usd,
                stored: true,
                timestamp: new Date().toISOString(),
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
   * save_memory — Persist agent memory across sessions.
   *
   * Agents can save learnings that persist beyond the current session.
   * Example: "Delays at CDG on Fridays average 45 minutes due to
   * congestion" — learned from analyzing delay patterns.
   */
  server.tool(
    "save_memory",
    "Save agent memory that persists across sessions",
    {
      agent_id: z.string().describe("Agent saving the memory"),
      key: z.string().describe("Memory key (topic or category)"),
      content: z.string().describe("Memory content to persist"),
    },
    async ({ agent_id, key, content }) => {
      // TODO: Wire to decision store — upsert agent memory
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                _scaffold: true,
                agent_id,
                key,
                saved: true,
                timestamp: new Date().toISOString(),
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
   * recall_memory — Retrieve past agent memory.
   *
   * Agents recall learnings from previous sessions.
   */
  server.tool(
    "recall_memory",
    "Retrieve agent memory from previous sessions",
    {
      agent_id: z.string().describe("Agent recalling memory"),
      key: z.string().optional().describe("Specific memory key, or omit for all"),
    },
    async ({ agent_id, key }) => {
      // TODO: Wire to decision store — query agent memory
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                _scaffold: true,
                agent_id,
                key,
                memories: [
                  {
                    key: "placeholder",
                    content: "placeholder: previously saved memory",
                    saved_at: "placeholder",
                  },
                ],
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
