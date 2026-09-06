---
"effect": patch
---

Add a shared `SchemaCompiler` decoder registry and the experimental `SchemaJITCompiler`, consumed transparently through the existing `SchemaParser` APIs:

- Import `effect/unstable/schema/SchemaJITCompiler/enable` to enable lazy JIT compilation globally.
- Call `SchemaJITCompiler.enable(ast)` to enable compilation for one AST and its decoding dependencies.
- Call `SchemaCompiler.set(ast, decoder)` to install a trusted JIT or AOT decoder in the same registry.
- Call `SchemaAOTCompiler.compile(asts)` with a readonly array of ASTs at build time to generate a JavaScript module exporting `install(asts)`. Pass the corresponding runtime ASTs in the same order; use `[ast]` for a single schema. Shared dependencies and repeated roots are installed once by identity. Generated modules use the shared registry and run without dynamic function construction. Regenerate them when the schema or Effect version changes. Suspend contents and unsupported nodes retain interpreted parsing; diagnostic closures and transformation orchestration still initialize lazily.

Decoder operations are resolved lazily, including operations supplied through accessors. Install the compiler before the first execution of parsers you want to accelerate: parsers that have already captured an entry continue using it. Environments that disallow dynamic function generation use the interpreter; code-generation bugs are reported rather than silently selecting the interpreter.

Type-side schemas can use separate boolean validation, output-producing validation, and detailed decoding operations. Schemas with encodings enter decoding directly, so transformations and middleware run once while their checkpoints resolve to compiled or interpreted parsers. Compiled checkpoints retain the original AST in checks and issues, honor runtime `ParseOptions`, and avoid constructing diagnostic failures twice.

`SchemaParser.is` and `Schema.is` now accept optional `ParseOptions`, captured when the type guard is created. Passing `disableChecks: true` is unsafe: it skips refinement checks, so the caller assumes responsibility for the resulting type narrowing.

Capture synchronous defects raised while selecting or parsing Union candidates, consistently with Struct and Array parsing. Handle numeric declared keys consistently in excess-property checks and when an index signature also selects them, preserving the fixed field's decoded output. Excess-property checking remains linear in the number of input and selected keys for interpreted and compiled records.

Bound JIT inlining of repeated subgraphs to avoid oversized generated functions. Compiled `oneOf` validation stops after the second successful candidate, matching interpreted decoding and avoiding evaluation of later checks.

### Breaking changes

- `Literal(0)` and `Literal(-0)` continue accepting both zero signs, matching TypeScript, but now preserve the input's sign during decoding and encoding instead of canonicalizing to the stored literal. This applies to both the interpreter and JIT, including literals nested in other schemas.
- `Schema.Struct` accepts inherited declared fields during decoding, encoding, and construction. Declared fields use JavaScript property presence (`key in input`), except that `__proto__` must be an own property. Parsed outputs copy accepted inherited fields to own properties. Dynamic `Schema.Record` index signatures still select own properties only. Validate property ownership before parsing if you require own-only fields.
- The `parseOptions` annotation no longer configures parsing. Pass options when creating or calling a decoder, encoder, or type guard instead. These options apply throughout the parse; nested annotations cannot override them. The old annotation key remains accepted as custom metadata but has no parsing effect.
- Remove `propertyOrder` from `SchemaAST.ParseOptions`. Output key order is unspecified for decoding, encoding, and values passed to checks, including through type guards. Remove the option from parser configuration and handle required presentation or serialization order explicitly. Revise checks that relied on input key order; reordering the final output does not restore that behavior.
- Remove `concurrency` from `SchemaAST.ParseOptions`. Composite schemas parse children sequentially, including asynchronous transformations and middleware. Compose independent parsing operations with Effect concurrency combinators when needed. Transformations and middleware can still manage concurrency within their own effects.
- Remove `onExcessProperty: "preserve"`. Model accepted extra fields with `Record` or `StructWithRest` and an explicit value schema. Runtime `"error"` rejects keys outside the combined fixed-field and index-signature coverage, including on records. A key covered by any index signature is not excess, but every applicable index signature still validates its value.
- Replace the second `SchemaAST.Union` constructor argument with an options object containing `mode`. Replace direct `ast.mode` reads with `ast.options?.mode ?? "anyOf"`. Structural representations use the same option bag. Regenerate persisted representations; no legacy shape migration is provided. The public `Schema.Union(members, { mode })` call remains unchanged.
- JSON Schema generation omits `additionalProperties` by default on structs. Explicit index value constraints and generation overrides remain supported. Validate incoming JSON against its JSON Schema before codec decoding; the codec may strip properties accepted by JSON Schema. Importing a document does not install a runtime excess-property setting. Import/export does not guarantee semantic equivalence for closed objects or unions containing them. OpenAI and Anthropic structured-output adapters explicitly retain closed object schemas.
