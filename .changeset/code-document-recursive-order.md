---
"effect": patch
---

Defer references to recursive definitions from every generated definition in `SchemaRepresentation.toCodeDocument`, not only from recursive ones. Previously, a non-recursive definition that used a recursive definition, together with a recursive definition that used a non-recursive one, had no declaration order that avoided reading a constant before its initialization. Declaring `references.nonRecursives`, then `references.recursives`, then `codes` now always works.
