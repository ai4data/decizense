# ContextGraph-MCP Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the current harness into the ContextGraph-MCP product boundary, remove DBOS from the harness, move Decision/Memory durability to plain Postgres, and add durable OPA decision replay.

**Architecture:** The harness remains a stateless MCP server for agent workflow durability. Clients supply `case_id` for the business case and `request_id` for each side-effecting tool call; Postgres tables enforce idempotency and return prior results on retry. OPA evaluation stays fail-closed, while OPA decision log capture is best-effort and replayable through a private admin tool.

**Tech Stack:** TypeScript, MCP SDK, Postgres via `pg`, Zod, OPA sidecar, existing travel scenario Docker Compose.

---

## Scope Check

This plan covers Phase 1 only:

- Create the separate ContextGraph-MCP repository boundary from current `harness`, `policy`, and scenario contract files.
- Remove DBOS runtime, tools, package dependency, and workflow source from the harness.
- Replace DBOS-era decision persistence with plain Postgres tables and `request_id` dedupe.
- Capture OPA decisions into a durable sink correlated with `case_id` and `request_id`.
- Add private `replay_decision(decision_id)` admin replay.
- Keep Decizense frontend/backend and agent runtime wiring out of scope.

## File Structure

### Current repo files modified before extraction

- Modify: `harness/package.json` — remove `@dbos-inc/dbos-sdk`.
- Modify: `harness/package-lock.json` — regenerate without DBOS.
- Modify: `harness/src/server.ts` — remove DBOS init/shutdown and workflow tool registration.
- Delete: `harness/src/tools/workflow.ts` — removes `start_decision_workflow`.
- Delete: `harness/src/workflows/decision.ts` — removes DBOS workflow implementation.
- Delete: `harness/src/workflows/dbos-init.ts` — removes DBOS runtime boot.
- Create: `harness/src/tools/correlation.ts` — validates `case_id` and `request_id`, ensures case rows, and records audit responses.
- Create: `harness/src/tools/tool-response.ts` — small helpers to return JSON MCP text responses consistently.
- Modify: `harness/src/tools/persist.ts` — switch writes to `cases`, `proposals`, `approvals`, `outcomes`, `findings`, `memory_entries`, and `audit_log`.
- Modify: `harness/src/tools/action.ts` — accept `case_id` and `request_id` for governed query calls so OPA logs correlate to the MCP tool call.
- Modify: `harness/src/semantic/types.ts` — add optional `case_id` and `request_id` to metric query request type.
- Modify: `harness/src/semantic/executor.ts` — forward `case_id` and `request_id` into governance.
- Modify: `harness/src/governance/index.ts` — add `case_id` and `request_id` to `EvaluateGovernanceParams` and OPA input flow.
- Modify: `harness/src/governance/opa-client.ts` — write to `opa_decisions`, not legacy `decision_logs`, and add replay helper.
- Modify: `harness/src/tools/admin.ts` — replace `replay_outcome` with private `replay_decision(decision_id)` backed by `opa_decisions`.
- Modify: `scenario/travel/databases/init.sql` — replace DBOS-era decision workflow tables with plain Postgres tables.
- Create: `harness/src/tests/test-db-free-dbos-removal.ts` — static test that DBOS and workflow tool are gone.
- Create: `harness/src/tests/test-postgres-idempotency.ts` — integration test for `request_id` retry dedupe.
- Create: `harness/src/tests/test-opa-decision-replay.ts` — integration test for OPA capture and replay.
- Modify: `scripts/smoke-test.sh` — add the new tests to the smoke path.
- Delete: `scripts/test-crash-recovery.sh` — DBOS crash recovery is no longer a harness behavior.

### Separate repo boundary

- Create sibling repo: `..\contextgraph-mcp`
- Copy into it after current repo tests pass:
    - `harness\`
    - `policy\`
    - `scenario\_fixtures\`
    - `scenario\travel\` as the MVP demo pack
    - `docker\docker-compose.opa.yml`
    - `docs\superpowers\specs\2026-06-03-contextgraph-mcp-design.md`

---

## Tasks

### Task 1: Create Phase 1 branch and baseline

**Files:**

- Read: `docs/superpowers/specs/2026-06-03-contextgraph-mcp-design.md`
- Modify: none

- [ ] **Step 1: Create the implementation branch**

Run from `C:\Users\hzmarrou\OneDrive\python\projects\decizense`:

```powershell
git switch -c contextgraph-mcp-phase-1
```

Expected: branch switches to `contextgraph-mcp-phase-1`.

- [ ] **Step 2: Build the current harness baseline**

Run:

```powershell
Set-Location harness
npm run build
Set-Location ..
```

Expected: TypeScript build succeeds before edits.

- [ ] **Step 3: Record the known smoke baseline**

Run:

```powershell
bash scripts/smoke-test.sh
```

Expected: either `"[smoke] OK"` or a clear environment failure such as Docker/OPA not running. If it fails for environment only, record the exact failure in the task notes and continue with unit/static tests.

- [ ] **Step 4: Commit the clean baseline marker**

Run:

```powershell
git status --short
```

Expected: no tracked source changes from this task. Do not commit if only unrelated untracked files are present.

### Task 2: Remove DBOS runtime and workflow tool

**Files:**

- Modify: `harness/package.json`
- Modify: `harness/package-lock.json`
- Modify: `harness/src/server.ts`
- Delete: `harness/src/tools/workflow.ts`
- Delete: `harness/src/workflows/decision.ts`
- Delete: `harness/src/workflows/dbos-init.ts`
- Create: `harness/src/tests/test-db-free-dbos-removal.ts`

- [ ] **Step 1: Write the failing static test**

Create `harness/src/tests/test-db-free-dbos-removal.ts`:

```ts
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface Assertion {
	ok: boolean;
	label: string;
	detail?: string;
}

const results: Assertion[] = [];

function assert(condition: boolean, label: string, detail?: string): void {
	results.push({ ok: condition, label, detail: condition ? undefined : detail });
}

