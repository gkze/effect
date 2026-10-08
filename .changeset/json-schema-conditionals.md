---
"effect": patch
---

Add `Schema.isConditional` and its representation reviver. It validates a value against one of two schemas selected by a condition schema, without changing the value or its type.

`SchemaRepresentation.fromJsonSchemaDocument` and `fromJsonSchemaMultiDocument` now import active `if` / `then` / `else`, `dependentRequired`, and `dependentSchemas` as conditional checks instead of rejecting them. Intersecting finite literal unions now keeps the checks of both unions.
