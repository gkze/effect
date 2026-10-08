---
"effect": patch
---

Discard structured `enum` members that an explicit `type` excludes when importing JSON Schema, such as `[]` in `{ "type": "string", "enum": ["always", []] }`. These members can never match, so dropping them does not change validation. Structured members that the schema could accept are still rejected.