const here = dirname(fileURLToPath(import.meta.url));
const harnessRoot = resolve(here, '..', '..');
const packageJson = readFileSync(resolve(harnessRoot, 'package.json'), 'utf8');
const serverTs = readFileSync(resolve(harnessRoot, 'src', 'server.ts'), 'utf8');

assert(!packageJson.includes('@dbos-inc/'), 'harness package.json has no @dbos-inc dependency');
assert(!serverTs.includes('initDbos'), 'server does not import or call initDbos');
assert(!serverTs.includes('shutdownDbos'), 'server does not import or call shutdownDbos');
assert(!serverTs.includes('registerWorkflowTools'), 'server does not register workflow tools');
assert(!existsSync(resolve(harnessRoot, 'src', 'tools', 'workflow.ts')), 'workflow MCP tool file is deleted');
assert(!existsSync(resolve(harnessRoot, 'src', 'workflows')), 'DBOS workflows directory is deleted');

console.log('DBOS removal regression\n');
let failed = 0;
for (const result of results) {
	console.log(`  ${result.ok ? '✓' : '✗'} ${result.label}${result.detail ? ` — ${result.detail}` : ''}`);
	if (!result.ok) failed++;
}

if (failed > 0) {
	console.error(`\n${failed} assertion(s) failed`);
	process.exit(1);
}

console.log(`\n✅ All ${results.length} assertions passed`);
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```powershell
Set-Location harness
npx tsx src/tests/test-db-free-dbos-removal.ts
Set-Location ..
```

Expected: FAIL because `@dbos-inc/dbos-sdk`, workflow files, and server registrations still exist.

- [ ] **Step 3: Remove DBOS dependency**

Edit `harness/package.json` and delete this dependency line:

```json
"@dbos-inc/dbos-sdk": "^4.13.5",
```

Then regenerate the lockfile:

```powershell
Set-Location harness
npm install --package-lock-only
Set-Location ..
```

Expected: `harness/package-lock.json` no longer contains `@dbos-inc/dbos-sdk`.

- [ ] **Step 4: Remove DBOS server wiring**

Edit `harness/src/server.ts`:

Remove imports:

```ts
import { registerWorkflowTools } from './tools/workflow.js';
import { initDbos, shutdownDbos } from './workflows/dbos-init.js';
```

Remove registration:

```ts
registerWorkflowTools(server); // Plan v3 Phase 1b — DBOS workflow tools
```

Remove the HTTP startup block:

```ts
if (process.env.DBOS_DISABLED !== 'true') {
	await initDbos(loader.scenario);
} else {
	console.error('[dbos] disabled via DBOS_DISABLED=true');
}
```

Remove shutdown call:

```ts
await shutdownDbos();
```

- [ ] **Step 5: Delete workflow files**

Run:

```powershell
Remove-Item harness\src\tools\workflow.ts
Remove-Item -Recurse harness\src\workflows
```

Expected: `harness\src\tools\workflow.ts` and `harness\src\workflows\` are gone.

- [ ] **Step 6: Run the static test and build**

Run:

```powershell
Set-Location harness
npx tsx src/tests/test-db-free-dbos-removal.ts
npm run build
Set-Location ..
```

Expected: static test passes and build passes.

- [ ] **Step 7: Commit**

Run:

```powershell
git add harness\package.json harness\package-lock.json harness\src\server.ts harness\src\tests\test-db-free-dbos-removal.ts
git add -u harness\src\tools\workflow.ts harness\src\workflows
git commit -m "refactor: remove DBOS workflow runtime from harness" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

Expected: commit succeeds.

### Task 3: Add plain Postgres schema for cases, request dedupe, decision memory, and OPA decisions

**Files:**

- Modify: `scenario/travel/databases/init.sql`
- Create: `harness/src/tests/test-postgres-idempotency.ts`

- [ ] **Step 1: Replace DBOS-era decision schema**

In `scenario/travel/databases/init.sql`, replace the old Layer 4 block from `CREATE TABLE decision_proposals` through the old `decision_logs` table with this schema:

