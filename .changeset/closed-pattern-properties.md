---
"effect": patch
---

Support single closed object scopes combining `properties`, `patternProperties`, and `additionalProperties: false` in `SchemaRepresentation.fromJsonSchemaDocument`. Preserve declared and required fields, enforce every matching pattern, and reject unknown keys. Support empty patterns and patterns containing literal slashes or newlines in imported and generated schemas, and report malformed patterns with their JSON Schema source paths.
