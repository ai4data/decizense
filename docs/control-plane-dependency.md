# External Control-Plane Dependency

## Source of Baseline

The trusted analytics control-plane baseline is maintained in:

- `/learning/dazense`

This includes prior implementation of:

- semantic definitions and business rules,
- contract/policy gating mechanics,
- governance graph foundations,
- existing analytics-oriented tutorials and plans.

## Rule for This Worktree

Do not evolve or duplicate the full legacy baseline documentation in this worktree.

This worktree should only document:

- what the twin runtime needs from the control plane,
- integration contracts at the boundary,
- decision-system-specific extensions.

## Expected Convergence

Convergence happens through stable interfaces and validated patterns, not through copying all historical docs into this worktree.