```sql
CREATE TABLE cases (
    case_id UUID PRIMARY KEY,
    session_id VARCHAR(100),
    created_by_agent_id VARCHAR(50) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'completed', 'cancelled')),
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE audit_log (
    request_id UUID PRIMARY KEY,
    case_id UUID NOT NULL REFERENCES cases(case_id),
    tool_name VARCHAR(100) NOT NULL,
    agent_id VARCHAR(50) NOT NULL,
    request JSONB NOT NULL DEFAULT '{}',
    response JSONB NOT NULL DEFAULT '{}',
    status VARCHAR(20) NOT NULL CHECK (status IN ('completed', 'failed')),
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE proposals (
    proposal_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id UUID NOT NULL REFERENCES cases(case_id),
    request_id UUID NOT NULL UNIQUE,
    session_id VARCHAR(100) NOT NULL,
    agent_id VARCHAR(50) NOT NULL,
    proposed_action TEXT NOT NULL,
    confidence VARCHAR(10) NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
    risk_class VARCHAR(10) NOT NULL CHECK (risk_class IN ('low', 'medium', 'high', 'critical')),
    evidence_event_ids INTEGER[],
    evidence_signal_types TEXT[],
    evidence_rules TEXT[],
    status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'rejected', 'executed', 'completed')),
    auth_method VARCHAR(20),
    token_hash VARCHAR(16),
    delegated_subject VARCHAR(100),
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE approvals (
    approval_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id UUID NOT NULL REFERENCES cases(case_id),
    request_id UUID NOT NULL UNIQUE,
    proposal_id UUID NOT NULL REFERENCES proposals(proposal_id),
    approved_by VARCHAR(100) NOT NULL,
    approved BOOLEAN NOT NULL,
    reason TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE outcomes (
    outcome_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id UUID NOT NULL REFERENCES cases(case_id),
    request_id UUID NOT NULL UNIQUE,
    proposal_id UUID REFERENCES proposals(proposal_id),
    session_id VARCHAR(100) NOT NULL,
    question TEXT NOT NULL,
    decision_summary TEXT NOT NULL,
    reasoning TEXT NOT NULL,
    confidence VARCHAR(10) NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
    agents_involved TEXT[] NOT NULL,
    cost_usd DECIMAL(10, 4),
    evidence_event_ids INTEGER[],
    evidence_rules TEXT[],
    evidence_signal_types TEXT[],
    evidence_proposal_ids UUID[],
    auth_method VARCHAR(20),
    token_hash VARCHAR(16),
    delegated_subject VARCHAR(100),
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE findings (
    finding_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id UUID NOT NULL REFERENCES cases(case_id),
    request_id UUID NOT NULL UNIQUE,
    session_id VARCHAR(100) NOT NULL,
    agent_id VARCHAR(50) NOT NULL,
    finding TEXT NOT NULL,
    confidence VARCHAR(10) NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
    data_sources TEXT[],
    auth_method VARCHAR(20),
    token_hash VARCHAR(16),
    delegated_subject VARCHAR(100),
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE memory_entries (
    memory_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id UUID REFERENCES cases(case_id),
    request_id UUID UNIQUE,
    memory_type VARCHAR(20) NOT NULL CHECK (memory_type IN ('episodic', 'semantic', 'procedural')),
    scope_type VARCHAR(10) NOT NULL CHECK (scope_type IN ('agent', 'bundle', 'global')),
    scope_id VARCHAR(100) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'candidate'
        CHECK (status IN ('candidate', 'active', 'stale', 'superseded', 'retracted')),
    title VARCHAR(200) NOT NULL,
    summary TEXT NOT NULL,
    content JSONB NOT NULL DEFAULT '{}',
    confidence DECIMAL(3,2) NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    valid_from TIMESTAMP NOT NULL DEFAULT NOW(),
    valid_to TIMESTAMP,
    expires_at TIMESTAMP,
    last_revalidated_at TIMESTAMP,
    source_outcome_id UUID,
    source_proposal_id UUID,
    evidence_event_ids INTEGER[],
    evidence_rules TEXT[],
    evidence_signal_types TEXT[]
);

CREATE TABLE opa_decisions (
    decision_id VARCHAR(100) PRIMARY KEY,
    case_id UUID,
    request_id UUID,
    original_bundle_revision VARCHAR(64) NOT NULL,
    timestamp TIMESTAMP NOT NULL DEFAULT NOW(),
    agent_id VARCHAR(50) NOT NULL,
    session_id VARCHAR(100),
    tool_name VARCHAR(50) NOT NULL,
    sql_hash VARCHAR(64),
    input JSONB NOT NULL,
    original_result JSONB NOT NULL,
    original_allowed BOOLEAN NOT NULL,
    contract_id VARCHAR(100),
    delegated_subject VARCHAR(100)
);

CREATE INDEX idx_cases_session ON cases(session_id);
CREATE INDEX idx_audit_case ON audit_log(case_id);
CREATE INDEX idx_proposals_case ON proposals(case_id);
CREATE INDEX idx_approvals_case ON approvals(case_id);
CREATE INDEX idx_outcomes_case ON outcomes(case_id);
CREATE INDEX idx_findings_case ON findings(case_id);
CREATE INDEX idx_memory_case ON memory_entries(case_id);
CREATE INDEX idx_memory_scope ON memory_entries(scope_type, scope_id);
CREATE INDEX idx_memory_status ON memory_entries(status);
CREATE INDEX idx_opa_decisions_case ON opa_decisions(case_id);
CREATE INDEX idx_opa_decisions_request ON opa_decisions(request_id);
CREATE INDEX idx_opa_decisions_bundle ON opa_decisions(original_bundle_revision);
CREATE INDEX idx_opa_decisions_timestamp ON opa_decisions(timestamp);
```

Keep `agent_memory` only if backward compatibility is required for existing `recall_memory`; new writes must use `memory_entries`.

- [ ] **Step 2: Remove old DBOS schema references**

In `scenario/travel/databases/init.sql`, remove these objects:

```sql
decision_workflow_runs
uniq_workflow_runs_workflow_id
uniq_proposals_workflow_id
uniq_actions_workflow_id
uniq_outcomes_workflow_id
decision_logs
```

Also remove comments that mention DBOS, workflow checkpoints, or `workflow_id`.

- [ ] **Step 3: Write schema validation test**

Create `harness/src/tests/test-postgres-idempotency.ts`:

```ts
import { randomUUID } from 'node:crypto';

import { closeDatabase, executeQuery, initDatabase } from '../database/index.js';

const db = {
	host: process.env.PGHOST ?? '127.0.0.1',
	port: Number(process.env.PGPORT ?? 5432),
	database: process.env.PGDATABASE ?? 'travel_db',
	user: process.env.PGUSER ?? 'travel_admin',
	password: process.env.PGPASSWORD ?? 'travel_pass',
};

async function main(): Promise<void> {
	initDatabase(db);
	const caseId = randomUUID();
	const requestId = randomUUID();

	await executeQuery(
		`INSERT INTO cases (case_id, session_id, created_by_agent_id)
		 VALUES ($1, $2, $3)
		 ON CONFLICT (case_id) DO NOTHING`,
		[caseId, 'test-session', 'flight_ops'],
	);

	const first = await executeQuery(
		`INSERT INTO findings (case_id, request_id, session_id, agent_id, finding, confidence)
		 VALUES ($1, $2, $3, $4, $5, $6)
		 ON CONFLICT (request_id) DO NOTHING
		 RETURNING finding_id`,
		[caseId, requestId, 'test-session', 'flight_ops', 'same finding', 'high'],
	);

	const second = await executeQuery(
		`INSERT INTO findings (case_id, request_id, session_id, agent_id, finding, confidence)
		 VALUES ($1, $2, $3, $4, $5, $6)
		 ON CONFLICT (request_id) DO NOTHING
		 RETURNING finding_id`,
		[caseId, requestId, 'test-session', 'flight_ops', 'same finding', 'high'],
	);

	const count = await executeQuery(`SELECT COUNT(*)::int AS count FROM findings WHERE request_id = $1`, [requestId]);
	const countValue = (count.rows[0] as { count: number }).count;

	if (first.rowCount !== 1) throw new Error(`expected first insert rowCount=1, got ${first.rowCount}`);
	if (second.rowCount !== 0) throw new Error(`expected retry insert rowCount=0, got ${second.rowCount}`);
	if (countValue !== 1) throw new Error(`expected exactly one finding for request_id, got ${countValue}`);

	await closeDatabase();
	console.log('✅ Postgres request_id dedupe works');
}

main().catch(async (err) => {
	await closeDatabase();
	console.error(err);
	process.exit(1);
});
```

