# SDAP — Sensitive Data Access Protocol

**Status:** Draft — design proposal, no code yet.
**Intended layer:** sits on Layer 4 (Decision / Provenance) of [architecture.md](./architecture.md); complements [Agents_Auth.md](../../../learning/dazense-learn/Agents_Auth.md).
**Scope:** every governed read of classified data (PII, PHI, PCI, MNPI, privileged, export-controlled). Sector-neutral.

## 1. Problem

Today the harness enforces a **global** PII blocklist: `loader.getPiiColumns()` produces one `Set<string>` that applies to every agent in every scenario. Rights are binary and uniform — nobody can read classified columns, ever. Real deployments need conditional access:

- A support agent reading one customer's email to resolve ticket TKT-789.
- A fraud analyst reviewing one account's counterparty to close a case.
- A clinician reading one patient's medication list during an encounter.
- A compliance auditor exporting 200 transactions under a documented legal basis.

The shape is always the same:

```
(requester, subject, columns, scope, purpose, legal_basis, approval, audit)
```

Different sectors have different regulations (GDPR, HIPAA, PCI-DSS, SEC Reg FD, ITAR, legal privilege) but the mechanics are identical. SDAP is the one mechanism.

## 2. Where today's primitives fit

| Concern                                            | Existing primitive                                                                      | SDAP reuses it?                               |
| -------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------- |
| Agent identity (URI, JWT verification, delegation) | `harness/src/auth/*` ([Agents_Auth.md](../../../learning/dazense-learn/Agents_Auth.md)) | ✅ Unchanged                                  |
| Delegation / `act` claim capture                   | `AuthContext.delegatedSubject` / `delegationIssuer`                                     | ✅ Now used for authorisation, not just audit |
| Bundle (which tables)                              | `agents.yml.<agent>.bundle` + `loader.getBundle()`                                      | ✅ Unchanged — still required                 |
| Business rules                                     | `get_business_rules`                                                                    | ✅ Rules can reference purpose and subject    |
| Approval lifecycle                                 | `propose_decision → approve_decision → execute_decision_action → record_outcome`        | ✅ Becomes the approval gate for reveals      |
| Risk ladder                                        | `low / medium / high / critical` in `policy.yml`                                        | ✅ Applied to reveal scope                    |
| PII blocklist                                      | `loader.getPiiColumns()`                                                                | ⚠️ Split: absolute vs conditional             |
| Per-agent sensitive rights                         | **Does not exist today**                                                                | ➕ New, declared in `agents.yml`              |
| Classification policies per tag                    | **Does not exist today**                                                                | ➕ New, declared per scenario                 |
| Purpose catalogue                                  | **Does not exist today**                                                                | ➕ New, declared per scenario                 |

## 3. Core objects

### 3.1 Classification (per scenario)

Ships in the catalog (OMD tags) and is enumerated in a scenario-level policy file. Each classification carries default enforcement parameters. Individual agents may be granted more narrowly than the default, never more broadly.

```yaml
# scenario/<name>/classifications.yml
classifications:
    PII.Sensitive:
        regime: gdpr
        default_allow: never
        masking_supported: true
        retention_max_seconds: 3600

    PHI.HIPAA:
        regime: hipaa
        default_allow: never
        masking_supported: true
        retention_max_seconds: 1800

    PCI.Cardholder:
        regime: pci_dss
        default_allow: never
        masking_supported: true
        retention_max_seconds: 0 # in-memory only, never persisted in findings
```

### 3.2 Purpose catalogue (per scenario)

Free-text `purpose` strings are audit-useless. SDAP requires each reveal's purpose to come from an enumerated, scenario-specific catalogue. Adding a new purpose is a scenario edit, not a runtime decision.

```yaml
# scenario/travel/purposes.yml
purposes:
    support_ticket: { category: customer_service, requires_case_ref: true }
    disruption_rebook: { category: operations, requires_case_ref: true }
    compensation_eu261: { category: legal, requires_case_ref: true }
```

### 3.3 Agent rights declaration (per agent)

Added to `agents.yml`, alongside `bundle` / `role` / `can_query`:

```yaml
agents:
    booking:
        bundle: bookings
        role: domain
        can_query: true
        sensitive_access:
            - classification: PII.Sensitive
              allow: conditional
              scope: { max_subjects: 1 }
              requires: [subject_id, purpose]
              allowed_purposes: [support_ticket, disruption_rebook]
              requires_delegation: false
              risk_class: medium
              audit: required
              masking: { default: masked, unmask_requires_approval: true }

            - classification: PCI.Cardholder
              allow: never
```

### 3.4 Default-deny invariant

Any classification that appears in the catalog but is **not** listed in an agent's `sensitive_access` is treated as `allow: never` for that agent. There is no implicit permission.

## 4. Runtime contract

### 4.1 What `initialize_agent` returns (extended)

