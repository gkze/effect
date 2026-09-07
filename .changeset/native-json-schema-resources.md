---
"effect": patch
---

Support JSON Schema root and deep references, resource IDs and anchors, and caller-supplied external documents through `FromJsonSchemaOptions.references`. Import conditional schemas, property dependencies, and typed additional properties while preserving their validation scopes.

Add opt-in `formats: "apply"` validation for URI, email, date, and regular-expression formats, together with `Schema.isFormat`, `Schema.isConditional`, `Schema.isAdditionalProperties`, and their representation revivers. Format validation remains disabled by default; external documents are never fetched automatically.

Fix generated TypeScript for optional tuple intersections, repeated index signatures, forward references to recursive definitions, and documentation defaults or examples that do not match the schema. Preserve boolean `deprecated` annotations when converting Draft 7 documents.