- [ ] **Step 4: Run the schema test against the travel database**

Run:

```powershell
Set-Location scenario\travel\databases
docker compose down -v
docker compose up -d travel-postgres
Set-Location ..\..\..
Set-Location harness
npx tsx src/tests/test-postgres-idempotency.ts
Set-Location ..
```

Expected: `✅ Postgres request_id dedupe works`.

- [ ] **Step 5: Commit**

Run:

```powershell
git add scenario\travel\databases\init.sql harness\src\tests\test-postgres-idempotency.ts
git commit -m "feat: add plain Postgres decision persistence schema" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

Expected: commit succeeds.

### Task 4: Add correlation and idempotent response helpers

**Files:**

- Create: `harness/src/tools/tool-response.ts`
- Create: `harness/src/tools/correlation.ts`

- [ ] **Step 1: Create JSON response helper**

Create `harness/src/tools/tool-response.ts`:

```ts
export interface JsonToolResponse {
	content: Array<{ type: 'text'; text: string }>;
}

export function jsonResponse(payload: unknown): JsonToolResponse {
	return {
		content: [{ type: 'text', text: JSON.stringify(payload) }],
	};
}

export function prettyJsonResponse(payload: unknown): JsonToolResponse {
	return {
		content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
	};
}
```

- [ ] **Step 2: Create correlation helper**

Create `harness/src/tools/correlation.ts`:

```ts
import { z } from 'zod';

import { executeQuery } from '../database/index.js';
import type { AuthContext } from '../auth/context.js';
import { jsonResponse, type JsonToolResponse } from './tool-response.js';

export const correlationSchema = {
	case_id: z.string().uuid().describe('Business case UUID shared across all related tool calls'),
	request_id: z.string().uuid().describe('Per-tool-call UUID used for idempotent retry dedupe'),
};

export interface CorrelationInput {
	case_id: string;
	request_id: string;
}

export async function ensureCase(caseId: string, sessionId: string | null, ctx: AuthContext): Promise<void> {
	await executeQuery(
		`INSERT INTO cases (case_id, session_id, created_by_agent_id)
		 VALUES ($1, $2, $3)
		 ON CONFLICT (case_id) DO NOTHING`,
		[caseId, sessionId, ctx.agentId],
	);
}

export async function findPriorResponse(requestId: string, toolName: string): Promise<JsonToolResponse | null> {
	const result = await executeQuery(
		`SELECT response
		 FROM audit_log
		 WHERE request_id = $1 AND tool_name = $2 AND status = 'completed'
		 LIMIT 1`,
		[requestId, toolName],
	);
	if (result.rowCount === 0) return null;
	return jsonResponse((result.rows[0] as { response: unknown }).response);
}

export async function recordToolResponse(
	toolName: string,
	correlation: CorrelationInput,
	ctx: AuthContext,
	request: unknown,
	response: unknown,
): Promise<void> {
	await executeQuery(
		`INSERT INTO audit_log (request_id, case_id, tool_name, agent_id, request, response, status)
		 VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, 'completed')
		 ON CONFLICT (request_id) DO NOTHING`,
		[
			correlation.request_id,
			correlation.case_id,
			toolName,
			ctx.agentId,
			JSON.stringify(request),
			JSON.stringify(response),
		],
	);
}

export async function withIdempotentWrite(
	toolName: string,
	correlation: CorrelationInput,
	ctx: AuthContext,
	sessionId: string | null,
	request: unknown,
	write: () => Promise<unknown>,
): Promise<JsonToolResponse> {
	const prior = await findPriorResponse(correlation.request_id, toolName);
	if (prior) return prior;

	await ensureCase(correlation.case_id, sessionId, ctx);
	const response = await write();
	await recordToolResponse(toolName, correlation, ctx, request, response);
	return jsonResponse(response);
}
```

- [ ] **Step 3: Build**

Run:

```powershell
Set-Location harness
npm run build
Set-Location ..
```

Expected: build passes.

- [ ] **Step 4: Commit**

Run:

```powershell
git add harness\src\tools\tool-response.ts harness\src\tools\correlation.ts
git commit -m "feat: add request correlation helpers" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

Expected: commit succeeds.

### Task 5: Rewrite Decision and Memory tools to plain Postgres with `case_id` and `request_id`

**Files:**

- Modify: `harness/src/tools/persist.ts`
- Modify: `harness/src/tools/context.ts`
- Modify: `harness/src/tools/admin.ts`

- [ ] **Step 1: Update imports**

In `harness/src/tools/persist.ts`, replace:

```ts
import { createHash } from 'crypto';
```

with imports:

```ts
import { correlationSchema, withIdempotentWrite } from './correlation.js';
import { jsonResponse } from './tool-response.js';
```

Remove `computeFindingIdempotencyKey` and `computeOutcomeIdempotencyKey`; `request_id` is now the idempotency key.

- [ ] **Step 2: Add `case_id` and `request_id` to write tool schemas**