```jsonc
{
  "scope": {
    "tables": [...],                            // unchanged
    "measures": [...],                          // unchanged
    "allowed_joins": [...],                     // unchanged

    // --- SDAP additions ---
    "always_blocked": ["passwords.hash", ...],  // absolute — passwords, private keys
    "conditional": {                             // classified — access via request_sensitive_access
      "public.customers.email": {
        "classification": "PII.Sensitive",
        "policy_ref": "agents.booking.sensitive_access[0]"
      }
    }
  }
}
```

### 4.2 The request tool

A new dedicated tool the sub-agent's LLM can call (becomes available as part of the semantic-layer Tier 2 work):

```jsonc
request_sensitive_access({
  "columns":      ["public.customers.email"],
  "subject_id":   "customer:123",
  "scope":        { "count": 1 },
  "purpose":      "support_ticket",
  "purpose_ref":  "TKT-789",            // case ID — validated against open cases
  "legal_basis":  "legitimate_interest" // GDPR / HIPAA / PCI / ... enum per regime
})
```

Return shape:

```jsonc
{
  "status":       "granted" | "requires_approval" | "denied",
  "reason":       "...",                         // always populated
  "grant_id":     "grant-uuid",                  // if granted
  "unmasked":     { "email": "jane.d@example.com" },  // if granted + unmasked
  "masked":       { "email": "j*****@example.com" }   // if granted + masked
}
```

### 4.3 Downstream `query_data`

`query_data` stays governed by the same OPA policy. When a SELECT touches a conditional column, the call must carry a valid `grant_id`. The harness joins the grant record (subject, columns, purpose, expiry) with the SQL predicate; anything outside scope is blocked.

### 4.4 Purpose-binding on findings

Every `write_finding` / `record_outcome` that transitively used a grant records the grant ID. Downstream use of the finding for a different purpose triggers a governance warning — purpose binding surfaces misuse at reasoning time, not just at reveal time.

## 5. Enforcement chain

```
1. LLM calls request_sensitive_access(columns, subject, purpose, ...)
                ↓
2. Harness loads AuthContext (identity, bundle, delegation).
                ↓
3. Harness resolves column classifications from OMD tags.
                ↓
4. OPA evaluates:
     - Does agent have a sensitive_access entry for this classification?
     - Does scope (count, subject) fit max_subjects?
     - Is purpose in allowed_purposes?
     - If requires_delegation, does AuthContext.delegatedSubject match allowed_delegators?
                ↓
5. OPA returns: granted | requires_approval | denied
                ↓
6. If requires_approval → existing decision lifecycle:
     propose_decision(risk_class=medium) → approve_decision → execute
                ↓
7. If granted → harness issues grant_id + returns masked/unmasked values.
                ↓
8. record_outcome logs: (agent, delegated_subject, grant_id, columns,
                         subject, purpose, purpose_ref, scope, timestamp)
                ↓
9. Subsequent query_data / write_finding must quote grant_id;
   cross-purpose use flagged at inspection time.
```

Integration points (files):

- `harness/src/auth/context.ts` — pass `delegatedSubject` into OPA input (already captured, newly consumed)
- `harness/src/tools/control.ts` — split `blocked_columns` into `always_blocked` + `conditional`
- `harness/src/governance/index.ts` — accept `grant_id` in query evaluation, resolve against the grants table
- `harness/src/tools/action.ts` — `query_data` carries `grant_id` when touching conditional columns
- `harness/src/tools/...` (new) — `request_sensitive_access` tool
- `policy/` (Rego) — new module evaluating `sensitive_access` rules
- `harness/src/persist/` — `data_access_grants` table (grant_id, agent, subject, columns, purpose, expiry)

## 6. Worked example — travel support agent

### Agent config

```yaml
agents:
    support_agent:
        bundle: support-cases
        role: domain
        can_query: true
        sensitive_access:
            - classification: PII.Sensitive
              allow: conditional
              scope: { max_subjects: 1 }
              requires: [subject_id, purpose, purpose_ref]
              allowed_purposes: [support_ticket]
              requires_delegation: false
              risk_class: medium
              audit: required
```

### Flow

1. Ticket `TKT-789` arrives for customer 123: "I want to check my rebooking email."
2. LLM calls `request_sensitive_access({columns:["customers.email"], subject_id:"customer:123", scope:{count:1}, purpose:"support_ticket", purpose_ref:"TKT-789"})`.
3. OPA: classification = PII.Sensitive → agent's policy found → scope 1 ≤ 1 → purpose in catalogue → no delegation required → `granted` with masking=masked (policy default).
4. Harness returns `{ grant_id: "g-abc", masked: { email: "j*****@example.com" } }`.
5. LLM writes a finding referencing `grant_id: g-abc` and the masked value.
6. Customer replies "please confirm full address." LLM calls `request_sensitive_access(unmask=true, grant_id=g-abc)` → `risk_class: medium` + `unmask_requires_approval` → `requires_approval` → `propose_decision` → human approver on duty accepts → full email revealed.
7. `record_outcome` stores: agent=`support_agent`, subject=`customer:123`, columns=`[email]`, purpose=`support_ticket`, purpose_ref=`TKT-789`, unmasked=true, approver=`human:jane`.

