Plan: Agent JWT Authentication (v2)

     Grounded in draft-klrc-aiagent-auth-00 (Kasselman et al., March 2026).

     Context

     The harness has 31 MCP tools with full authorization (PII, bundles, business rules). But agent
     identity is unverified — authenticateAgent() checks if agent_id exists in config and returns
     authenticated: true. Worse, 14 tool handlers accept agent_id as a model-provided tool argument,
     meaning the LLM could spoof any identity.

     Core Problem

     LLM → calls query_data(agent_id="orchestrator", sql="...")
                               ↑ model chooses this, no verification

     The agent_id flows from model output into governance decisions (bundle scope, PII, permissions).
     This is the root vulnerability.

     Architecture: AuthContext per Connection

     Since MCP stdio spawns one harness process per agent, the connection itself IS the identity
     boundary. The token travels via environment variable to the child process — never exposed to the
     model as a tool argument.

     Agent Process
       │
       │  sets env: AGENT_TOKEN=eyJhbG...
       │  spawns child process (harness) via stdio
       │
       ▼
     Harness (child process)
       ├─ reads AGENT_TOKEN from process.env at startup
       ├─ verifies JWT → extracts sub claim → resolves agent_id
       ├─ creates AuthContext (immutable for this connection)
       └─ ALL tool calls use AuthContext.agentId, ignoring model-provided agent_id

     Key insight: the token is never a tool parameter. The model never sees it. Identity comes from the
     connection, not from model output.

     AuthContext Design

     interface AuthContext {
       // Identity (draft S5)
       agentId: string;                    // resolved from JWT sub → agents.yml mapping
       agentUri: string;                   // e.g. "agent://dazense.local/flight_ops" (internal, not
     claiming WIMSE compliance)

       // Credential metadata (draft S6)
       authMethod: 'jwt' | 'config-only';
       tokenSubject: string | null;        // JWT sub claim (catalog_bot name)
       tokenIssuer: string | null;         // JWT iss claim
       tokenHash: string | null;           // SHA-256 hash of token (for audit, never the full token —
     draft S10.8)

       // Session (draft S11)
       sessionId: string | null;           // set by initialize_agent, used for correlation
       authenticatedAt: Date;
     }

     What Changes in Every Tool

     Today (14 tools accept agent_id from model):
     server.tool('query_data', schema: { agent_id: z.string(), sql: z.string() },
       async ({ agent_id, sql }) => { ... }  // agent_id from LLM

     After:
     server.tool('query_data', schema: { sql: z.string() },  // agent_id REMOVED from schema
       async ({ sql }) => {
         const ctx = getAuthContext();  // from connection-level singleton
         const agent_id = ctx.agentId; // from verified token, not model
         ...
       }

     Tools where agent_id is removed from the model-facing schema:
     - query_data, query_metrics, execute_action, get_permissions (action.ts)
     - initialize_agent (control.ts) — still accepts agent_id but validates it matches AuthContext
     - write_finding, propose_decision, save_memory, recall_memory (persist.ts)
     - verify_result, check_consistency (verify.ts)
     - get_context (context.ts) — optional agent_id, use AuthContext when missing

     Tools where agent_id stays (admin/read-only, not model-facing):
     - audit_decisions (admin.ts) — admin tool, agent_id is a filter, not identity

     Files to Create

     1. harness/src/auth/context.ts — AuthContext singleton

     - resolveAuthContext(loader) — called once at startup, reads AGENT_TOKEN from env
     - getAuthContext() — returns the immutable context for this connection
     - JWT verification:
       - If AUTH_MODE=jwt: verify token using configured strategy (JWKS URI, shared secret, or OMD
     introspection)
       - If AUTH_MODE=config-only (default): create context from AGENT_ID env var with authMethod:
     'config-only'
     - JWT claim validation: sub (must map to a catalog_bot in agents.yml), exp, iss, aud
     - Builds agentUri from trust_domain config: agent://{trust_domain}/{agent_id}

     2. harness/src/auth/verify.ts — JWT verification strategies

     - VerifyStrategy interface with implementations:
       - JwksVerifier — fetches public keys from issuer's jwks_uri (standard OAuth/OIDC pattern, draft
     S10.9.1)
       - SharedSecretVerifier — HS256 with configured secret (simple dev/test mode)
       - IntrospectionVerifier — calls token introspection endpoint (draft S10.2, for opaque tokens)
     - Strategy selected by config: auth.verify_strategy: 'jwks' | 'shared_secret' | 'introspection'

     3. scripts/provision-bots.ts — Credential provisioning (draft S8)

     - Reads agents.yml, creates OMD bots via API
     - Outputs .env-format token lines keyed by identity.token_env
     - One-time setup script, not runtime

     Files to Modify

     4. harness/package.json

     - Add jsonwebtoken + @types/jsonwebtoken + jwks-rsa (for JWKS verification)

     5. harness/src/config/index.ts

     - Add to ScenarioConfig:
     auth?: {
       mode: 'jwt' | 'config-only';
       trust_domain?: string;
       verify_strategy?: 'jwks' | 'shared_secret' | 'introspection';
       jwt_secret?: string;           // for shared_secret strategy only
       jwks_uri?: string;             // for jwks strategy
       issuer?: string;               // expected iss claim
       audience?: string;             // expected aud claim (defaults to 'dazense-harness')
       introspection_url?: string;    // for introspection strategy
     }

     6. scenario/travel/scenario.yml

     - Add auth section:
     auth:
       mode: "{{ env('AUTH_MODE', 'config-only') }}"
       trust_domain: dazense.local
       verify_strategy: shared_secret
       jwt_secret: "{{ env('JWT_SECRET') }}"
       audience: dazense-harness

     7. harness/src/server.ts

     - Call resolveAuthContext(loader) at startup, after config load
     - Log: auth mode, agent_id, agent_uri (never the token)

     8. harness/src/tools/action.ts — Remove agent_id from 4 tool schemas

     - query_data: remove agent_id param, use getAuthContext().agentId
     - query_metrics: same
     - execute_action: same
     - get_permissions: same

     9. harness/src/tools/control.ts — Validate agent_id matches AuthContext

     - initialize_agent: keep agent_id param but validate it matches getAuthContext().agentId
     - If mismatch → error: "agent_id does not match authenticated identity"
     - Store sessionId in AuthContext
     - Return agent_uri, auth_method in response (for audit visibility)

     10. harness/src/tools/persist.ts — Remove agent_id from tool schemas

     - write_finding: use AuthContext for agent_id
     - propose_decision: same
     - save_memory, recall_memory: same
     - Add audit fields to DB writes: auth_method, token_hash, correlation_id

     11. harness/src/tools/verify.ts — Remove agent_id from tool schemas

     - verify_result, check_consistency: use AuthContext

     12. harness/src/tools/context.ts — Use AuthContext when agent_id not provided

     - get_context: use AuthContext.agentId as default

     13. harness/src/governance/index.ts

     - authenticateAgent(): when AuthContext exists, use it instead of config-only check
     - evaluateGovernance(): resolve agent_id from AuthContext, not from params

     14. agents/src/harness-client.ts

     - Pass AGENT_TOKEN as env var when spawning harness child process:
     env: { ...process.env, SCENARIO_PATH, AGENT_TOKEN: this.token }
     - Add token to constructor or connect() method
     - Remove agent_id from queryData(), writeFinding() etc. (harness knows who's calling)

     15. agents/src/flight-ops.ts (+ booking.ts, customer-service.ts, orchestrator.ts)

     - Read token from env, pass to HarnessClient
     - Remove explicit agent_id from tool calls (except initialize_agent for validation)

     Implementation Order

     ┌──────┬─────────────────────────────────────────────────────────────────┬────────────┐
     │ Step │                              What                               │ Depends on │
     ├──────┼─────────────────────────────────────────────────────────────────┼────────────┤
     │ 1    │ Add jsonwebtoken, jwks-rsa, types to harness/package.json       │ —          │
     ├──────┼─────────────────────────────────────────────────────────────────┼────────────┤
     │ 2    │ Create harness/src/auth/verify.ts (JWT verification strategies) │ Step 1     │
     ├──────┼─────────────────────────────────────────────────────────────────┼────────────┤
     │ 3    │ Create harness/src/auth/context.ts (AuthContext singleton)      │ Step 2     │
     ├──────┼─────────────────────────────────────────────────────────────────┼────────────┤
     │ 4    │ Extend ScenarioConfig with auth config                          │ —          │
     ├──────┼─────────────────────────────────────────────────────────────────┼────────────┤
     │ 5    │ Add auth section to scenario.yml                                │ Step 4     │
     ├──────┼─────────────────────────────────────────────────────────────────┼────────────┤
     │ 6    │ Wire resolveAuthContext() into server.ts startup                │ Steps 3, 4 │
     ├──────┼─────────────────────────────────────────────────────────────────┼────────────┤
     │ 7    │ Update initialize_agent to validate + enrich with AuthContext   │ Steps 3, 6 │
     ├──────┼─────────────────────────────────────────────────────────────────┼────────────┤
     │ 8    │ Update evaluateGovernance() to use AuthContext                  │ Step 3     │
     ├──────┼─────────────────────────────────────────────────────────────────┼────────────┤
     │ 9    │ Remove agent_id from action.ts tool schemas (4 tools)           │ Steps 3, 8 │
     ├──────┼─────────────────────────────────────────────────────────────────┼────────────┤
     │ 10   │ Remove agent_id from persist.ts tool schemas + add audit fields │ Step 3     │
     ├──────┼─────────────────────────────────────────────────────────────────┼────────────┤
     │ 11   │ Remove agent_id from verify.ts tool schemas                     │ Step 3     │
     ├──────┼─────────────────────────────────────────────────────────────────┼────────────┤
     │ 12   │ Update context.ts to use AuthContext default                    │ Step 3     │
     ├──────┼─────────────────────────────────────────────────────────────────┼────────────┤
     │ 13   │ Update HarnessClient to pass token via env                      │ Step 6     │
     ├──────┼─────────────────────────────────────────────────────────────────┼────────────┤
     │ 14   │ Update agent files                                              │ Step 13    │
     ├──────┼─────────────────────────────────────────────────────────────────┼────────────┤
     │ 15   │ Create scripts/provision-bots.ts                                │ Steps 4, 5 │
     └──────┴─────────────────────────────────────────────────────────────────┴────────────┘

     Verification

     1. config-only mode (default): AGENT_ID=flight_ops npx tsx src/test-query.ts — works as before
     2. jwt mode: AUTH_MODE=jwt AGENT_TOKEN=<valid> npx tsx src/flight-ops.ts — authenticated, agent_uri
     in response
     3. wrong agent_id at initialize_agent: pass mismatched agent_id → clear error
     4. no token in jwt mode: AUTH_MODE=jwt without AGENT_TOKEN → startup error
     5. agent_id removed from tool schemas: verify LLM cannot provide agent_id to query_data etc.
     6. audit trail: findings/decisions include auth_method, token_hash (never full token)
     7. lint: cd harness && npx tsc --noEmit

     Key Decisions

     ┌─────────────────────────────────┬────────────────────────────────────────────────────────────────┐
     │            Decision             │                           Rationale                            │
     ├─────────────────────────────────┼────────────────────────────────────────────────────────────────┤
     │ Token via env var, never tool   │ Model must never see credentials (draft S10.8, prevents        │
     │ argument                        │ leakage)                                                       │
     ├─────────────────────────────────┼────────────────────────────────────────────────────────────────┤
     │ AuthContext per connection      │ MCP stdio = one process per agent = one identity per           │
     │ (singleton)                     │ connection                                                     │
     ├─────────────────────────────────┼────────────────────────────────────────────────────────────────┤
     │ Remove agent_id from 12+ tool   │ Identity from connection, not model output — eliminates        │
     │ schemas                         │ spoofing                                                       │
     ├─────────────────────────────────┼────────────────────────────────────────────────────────────────┤
     │ JWKS as primary verify strategy │ OMD tokens are issuer-signed (RS256), not shared-secret; JWKS  │
     │                                 │ is standard                                                    │
     ├─────────────────────────────────┼────────────────────────────────────────────────────────────────┤
     │ config-only as default          │ Zero breaking changes, opt-in security                         │
     ├─────────────────────────────────┼────────────────────────────────────────────────────────────────┤
     │ agent:// URIs (internal         │ Stable audit identifier, not claiming WIMSE/SPIFFE compliance  │
     │ convention)                     │                                                                │
     ├─────────────────────────────────┼────────────────────────────────────────────────────────────────┤
     │ Never log full tokens, only     │ Draft S10.8: "Resource servers SHOULD avoid logging full       │
     │ hash                            │ tokens"                                                        │
     ├─────────────────────────────────┼────────────────────────────────────────────────────────────────┤
     │ Registration ≠ attestation      │ Config existence is registration; attestation requires crypto  │
     │                                 │ proof (draft S7)                                               │
     └─────────────────────────────────┴────────────────────────────────────────────────────────────────┘

Plan approved. Let me start implementing. I'll work through the steps in order, creating tasks to track
progress.
