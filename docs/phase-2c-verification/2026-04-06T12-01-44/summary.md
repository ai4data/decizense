# Phase 2c Verification — 2026-04-06T12-01-44

## Gates
- [x] test-query.ts regression passed
- [x] test-auth.ts regression passed
- [x] test-opa-equivalence.ts 28/28 passed
- [x] decision_logs populated: 30 rows
- [x] replay correctly detected policy drift on tightened bundle

## Decision log sample
             opa_decision_id              |     agent_id     | tool_name  | allowed |                         bundle_revision                          |         timestamp          
------------------------------------------+------------------+------------+---------+------------------------------------------------------------------+----------------------------
 opa-68186f09-b269-4bdb-85e1-3c5c4b498427 | booking          | query_data | f       | 6f2d6259a36f86c63b07d930f7429694ea895c933b68eca8936b600b3655b3b2 | 2026-04-06 10:02:15.754618
 opa-5c84f1b8-9ac5-45d3-b6a0-63371e5b4a1a | customer_service | query_data | f       | 6f2d6259a36f86c63b07d930f7429694ea895c933b68eca8936b600b3655b3b2 | 2026-04-06 10:02:15.720617
 opa-a6d69461-8c74-41fd-9a27-c81084ed35b6 | orchestrator     | query_data | f       | 6f2d6259a36f86c63b07d930f7429694ea895c933b68eca8936b600b3655b3b2 | 2026-04-06 10:02:15.679937
 opa-cd498376-ed25-45a2-acef-5556877bcafd | flight_ops       | query_data | f       | 6f2d6259a36f86c63b07d930f7429694ea895c933b68eca8936b600b3655b3b2 | 2026-04-06 10:02:15.637783
 opa-ec37bb75-5ddc-4f83-9282-8c70ca8b8adc | booking          | query_data | f       | 6f2d6259a36f86c63b07d930f7429694ea895c933b68eca8936b600b3655b3b2 | 2026-04-06 10:02:15.585022
 opa-1913092d-f4ad-4214-9662-e12771e79065 | flight_ops       | query_data | f       | 6f2d6259a36f86c63b07d930f7429694ea895c933b68eca8936b600b3655b3b2 | 2026-04-06 10:02:15.545969
 opa-241af612-6385-41c6-b852-1e0f049e612f | booking          | query_data | f       | 6f2d6259a36f86c63b07d930f7429694ea895c933b68eca8936b600b3655b3b2 | 2026-04-06 10:02:15.503788
 opa-bfe2fe6a-6b7f-4d38-adc6-9860d493f709 | flight_ops       | query_data | f       | 6f2d6259a36f86c63b07d930f7429694ea895c933b68eca8936b600b3655b3b2 | 2026-04-06 10:02:15.455334
 opa-39f61c48-b10f-443e-ae8f-7351f777cb62 | flight_ops       | query_data | f       | 6f2d6259a36f86c63b07d930f7429694ea895c933b68eca8936b600b3655b3b2 | 2026-04-06 10:02:15.412379
 opa-eae37705-6b05-4945-8edc-e806b56d588e | flight_ops       | query_data | f       | 6f2d6259a36f86c63b07d930f7429694ea895c933b68eca8936b600b3655b3b2 | 2026-04-06 10:02:15.372995
(10 rows)


## Bundle revision
{
  "revision": "6f2d6259a36f86c63b07d930f7429694ea895c933b68eca8936b600b3655b3b2",
  "roots": [
    "dazense/governance"
  ]
}