For each side-effecting tool schema in `persist.ts`, add:

```ts
...correlationSchema,
```

Apply this to:

- `write_finding`
- `propose_decision`
- `approve_decision`
- `execute_decision_action`
- `record_outcome`
- `save_memory`

- [ ] **Step 3: Rewrite `write_finding`**

Replace the `write_finding` handler body with:

```ts
async ({ case_id, request_id, session_id, finding, confidence, data_sources }, extra) => {
	const ctx = getCurrentAuthContext(extra);
	const safeFinding = filterPiiFromFinding(finding);

	return withIdempotentWrite(
		'write_finding',
		{ case_id, request_id },
		ctx,
		session_id,
		{ case_id, request_id, session_id, finding, confidence, data_sources },
		async () => {
			const result = await executeQuery(
				`INSERT INTO findings
				   (case_id, request_id, session_id, agent_id, finding, confidence,
				    data_sources, auth_method, token_hash, delegated_subject)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
				 ON CONFLICT (request_id) DO NOTHING
				 RETURNING finding_id, created_at`,
				[
					case_id,
					request_id,
					session_id,
					ctx.agentId,
					safeFinding,
					confidence,
					data_sources ?? null,
					ctx.authMethod,
					ctx.tokenHash,
					ctx.delegatedSubject,
				],
			);
			const row =
				result.rowCount > 0
					? (result.rows[0] as { finding_id: string; created_at: string })
					: ((
							await executeQuery(
								`SELECT finding_id, created_at FROM findings WHERE request_id = $1 LIMIT 1`,
								[request_id],
							)
						).rows[0] as { finding_id: string; created_at: string });

			return {
				finding_id: row.finding_id,
				case_id,
				request_id,
				session_id,
				agent_id: ctx.agentId,
				stored: true,
				timestamp: row.created_at,
			};
		},
	);
};
```

- [ ] **Step 4: Rewrite proposal, approval, action, and outcome SQL table names**

Use these table mappings in `persist.ts`:

```text
decision_proposals  -> proposals
decision_approvals  -> approvals
decision_actions    -> remove as a separate table; store action execution as proposal status plus outcome evidence
decision_outcomes   -> outcomes
decision_findings   -> findings
```

For `execute_decision_action`, keep the MCP tool response but do not create a separate `decision_actions` row. Update `proposals.status = 'executed'` and return:

```ts
{
	case_id,
	request_id,
	proposal_id,
	action_type,
	status: 'completed',
	timestamp: new Date().toISOString()
}
```

For `record_outcome`, insert into `outcomes` with:

```sql
INSERT INTO outcomes
  (case_id, request_id, proposal_id, session_id, question, decision_summary,
   reasoning, confidence, agents_involved, cost_usd, evidence_event_ids,
   evidence_rules, evidence_signal_types, evidence_proposal_ids, auth_method,
   token_hash, delegated_subject)
VALUES
  ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10, $11::integer[],
   $12::text[], $13::text[], $14::uuid[], $15, $16, $17)
ON CONFLICT (request_id) DO NOTHING
RETURNING outcome_id, created_at
```

- [ ] **Step 5: Rewrite memory writes**

Change `save_memory` to write only `memory_entries`:

```sql
INSERT INTO memory_entries
  (case_id, request_id, memory_type, scope_type, scope_id, status, title, summary, content, confidence)
VALUES
  ($1, $2, 'semantic', 'agent', $3, 'candidate', $4, $5, $6::jsonb, 0.5)
ON CONFLICT (request_id) DO NOTHING
RETURNING memory_id, created_at
```

Return:

```ts
{
	memory_id: row.memory_id,
	case_id,
	request_id,
	agent_id: ctx.agentId,
	key,
	saved: true,
	timestamp: row.created_at
}
```

- [ ] **Step 6: Update read/query tools to new table names**

Update these queries:

- `read_findings`: read from `findings`.
- `search_precedent` in `harness/src/tools/context.ts`: read from `outcomes`.
- `graph_stats` in `harness/src/tools/admin.ts`: count from `outcomes` and `findings`.
- `audit_decisions` in `harness/src/tools/admin.ts`: read from `outcomes`, `proposals`, and `approvals`.
- `recall_memory`: keep reading from `memory_entries`; remove dependence on `agent_memory` if `save_memory` no longer writes it.

- [ ] **Step 7: Build**

Run:

```powershell
Set-Location harness
npm run build
Set-Location ..
```

Expected: build passes.

- [ ] **Step 8: Run idempotency test**

Run:

```powershell
Set-Location harness
npx tsx src/tests/test-postgres-idempotency.ts
Set-Location ..
```

Expected: `✅ Postgres request_id dedupe works`.

- [ ] **Step 9: Commit**

Run:

