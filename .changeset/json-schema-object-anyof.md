---
"effect": patch
---

Allow JSON Schema object constraints containing nested choices to intersect with `anyOf` branches. This enables native import and typed code generation for SchemaStore's complete tsconfig.json schema while preserving nested `oneOf` validation and each object's property scope.
