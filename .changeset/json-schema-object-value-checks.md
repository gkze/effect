---
"effect": patch
---

Add `Schema.isPatternProperties` and `Schema.isAdditionalProperties`, with representation revivers, to validate the values of string keys matching a pattern, or matching neither declared properties nor patterns.

`SchemaRepresentation.fromJsonSchemaDocument` and `fromJsonSchemaMultiDocument` now use these checks to import open `patternProperties` and typed `additionalProperties` beside declared properties or patterns, which were previously rejected. The generated TypeScript type keeps a JSON-valued index signature, so it never assigns a patterned or additional value type to keys that do not have it.
