# 06 Architecture

The operations surface is a separate `/commerce` route in WebUI. It consumes only authenticated Commerce API DTOs and does not expose report filesystem paths or render untrusted HTML.

The read path is `task list -> task snapshot -> report/evidence/proposal/execution`. The recovery key is the durable task ID; `snapshotVersion`, event IDs and sequences make refresh and duplicate polling observable.

The monitor is deterministic and versioned. It persists cases and observations separately so a new data snapshot enriches an open case instead of opening a ticket storm. Detection text explicitly avoids causal claims.

Feedback and memory have different trust levels: feedback is an operator assertion awaiting review; case memory is written only after an authorized human review and expires.
