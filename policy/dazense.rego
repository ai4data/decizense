# Phase 2a — dazense governance policy in Rego.
#
# This is the authoritative policy specification for the 8 governance checks
# that the harness runs on every query_data / query_metrics call. In Phase 2a
# OPA evaluates this policy in SHADOW mode — results are compared against
# the in-code TS implementation at harness/src/governance/index.ts but the
# in-code result is still returned to the caller. Mismatches are logged.
#
# Phase 2b cuts over: OPA becomes authoritative, in-code rules are deleted,
# this file becomes the single source of governance truth.
#
# Input shape (built by harness TS side from parseSql + AuthContext):
#   {
#     "agent_id": "flight_ops",
#     "tool_name": "query_data" | "query_metrics",
#     "sql": "SELECT ...",             # empty string when tool_name=query_metrics
#     "metric_refs": ["..."],          # empty array when tool_name=query_data
#     "parsed": {
#       "tables":          ["flights", "airports"],
#       "columns":         ["flight_id", "origin"],
#       "has_limit":       true,
#       "limit_value":     100,
#       "is_read_only":    true,
#       "statement_count": 1,
#       "joins":           [{"left_col": "origin", "right_col": "airport_code"}]
#     }
#   }
#
# Result document (read from /v1/data/dazense/governance/result):
#   {
#     "allow":       true|false,
#     "violations":  [{"check": "...", "detail": "..."}, ...],
#     "bundle_revision": "<sha256>"   # injected by opa-client from .manifest
#   }
#
# Data document (policy/data.json — built by policy/build.ts from scenario YAMLs):
#   see policy/build.ts for the exact shape.

package dazense.governance

import rego.v1

# ─────────────────────────────────────────────────────────────────────────────
# Top-level decision
# ─────────────────────────────────────────────────────────────────────────────

default allow := false

allow if count(violations) == 0

result := {
	"allow": allow,
	"violations": violations,
}

# Collect every violation in a single set. Each violation is
# {"check": "<name>", "detail": "<human readable>"}.
violations contains v if some v in _violations

# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

# The agent record, or null.
agent := data.agents[input.agent_id]

# The bundle record for this agent's bundle, or null.
bundle := data.bundles[agent.bundle] if agent.bundle != null

# Normalize a table reference by stripping a leading "public." prefix if
# present, matching the TS allow-list check in governance/index.ts:292.
normalize_table(t) := lower(trim_prefix(lower(t), "public."))

trim_prefix(s, prefix) := s2 if {
	startswith(s, prefix)
	s2 := substring(s, count(prefix), -1)
} else := s

# Is a table allowed for this agent's bundle?
# The TS code checks both the qualified ("public.flights") and unqualified
# ("flights") forms — data.json has both forms pre-computed in allowed_tables.
table_allowed(t) if {
	some allowed in bundle.allowed_tables
	lower(t) == allowed
}

table_allowed(t) if {
	some allowed in bundle.allowed_tables
	normalize_table(t) == allowed
}

# Does this query text reference a PII column?
# Mirrors governance/index.ts:385-398: either the column name appears as a
# word in the SQL, or SELECT * is used on a PII-bearing table.
sql_lower := lower(input.sql)

uses_select_star if regex.match(`select\s+\*`, sql_lower)

pii_hit(table_name, col) if regex.match(sprintf(`\b%s\b`, [lower(col)]), sql_lower)

pii_hit(table_name, col) if {
	uses_select_star
	some t in input.parsed.tables
	normalize_table(t) == lower(table_name)
}

# ─────────────────────────────────────────────────────────────────────────────
# Check 1: authenticate agent
# ─────────────────────────────────────────────────────────────────────────────

_violations contains v if {
	not data.agents[input.agent_id]
	v := {"check": "authenticate", "detail": sprintf("Unknown agent: %s", [input.agent_id])}
}

# ─────────────────────────────────────────────────────────────────────────────
# Check 2: can_query (domain agents may query, orchestrator may not)
# ─────────────────────────────────────────────────────────────────────────────

