---
"effect": patch
---

Generated `annotate` calls with `default` or `examples` now cast the annotations to `Schema.Annotations.Annotations` in `SchemaRepresentation.toCodeDocument`. Imported JSON Schema documentation values need not satisfy the schema, such as `"default": null` on an integer, and previously made the generated TypeScript fail to compile.