## 7. Worked example — hospital clinician

### Agent config

```yaml
agents:
    clinician_agent:
        bundle: patient-care
        role: domain
        can_query: true
        sensitive_access:
            - classification: PHI.HIPAA
              allow: conditional
              scope: { max_subjects: 1 }
              requires: [subject_id, purpose, purpose_ref]
              allowed_purposes: [encounter, prescription, referral]
              requires_delegation: true
              allowed_delegators: group:clinical_staff
              risk_class: high
              audit: required
```

### Flow

1. Dr Smith opens the EHR; frontend mints a JWT with `sub: "agent:clinician_agent"` and `act: { sub: "user:dr_smith" }`.
2. Smith asks the agent for patient 987's medication list for encounter `ENC-456`.
3. LLM calls `request_sensitive_access({columns:["patients.medications"], subject_id:"patient:987", scope:{count:1}, purpose:"encounter", purpose_ref:"ENC-456"})`.
4. OPA: classification = PHI.HIPAA → policy requires delegation → `AuthContext.delegatedSubject = "user:dr_smith"` → is Smith in `group:clinical_staff`? Yes → scope fits → `granted`.
5. Finding records grant_id; outcome recorded with delegator `user:dr_smith`.
6. If later the agent is invoked without Smith's delegation (e.g. via a scheduled task), the same call returns `denied` — same agent, different context, different answer.

## 8. Progressive autonomy

Same pattern as [architecture.md Layer 5](./architecture.md#layer-5-actionpermission), specialised for reveals:

- Day 1: every grant above `scope.count > 1` routes through human approval.
- After N approved single-subject grants per agent with no violation: auto-approve single-subject.
- After a longer clean window: auto-approve small cohort (`count ≤ K`) for same purpose category.
- Bulk, cross-classification, or cross-purpose reveals: always human, often senior.

Autonomy counters live in `autonomy_stats` (already present) and are surfaced per-classification, not only per-agent.

## 9. Migration from today

No breaking changes to existing agents. The proposal is additive:

1. Ship `classifications.yml`, `purposes.yml`, and `sensitive_access` support as opt-in per scenario.
2. An agent with no `sensitive_access` block keeps today's behaviour: classified columns are globally blocked.
3. `initialize_agent` returns `conditional: {}` for those agents — unchanged observable behaviour.
4. The semantic-layer Tier-1 prompt already forwards `blocked_columns`; it simply also forwards `conditional` when Tier 2 lands, announcing the lookup tool.
5. OPA gets a new rule module but the existing bundle / PII / join checks stay.

## 10. Out of scope for this doc

- **Cryptographic proof of purpose** (e.g. signed tickets) — future work; for now we trust the caller's declared `purpose_ref` and validate against an existing case ID.
- **Differential privacy / k-anonymity** — orthogonal. SDAP handles authorisation; DP would handle aggregate-release safety.
- **Data residency / cross-border transfer rules** — a further classification dimension; the same protocol can carry `residency_constraints` per grant but the concrete enforcement belongs in infra, not the harness.
- **Consent management for data subjects** — out of scope here, but the protocol should accept a `consent_ref` field so a downstream consent registry can be plugged in without a re-design.

## 11. Open questions for review

1. **Grant lifetime.** Per call? Per session? Per case? Default recommendation: bounded by the classification's `retention_max_seconds` OR by explicit `expire_at`, whichever is sooner.
2. **Grant revocation.** Admin API to revoke an outstanding grant by ID? Expected, not designed yet.
3. **Data subjects as a first-class concept.** When the requester _is_ the subject (a passenger asking about their own bookings), the harness could model that relationship directly. Adds one AuthContext field; simplifies many consent flows.
4. **Purpose catalogue governance.** Should editing `purposes.yml` require a pull-request review and a policy owner's sign-off? Recommendation: yes, treat it like editing `policy.yml` or `business_rules.yml`.
5. **Masking policy.** Per-classification default masking vs per-agent override — who wins? Recommendation: classification default is a floor; agent can tighten but never loosen.

## 12. References

- [architecture.md](./architecture.md) — 5-layer architecture the protocol plugs into.
- [Agents_Auth.md](../../../learning/dazense-learn/Agents_Auth.md) — identity / delegation / JWT-SVID model SDAP relies on.
- RFC 8693 — OAuth 2.0 Token Exchange (the delegation mechanism surfaced via the `act` claim).
- GDPR Art. 6 — legal bases, mapped into the `legal_basis` enum.
- HIPAA Privacy Rule — minimum-necessary standard, the motivation for `scope.max_subjects`.
- PCI-DSS v4 — cardholder data masking and retention defaults.