```powershell
git add harness\src\tools\persist.ts harness\src\tools\context.ts harness\src\tools\admin.ts
git commit -m "feat: persist decisions with case request dedupe" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

Expected: commit succeeds.

### Task 6: Correlate governed query calls with OPA decision logs

**Files:**

- Modify: `harness/src/tools/action.ts`
- Modify: `harness/src/semantic/types.ts`
- Modify: `harness/src/semantic/executor.ts`
- Modify: `harness/src/governance/index.ts`
- Modify: `harness/src/governance/opa-client.ts`

- [ ] **Step 1: Extend query tool schemas**

In `harness/src/tools/action.ts`, import:

```ts
import { correlationSchema } from './correlation.js';
```

Add to `query_data` schema:

```ts
...correlationSchema,
```

Change handler signature to:

```ts
async ({ case_id, request_id, sql, reason }, extra) => {
```

Call governance as:

```ts
const governance = await evaluateGovernance({ authContext: ctx, sql, case_id, request_id });
```

Add to `query_metrics` schema:

```ts
...correlationSchema,
```

- [ ] **Step 2: Extend metric request type**

In `harness/src/semantic/types.ts`, add to `MetricQueryRequest`:

```ts
case_id?: string;
request_id?: string;
```

- [ ] **Step 3: Forward correlation through semantic executor**

In `harness/src/semantic/executor.ts`, add to `evaluateGovernance` call:

```ts
case_id: request.case_id,
request_id: request.request_id,
```

- [ ] **Step 4: Extend governance params**

In `harness/src/governance/index.ts`, add fields to `EvaluateGovernanceParams`:

```ts
case_id?: string;
request_id?: string;
```

Change OPA evaluation call to:

```ts
const opaResult = await opaEvaluate(
	opaInput,
	sessionId ?? undefined,
	undefined,
	delegatedSubject,
	params.case_id,
	params.request_id,
);
```

- [ ] **Step 5: Rewrite OPA log sink**

In `harness/src/governance/opa-client.ts`, update `evaluate` signature:

```ts
export async function evaluate(
	input: OpaInput,
	sessionId?: string,
	contractId?: string,
	delegatedSubject?: string | null,
	caseId?: string,
	requestId?: string,
): Promise<OpaEvalResult> {
```

Update `logDecision` signature and insert:

```ts
async function logDecision(
	decisionId: string,
	input: OpaInput,
	result: OpaEvalResult,
	sessionId?: string,
	contractId?: string,
	delegatedSubject?: string | null,
	caseId?: string,
	requestId?: string,
): Promise<void> {
	const sqlHash = input.sql ? createHash('sha256').update(input.sql).digest('hex').slice(0, 64) : null;
	await executeQuery(
		`INSERT INTO opa_decisions
			(decision_id, case_id, request_id, original_bundle_revision, agent_id, session_id,
			 tool_name, sql_hash, input, original_result, original_allowed, contract_id, delegated_subject)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12, $13)
		 ON CONFLICT (decision_id) DO NOTHING`,
		[
			decisionId,
			caseId ?? null,
			requestId ?? null,
			result.bundle_revision ?? 'unknown',
			input.agent_id,
			sessionId ?? null,
			input.tool_name,
			sqlHash,
			JSON.stringify(input),
			JSON.stringify({ allow: result.allow, violations: result.violations }),
			result.allow,
			contractId ?? null,
			delegatedSubject ?? null,
		],
	);
}
```

Update `updateDecisionLogContract`:

```ts
export async function updateDecisionLogContract(decisionId: string, contractId: string): Promise<void> {
	await executeQuery(`UPDATE opa_decisions SET contract_id = $1 WHERE decision_id = $2`, [contractId, decisionId]);
}
```

- [ ] **Step 6: Preserve best-effort logging**

Keep this behavior in `evaluate`:

```ts
logDecision(decisionId, input, evalResult, sessionId, contractId, delegatedSubject, caseId, requestId).catch((err) => {
	process.stderr.write(`[opa-client] decision log write failed (swallowed): ${err}\n`);
});
```

Expected: OPA log capture failures do not block governed execution.

- [ ] **Step 7: Build**

Run:

```powershell
Set-Location harness
npm run build
Set-Location ..
```

Expected: build passes.

- [ ] **Step 8: Commit**

Run:

```powershell
git add harness\src\tools\action.ts harness\src\semantic\types.ts harness\src\semantic\executor.ts harness\src\governance\index.ts harness\src\governance\opa-client.ts
git commit -m "feat: correlate opa decisions with case requests" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

Expected: commit succeeds.

### Task 7: Add private `replay_decision(decision_id)` admin tool

**Files:**

- Modify: `harness/src/tools/admin.ts`
- Create: `harness/src/tests/test-opa-decision-replay.ts`

- [ ] **Step 1: Export replay helper from OPA client**

In `harness/src/governance/opa-client.ts`, add:

```ts
export async function replayDecisionInput(input: unknown): Promise<{ allow: boolean; violations: unknown[] }> {
	const resp = await fetch(`${OPA_URL}/v1/data/dazense/governance/result`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ input }),
	});
	if (!resp.ok) throw new Error(`OPA replay HTTP ${resp.status}`);
	const body = (await resp.json()) as { result?: { allow?: boolean; violations?: unknown[] } };
	return {
		allow: body.result?.allow ?? false,
		violations: body.result?.violations ?? [],
	};
}
```

- [ ] **Step 2: Replace `replay_outcome` with `replay_decision`**

In `harness/src/tools/admin.ts`, remove the local `replayViaOpa` helper and the `replay_outcome` tool.

Import:

```ts
import { getBundleRevision, replayDecisionInput } from '../governance/opa-client.js';
```

Register this tool:

```ts
server.tool(
	'replay_decision',
	'[Admin] Re-evaluate a stored OPA decision input against the current policy bundle',
	{
		decision_id: z.string().describe('Stored OPA decision ID to replay'),
	},
	async ({ decision_id }, extra) => {
		assertAdminAgent(extra);
		try {
			const logResult = await executeQuery(
				`SELECT decision_id, case_id, request_id, original_bundle_revision,
				        input, original_result, original_allowed, agent_id, tool_name, timestamp
				 FROM opa_decisions
				 WHERE decision_id = $1`,
				[decision_id],
			);
			if (logResult.rowCount === 0) {
				return {
					content: [
						{ type: 'text' as const, text: JSON.stringify({ error: `Decision ${decision_id} not found` }) },
					],
				};
			}

			const row = logResult.rows[0] as {
				decision_id: string;
				case_id: string | null;
				request_id: string | null;
				original_bundle_revision: string;
				input: unknown;
				original_result: unknown;
				original_allowed: boolean;
				agent_id: string;
				tool_name: string;
				timestamp: string;
			};

			const current = await replayDecisionInput(row.input);
			const currentBundleRevision = getBundleRevision() ?? 'unknown';

			return {
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify(
							{
								decision_id: row.decision_id,
								case_id: row.case_id,
								request_id: row.request_id,
								agent_id: row.agent_id,
								tool_name: row.tool_name,
								timestamp: row.timestamp,
								original_decision: {
									allowed: row.original_allowed,
									result: row.original_result,
									bundle_revision: row.original_bundle_revision,
								},
								current_decision: {
									allowed: current.allow,
									violations: current.violations,
									bundle_revision: currentBundleRevision,
								},
								match: row.original_allowed === current.allow,
							},
							null,
							2,
						),
					},
				],
			};
		} catch (err) {
			return {
				content: [{ type: 'text' as const, text: JSON.stringify({ error: (err as Error).message }) }],
			};
		}
	},
);
```

- [ ] **Step 3: Update policy drift report table names**

In `policy_drift_report`, query from `opa_decisions`:

```sql
SELECT decision_id, input, original_allowed, agent_id
FROM opa_decisions
```

Use `replayDecisionInput` for each row and compare `original_allowed` to `replay.allow`.

- [ ] **Step 4: Create replay integration test**

Create `harness/src/tests/test-opa-decision-replay.ts`:

```ts
import { randomUUID } from 'node:crypto';

import { closeDatabase, executeQuery, initDatabase } from '../database/index.js';
import { evaluate, replayDecisionInput } from '../governance/opa-client.js';

const db = {
	host: process.env.PGHOST ?? '127.0.0.1',
	port: Number(process.env.PGPORT ?? 5432),
	database: process.env.PGDATABASE ?? 'travel_db',
	user: process.env.PGUSER ?? 'travel_admin',
	password: process.env.PGPASSWORD ?? 'travel_pass',
};

async function main(): Promise<void> {
	initDatabase(db);

	const caseId = randomUUID();
	const requestId = randomUUID();

	const input = {
		agent_id: 'flight_ops',
		tool_name: 'query_data' as const,
		sql: 'SELECT flight_id FROM flights LIMIT 1',
		metric_refs: [],
		parsed: {
			tables: ['flights'],
			columns: ['flight_id'],
			has_limit: true,
			limit_value: 1,
			is_read_only: true,
			statement_count: 1,
			joins: [],
		},
	};

	const result = await evaluate(input, 'test-session', undefined, null, caseId, requestId);

	for (let attempt = 0; attempt < 20; attempt++) {
		const rows = await executeQuery(`SELECT decision_id FROM opa_decisions WHERE request_id = $1`, [requestId]);
		if (rows.rowCount > 0) break;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}

	const stored = await executeQuery(
		`SELECT decision_id, case_id, request_id, original_allowed, original_bundle_revision
		 FROM opa_decisions
		 WHERE request_id = $1`,
		[requestId],
	);

	if (stored.rowCount !== 1) throw new Error(`expected one stored OPA decision, got ${stored.rowCount}`);
	const row = stored.rows[0] as {
		decision_id: string;
		case_id: string;
		request_id: string;
		original_allowed: boolean;
		original_bundle_revision: string;
	};

	if (row.case_id !== caseId) throw new Error(`case_id mismatch: ${row.case_id}`);
	if (row.request_id !== requestId) throw new Error(`request_id mismatch: ${row.request_id}`);
	if (row.original_allowed !== result.allow) throw new Error('stored verdict does not match original verdict');
	if (!row.original_bundle_revision) throw new Error('original bundle revision missing');

	const replay = await replayDecisionInput(input);
	if (typeof replay.allow !== 'boolean') throw new Error('replay did not return a boolean verdict');

	await closeDatabase();
	console.log('✅ OPA decision capture and replay works');
}

main().catch(async (err) => {
	await closeDatabase();
	console.error(err);
	process.exit(1);
});
```

- [ ] **Step 5: Run replay test**

Run:

```powershell
docker compose -f docker\docker-compose.opa.yml up -d --force-recreate
Set-Location harness
npx tsx src/tests/test-opa-decision-replay.ts
Set-Location ..
```

Expected: `✅ OPA decision capture and replay works`.

- [ ] **Step 6: Build and commit**

Run:

```powershell
Set-Location harness
npm run build
Set-Location ..
git add harness\src\tools\admin.ts harness\src\governance\opa-client.ts harness\src\tests\test-opa-decision-replay.ts
git commit -m "feat: add opa decision replay admin tool" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

Expected: build passes and commit succeeds.

### Task 8: Update smoke tests and remove DBOS crash recovery script

**Files:**

- Modify: `scripts/smoke-test.sh`
- Delete: `scripts/test-crash-recovery.sh`

- [ ] **Step 1: Add new tests to smoke**

In `scripts/smoke-test.sh`, after the semantic compiler regression, add:

```bash
echo "[smoke] Running DBOS removal regression..."
cd "${ROOT_DIR}/harness"
./node_modules/.bin/tsx src/tests/test-db-free-dbos-removal.ts

echo "[smoke] Running Postgres idempotency regression..."
./node_modules/.bin/tsx src/tests/test-postgres-idempotency.ts

echo "[smoke] Running OPA decision replay regression..."
./node_modules/.bin/tsx src/tests/test-opa-decision-replay.ts
```

- [ ] **Step 2: Delete DBOS crash recovery script**

Run:

```powershell
Remove-Item scripts\test-crash-recovery.sh
```

Expected: the DBOS crash recovery script is gone.

- [ ] **Step 3: Search for forbidden DBOS references**

Run:

```powershell
rg "DBOS|@dbos-inc|start_decision_workflow|decision_workflow_runs|workflow_id|dbos\.workflow_status" harness scripts scenario
```

Expected: no matches in `harness`, `scripts`, or `scenario` except historical docs outside this implementation scope.

- [ ] **Step 4: Run smoke**

Run:

```powershell
bash scripts/smoke-test.sh
```

Expected: `"[smoke] OK"`.

- [ ] **Step 5: Commit**

Run:

```powershell
git add scripts\smoke-test.sh
git add -u scripts\test-crash-recovery.sh
git commit -m "test: update smoke coverage for dbos-free harness" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

Expected: commit succeeds.

### Task 9: Create the separate ContextGraph-MCP repository boundary

**Files:**

- Create outside current repo: `..\contextgraph-mcp\`
- Copy from current repo: `harness\`, `policy\`, selected `scenario\`, selected docs

- [ ] **Step 1: Create sibling repository**

Run from `C:\Users\hzmarrou\OneDrive\python\projects\decizense`:

```powershell
$target = "..\contextgraph-mcp"
New-Item -ItemType Directory -Force $target | Out-Null
Set-Location $target
git init
Set-Location ..\decizense
```

Expected: `..\contextgraph-mcp` exists and is a git repo.

- [ ] **Step 2: Copy extraction-owned files**

Run:

```powershell
Copy-Item -Recurse -Force harness ..\contextgraph-mcp\harness
Copy-Item -Recurse -Force policy ..\contextgraph-mcp\policy
New-Item -ItemType Directory -Force ..\contextgraph-mcp\scenario | Out-Null
Copy-Item -Recurse -Force scenario\_fixtures ..\contextgraph-mcp\scenario\_fixtures
Copy-Item -Recurse -Force scenario\travel ..\contextgraph-mcp\scenario\travel
New-Item -ItemType Directory -Force ..\contextgraph-mcp\docker | Out-Null
Copy-Item -Force docker\docker-compose.opa.yml ..\contextgraph-mcp\docker\docker-compose.opa.yml
New-Item -ItemType Directory -Force ..\contextgraph-mcp\docs\specs | Out-Null
Copy-Item -Force docs\superpowers\specs\2026-06-03-contextgraph-mcp-design.md ..\contextgraph-mcp\docs\specs\2026-06-03-contextgraph-mcp-design.md
```

Expected: ContextGraph-MCP repo contains only harness-owned runtime, policy, scenario examples, OPA compose, and spec.

- [ ] **Step 3: Add minimal repo README**

Create `..\contextgraph-mcp\README.md`:

````md
# ContextGraph-MCP

ContextGraph-MCP is a standalone governed MCP server for analytics agents.

It loads scenario packs, enforces governance through OPA, compiles semantic metric requests to safe SQL, stores decision and memory traces in Postgres, and exposes MCP tools to external clients.

Decizense is one possible client. Agents and UI products run outside this repository.

## Development smoke

```powershell
Set-Location harness
npm install
npm run build
Set-Location ..
bash scripts/smoke-test.sh
```
````

````

- [ ] **Step 4: Verify copied repo builds**

Run:

```powershell
Set-Location ..\contextgraph-mcp\harness
npm install
npm run build
Set-Location ..\..
Set-Location decizense
````

Expected: copied harness builds in the separate repo.

- [ ] **Step 5: Commit separate repo initial state**

Run:

```powershell
Set-Location ..\contextgraph-mcp
git add .
git commit -m "feat: create ContextGraph-MCP phase 1 extraction" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
Set-Location ..\decizense
```

Expected: separate repo has an initial commit. Do not push until the remote repository URL is known.

### Task 10: Final verification in current repo

**Files:**

- Read: all modified tracked files
- Modify: none unless verification exposes a bug

- [ ] **Step 1: Run TypeScript build**

Run:

```powershell
Set-Location harness
npm run build
Set-Location ..
```

Expected: build passes.

- [ ] **Step 2: Run targeted tests**

Run:

```powershell
Set-Location harness
npx tsx src/tests/test-db-free-dbos-removal.ts
npx tsx src/tests/test-postgres-idempotency.ts
npx tsx src/tests/test-opa-decision-replay.ts
Set-Location ..
```

Expected: all three tests pass.

- [ ] **Step 3: Run smoke**

Run:

```powershell
bash scripts/smoke-test.sh
```

Expected: `"[smoke] OK"`.

- [ ] **Step 4: Run final consistency search**

Run:

```powershell
rg "DBOS|@dbos-inc|start_decision_workflow|decision_workflow_runs|workflow_id|dbos\.workflow_status" harness scripts scenario
rg "decision_logs|replay_outcome" harness scenario scripts
rg "opa_decisions|replay_decision|case_id|request_id" harness scenario scripts
```

Expected:

- First command: no matches.
- Second command: no matches.
- Third command: matches in the new schema, OPA client, admin replay tool, action/query correlation, and persist tools.

- [ ] **Step 5: Commit any verification fixes**

If verification required code changes, run:

```powershell
git add harness scenario scripts
git commit -m "fix: complete contextgraph phase 1 verification" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

Expected: commit succeeds only if fixes were needed.

- [ ] **Step 6: Summarize Phase 1 handoff**

Run:

```powershell
git --no-pager log --oneline -n 8
git --no-pager status --short
```

Expected: Phase 1 commits are visible and no tracked source changes remain.

---

## Self-Review

Spec coverage:

- Separate repository/product boundary: Task 9.
- Remove DBOS from harness: Task 2 and Task 8.
- Plain Postgres decision/memory persistence: Task 3, Task 4, Task 5.
- `case_id` and `request_id` idempotency: Task 3, Task 4, Task 5, Task 6.
- Remove `start_decision_workflow`: Task 2 and Task 8.
- Session state remains in `harness/src/auth/context.ts`: no task changes that file.
- Durable OPA decision logging: Task 3 and Task 6.
- `replay_decision(decision_id)`: Task 7.
- Best-effort OPA log capture: Task 6.
- Duplicate `request_id` returns prior response: Task 4 and Task 5.
- Testing strategy: Task 2, Task 3, Task 7, Task 8, Task 10.

Placeholder scan:

- No task contains unresolved placeholders.
- Commands use concrete paths and expected outputs.
- Code snippets define the functions and table names used by later tasks.

Type consistency:

- `case_id` and `request_id` are strings at TypeScript boundaries and UUIDs in Postgres.
- `decision_id` is the public OPA replay identifier and maps to `opa_decisions.decision_id`.
- `request_id` is unique in `audit_log`, write tables, and `opa_decisions` indexes.
