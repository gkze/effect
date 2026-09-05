---
"effect": patch
---

Preserve original AST identity in compiled encoding checkpoints, make installed decoder operations lazy, and prevent diagnostic failures from being constructed twice. Code-generation bugs are now reported rather than silently selecting the interpreter; environments that disallow dynamic code generation still use the interpreter.

### Breaking changes

- Remove `onExcessProperty: "preserve"`. Model accepted extra fields with `Record` or `StructWithRest` and an explicit value schema. Runtime `"error"` now rejects keys outside the combined fixed-field and index-signature coverage, including on records.
- Replace the second `Union` constructor argument with an options object containing `mode`. Replace direct `ast.mode` reads with `ast.options?.mode ?? "anyOf"`. Structural representations and generated schema code use the same option bag. Regenerate persisted representations; no legacy shape migration is provided.
- JSON Schema generation omits `additionalProperties` by default on structs. Explicit index value constraints and explicit generation overrides remain supported. Validate incoming JSON before codec decoding; the codec may strip properties accepted by JSON Schema. Import/export does not guarantee semantic equivalence for closed objects or unions containing them.

OpenAI and Anthropic structured-output adapters explicitly retain closed object schemas required by their provider-specific output format.
