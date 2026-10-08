---
"effect": patch
---

Add `Schema.isFormat` for the JSON Schema `uri`, `email`, `date`, and `regex` formats, with a representation reviver, and the opt-in `formats: "apply"` option of `SchemaRepresentation.fromJsonSchemaDocument` and `fromJsonSchemaMultiDocument`. Formats remain annotations by default. When applied, other reached formats are rejected with their source path.
