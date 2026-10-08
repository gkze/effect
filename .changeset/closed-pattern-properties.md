---
"effect": patch
---

Import closed JSON Schema objects that combine declared properties with one or more `patternProperties` entries when all declared and patterned values share one generated TypeScript type. Each pattern becomes a filtered `Schema.Record` index signature beside the declared properties; keys matching neither are excess properties. Value checks may differ, as in SchemaStore's `package.json` `exports` and `typesVersions` objects. Closed objects whose values would need different index signature types remain rejected, with an explanation.

Intersecting a reference with itself now keeps the reference instead of expanding its definition, so repeated references to recursive definitions remain importable.

Generated TypeScript for objects with several index signatures of the same parameter type now intersects separate object types instead of repeating an index signature, which TypeScript rejects.