_violations contains v if {
	agent
	not agent.can_query
	v := {
		"check": "can_query",
		"detail": sprintf("Agent %s (%s) cannot execute queries", [input.agent_id, agent.role]),
	}
}

# The checks below only apply when SQL is present (i.e. tool_name=query_data).
has_sql if count(input.sql) > 0

# ─────────────────────────────────────────────────────────────────────────────
# Check 3: read-only (no write DDL/DML)
# ─────────────────────────────────────────────────────────────────────────────

_violations contains v if {
	has_sql
	not input.parsed.is_read_only
	v := {
		"check": "read_only",
		"detail": "Write operations (INSERT/UPDATE/DELETE/DROP) are not allowed",
	}
}

# ─────────────────────────────────────────────────────────────────────────────
# Check 4: single statement
# ─────────────────────────────────────────────────────────────────────────────

_violations contains v if {
	has_sql
	data.policy.disallow_multi_statement
	input.parsed.statement_count > 1
	v := {
		"check": "single_statement",
		"detail": sprintf("%d statements in query", [input.parsed.statement_count]),
	}
}

# ─────────────────────────────────────────────────────────────────────────────
# Check 5: bundle scope — all referenced tables must be in the agent's bundle
# ─────────────────────────────────────────────────────────────────────────────

_violations contains v if {
	has_sql
	agent
	agent.bundle != null
	some t in input.parsed.tables
	not table_allowed(t)
	v := {
		"check": "bundle_scope",
		"detail": sprintf("Table %s is not in bundle %s", [t, agent.bundle]),
	}
}

# ─────────────────────────────────────────────────────────────────────────────
# Check 5b: join allowlist — each JOIN must appear in the bundle's join list
# (in either direction)
# ─────────────────────────────────────────────────────────────────────────────

_violations contains v if {
	has_sql
	agent
	agent.bundle != null
	some j in input.parsed.joins
	not _join_allowed(j)
	v := {
		"check": "join_allowlist",
		"detail": sprintf("Join %s = %s not in bundle allowlist", [j.left_col, j.right_col]),
	}
}

_join_allowed(j) if {
	some allowed in bundle.joins
	allowed.left_col == j.left_col
	allowed.right_col == j.right_col
}

_join_allowed(j) if {
	some allowed in bundle.joins
	allowed.left_col == j.right_col
	allowed.right_col == j.left_col
}

# ─────────────────────────────────────────────────────────────────────────────
# Check 5c: execution permission — policy must allow SQL execution
# ─────────────────────────────────────────────────────────────────────────────

_violations contains v if {
	has_sql
	not data.policy.allow_execute_sql
	v := {
		"check": "execution_permission",
		"detail": "SQL execution is disabled by policy",
	}
}

# ─────────────────────────────────────────────────────────────────────────────
# Check 6: PII — no PII column may appear in the SQL (policy.pii.mode == "block")
# ─────────────────────────────────────────────────────────────────────────────

_violations contains v if {
	has_sql
	data.policy.pii_mode == "block"
	some table_name, cols in data.pii_columns
	some col in cols
	pii_hit(table_name, col)
	v := {
		"check": "pii_check",
		"detail": sprintf("PII column %s.%s is blocked", [table_name, col]),
	}
}

# ─────────────────────────────────────────────────────────────────────────────
# Check 7: LIMIT present and ≤ max_rows
# ─────────────────────────────────────────────────────────────────────────────

_violations contains v if {
	has_sql
	data.policy.enforce_limit
	not input.parsed.has_limit
	v := {
		"check": "limit_check",
		"detail": sprintf("Query must include a LIMIT clause (max %d)", [data.policy.max_rows]),
	}
}

_violations contains v if {
	has_sql
	data.policy.enforce_limit
	input.parsed.has_limit
	input.parsed.limit_value > data.policy.max_rows
	v := {
		"check": "limit_value",
		"detail": sprintf(
			"LIMIT %d exceeds max %d",
			[input.parsed.limit_value, data.policy.max_rows],
		),
	}
}
