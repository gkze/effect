---
"effect": patch
---

Add experimental JIT and AOT compilation through the existing `SchemaParser` APIs:

- Import `effect/unstable/schema/SchemaJITCompiler/enable` for global lazy JIT.
- Use `SchemaJITCompiler.enable(ast)` for one AST and its dependencies.
- Use `SchemaCompiler.set(ast, decoder)` to install a trusted decoder.
- Use `SchemaAOTCompiler.compile(asts)` at build time to generate a module exporting `install(asts)`. Supply runtime ASTs in the same order; regenerate after schema or Effect upgrades.

Install before parsers' first execution to accelerate them. JIT falls back to the interpreter when dynamic code generation is unavailable or compilation fails; parsing errors keep their normal behavior. AOT runs without dynamic code generation.

`Schema.is` and `SchemaParser.is` now accept `ParseOptions`. Using `disableChecks: true` makes the caller responsible for unsafe type narrowing.

### Breaking changes

- `Literal(0)` and `Literal(-0)` preserve the input's zero sign. Normalize explicitly if you relied on canonicalization.
- Structs accept inherited declared fields, except `__proto__`. Record index signatures remain own-only. Check ownership before parsing if required.
- `parseOptions` annotations no longer affect parsing. Pass options to parser APIs instead.
- Remove `propertyOrder`. Output key order is unspecified, including inside checks. Remove order-dependent checks and handle presentation order explicitly.
- Remove `concurrency` from `ParseOptions`. Children parse sequentially; use Effect concurrency combinators for independent operations.
- Remove `onExcessProperty: "preserve"`. Use `Record` or `StructWithRest` with an explicit value schema. `"error"` rejects keys outside the combined declared-field and index-signature coverage, including on records.
- `SchemaAST.Union` takes `{ mode }` instead of a mode string. Read `ast.options?.mode ?? "anyOf"` instead of `ast.mode`; regenerate persisted representations. Public `Schema.Union` calls are unchanged.
- Struct JSON Schema generation omits `additionalProperties` by default. Use generation overrides for closed objects. Validate against JSON Schema before codec decoding when its constraints matter; importing it does not configure runtime excess-property handling. OpenAI and Anthropic adapters retain closed schemas.
