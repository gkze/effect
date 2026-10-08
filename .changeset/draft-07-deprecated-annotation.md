---
"effect": patch
---

Preserve boolean `deprecated` annotations when converting Draft-07 documents with `JsonSchema.fromSchemaDraft07`. Draft 2020-12 defines `deprecated` as an annotation without validation semantics, so copying a boolean value cannot change which instances validate. Non-boolean values are still rejected.
