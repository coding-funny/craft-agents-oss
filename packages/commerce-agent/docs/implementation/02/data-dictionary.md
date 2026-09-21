# Governed commerce data dictionary

## Import provenance

| Field | Meaning | Rule |
| --- | --- | --- |
| `sourceType` | `AUTHORIZED_EXPORT`, `SYNTHETIC_FIXTURE` or `HTTP_TEST_SOURCE` | Synthetic data cannot carry a fake authorization reference; authorized exports require one |
| `sourceId` | Stable connector/export namespace | Participates in record identity and lineage |
| `owner` | Accountable dataset owner | Required, but is not an authentication credential |
| `authorizationRef` | Reference to an external authorization record | Required only for `AUTHORIZED_EXPORT`; no secret value is stored |
| `exportedAt` | Source observation/export cutoff | Becomes the snapshot `asOf` for file imports |
| `sha256` | Exact file digest | Checked before business rows are parsed |

Manifest paths are relative to the manifest directory. Absolute paths, `..` escape, symlinks and realpath escape are rejected.

## Canonical records

| Kind | Source record ID | Business time | Money/currency rule |
| --- | --- | --- | --- |
| sales | `lineId` | `paidAt`; refund events retain `refundedAt` | safe integer minor units; manifest currency must match |
| inventory | `snapshotId` | `observedAt` | quantity is a non-negative safe integer |
| promotions | `promotionId` | `start`/`end` interval | no implicit discount amount is invented |
| products | `productId:skuId` | export cutoff | cost fields are safe integer minor units |
| ads | `recordId` | `observedAt` | spend/revenue are safe integer minor units; attribution window is explicit |

JSON, JSONL and quoted CSV are accepted. Unknown fields, malformed values, scope/currency conflict and malformed serialization are quarantined with kind and source row number. Missing data is represented by completeness, never by generated zero records.

## Version and snapshot fields

| Field | Meaning |
| --- | --- |
| `recordVersionId` | Content-derived ID for one immutable source-record revision |
| `version` | Monotonic revision within tenant/shop/kind/source/sourceRecordId |
| `contentHash` | SHA-256 of canonical payload |
| `businessTime` | Time used for domain ordering/query semantics |
| `ingestedAt` | Host ingestion time, distinct from business time |
| `snapshotId` | Immutable membership hash bound to one applied import |
| `completeness[kind]` | `complete`, `partial` or `missing` |
| `metricDefinitionVersion` | Metric semantics expected when interpreting the snapshot |

## Evidence governance

New imported evidence carries schema version 2, tenant/shop, snapshot, all contributing source namespaces, source record IDs, metric definition version, record-content hash, business window and ingestion time. The evidence ID includes governance metadata, so equal content in another shop or snapshot does not collide.

Hard report validation rejects mixed legacy/governed evidence, cross-snapshot evidence, cross-scope/currency/window evidence and mixed metric definition versions. Semantic review is a separate opinion: absent or failed reviewers yield `PENDING_REVIEW`, never automatic support or execution authority.
