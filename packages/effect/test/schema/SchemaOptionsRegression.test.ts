import { assert, describe, it } from "@effect/vitest"
import { Effect, Result, Schema, SchemaParser, SchemaRepresentation } from "effect"
import { SchemaJITCompiler } from "effect/unstable/schema"
import { deepStrictEqual, strictEqual, throws } from "../utils/assert.ts"

for (const compiled of [false, true]) {
  describe(compiled ? "compiled object options" : "interpreted object options", () => {
    const prepare = <S extends Schema.Top>(schema: S): S => {
      if (compiled) SchemaJITCompiler.enable(schema.ast)
      return schema
    }

    it("combines fixed, string-pattern and symbol index coverage", () => {
      const schema = prepare(Schema.StructWithRest(Schema.Struct({ fixed: Schema.Boolean }), [
        Schema.Record(Schema.TemplateLiteral(["s-", Schema.String]), Schema.String),
        Schema.Record(Schema.Symbol, Schema.Number)
      ]))
      const symbol = Symbol()
      const value = { fixed: true, "s-a": "a", [symbol]: 1 }
      deepStrictEqual(SchemaParser.decodeUnknownSync(schema)(value, { onExcessProperty: "error" }), value)
      strictEqual(SchemaParser.is(schema)(value), true)
      strictEqual(SchemaParser.is(schema)({ ...value, extra: 1 }), true)
      assert(Result.isFailure(
        SchemaParser.decodeUnknownResult(schema)({ ...value, extra: 1 }, {
          onExcessProperty: "error"
        })
      ))
      const result = SchemaParser.decodeUnknownResult(schema)({ fixed: true, "s-a": 1 }, {
        onExcessProperty: "error",
        errors: "all",
        reportInput: true
      })
      assert(Result.isFailure(result))
      assert(result.failure._tag === "Composite")
      const issue = result.failure.issues[0]
      assert(issue._tag === "Pointer")
      strictEqual(issue.issue._tag, "InvalidType")
    })

    it("validates all overlapping indexes", () => {
      const schema = prepare(Schema.StructWithRest(Schema.Struct({}), [
        Schema.Record(Schema.String, Schema.Number),
        Schema.Record(Schema.TemplateLiteral(["n-", Schema.String]), Schema.Number.check(Schema.isGreaterThan(0)))
      ]))
      strictEqual(SchemaParser.is(schema)({ "n-a": -1 }), false)
      const decode = SchemaParser.decodeUnknownResult(schema, { onExcessProperty: "error" })
      assert(Result.isFailure(decode({ "n-a": -1 })))
      assert(Result.isSuccess(decode({ "n-a": -1 }, { disableChecks: true })))
      assert(Result.isSuccess(decode({ other: 1 })))
    })

    it("recognizes numeric fixed keys with and without index signatures", () => {
      const symbol = Symbol()
      for (const key of [Schema.Literal(1), Schema.Union([Schema.Literal(1), Schema.Symbol])]) {
        const schema = prepare(Schema.Record(key, Schema.String))
        const options = { onExcessProperty: "error", errors: "all" } as const
        const input = { 1: "one" }
        deepStrictEqual(SchemaParser.decodeUnknownSync(schema)(input, options), input)
        deepStrictEqual(SchemaParser.encodeUnknownSync(schema)(input, options), input)
        strictEqual(SchemaParser.is(schema)(input), true)

        const result = SchemaParser.decodeUnknownResult(schema)({ 1: 1 }, options)
        assert(Result.isFailure(result))
        assert(result.failure._tag === "Composite")
        strictEqual(result.failure.issues.length, 1)
        const issue = result.failure.issues[0]
        assert(issue._tag === "Pointer")
        deepStrictEqual(issue.path, [1])
        strictEqual(issue.issue._tag, "InvalidType")
        assert(Result.isFailure(SchemaParser.decodeUnknownResult(schema)({ ...input, extra: "extra" }, options)))
      }
      const schema = prepare(Schema.Record(Schema.Union([Schema.Literal(1), Schema.Symbol]), Schema.String))
      const input = { 1: "one", [symbol]: "symbol" }
      deepStrictEqual(SchemaParser.decodeUnknownSync(schema)(input, { onExcessProperty: "error" }), input)
    })

    it("keeps numeric fixed-field output when an index signature also selects the key", () => {
      const schema = prepare(Schema.StructWithRest(
        Schema.Record(Schema.Literal(1), Schema.Struct({ a: Schema.String })),
        [Schema.Record(Schema.String, Schema.Struct({ a: Schema.String, b: Schema.Number }))]
      ))
      deepStrictEqual(SchemaParser.decodeUnknownSync(schema)({ 1: { a: "a", b: 1 } }), { 1: { a: "a" } })
    })

    it("passes stripped nested objects to checks", () => {
      const child = Schema.Struct({ a: Schema.String, b: Schema.String })
        .check(Schema.makeFilter((value) => !Object.hasOwn(value, "extra")))
      const schema = prepare(Schema.Struct({ child, a: Schema.String }))
      const input = { a: "a", child: { b: "b", a: "a", extra: true } }
      const output = SchemaParser.decodeUnknownSync(schema)(input)
      deepStrictEqual(output, { a: "a", child: { a: "a", b: "b" } })
      strictEqual(SchemaParser.is(schema)(input), true)
      assert(Result.isFailure(SchemaParser.decodeUnknownResult(schema)(input, { onExcessProperty: "error" })))
      deepStrictEqual(SchemaParser.encodeUnknownSync(schema)(output), output)
    })

    it("honors per-call excess-property overrides without changing the cached decoder", () => {
      const schema = prepare(Schema.Struct({ a: Schema.String, b: Schema.String }))
      const input = { b: "b", a: "a", extra: true }
      const decode = SchemaParser.decodeUnknownSync(schema, { onExcessProperty: "error" })
      throws(() => decode(input))
      deepStrictEqual(decode(input, { onExcessProperty: "ignore" }), { a: "a", b: "b" })
      throws(() => decode(input))
      const defaultDecode = SchemaParser.decodeUnknownSync(schema)
      deepStrictEqual(defaultDecode(input), { a: "a", b: "b" })
      throws(() => defaultDecode(input, { onExcessProperty: "error" }))
      deepStrictEqual(defaultDecode(input), { a: "a", b: "b" })
    })

    it("decodes and encodes transformed fields inside arrays and unions", () => {
      const child = Schema.Struct({ a: Schema.NumberFromString, b: Schema.String })
      const schema = prepare(Schema.Array(Schema.Union([child, Schema.Boolean])))
      const input = [{ b: "b", a: "1" }]
      const output = SchemaParser.decodeUnknownSync(schema)(input)
      deepStrictEqual(output, [{ b: "b", a: 1 }])
      const encoded = SchemaParser.encodeUnknownSync(schema)(output)
      deepStrictEqual(encoded, input)
    })

    it("retains transformed record keys", () => {
      const schema = prepare(Schema.Record(Schema.Trim, Schema.NumberFromString))
      deepStrictEqual(SchemaParser.decodeUnknownSync(schema)({ " a ": "1" }), { a: 1 })
    })

    it("keeps the empty struct's non-nullish contract", () => {
      const schema = prepare(Schema.Struct({}))
      for (const input of [1, "a", false, [], {}]) {
        strictEqual(
          SchemaParser.decodeUnknownSync(schema)(input, {
            onExcessProperty: "error"
          }),
          input
        )
      }
    })

    it.effect("materializes unchanged results after an async transformation", () =>
      Effect.gen(function*() {
        const schema = prepare(
          Schema.String.pipe(Schema.middlewareDecoding((decode) => Effect.flatMap(Effect.yieldNow, () => decode)))
        )
        strictEqual(yield* SchemaParser.decodeUnknownEffect(schema)("a"), "a")
        const array = prepare(Schema.Array(schema))
        deepStrictEqual(yield* SchemaParser.decodeUnknownEffect(array)(["a", "b"]), ["a", "b"])
      }))

    it.effect("retains decoded fields after an asynchronous property", () =>
      Effect.gen(function*() {
        const value = Schema.String.pipe(
          Schema.middlewareDecoding((decode) => Effect.flatMap(Effect.yieldNow, () => decode))
        )
        const schema = prepare(Schema.Struct({ a: value, b: Schema.String }))
        const output = yield* SchemaParser.decodeUnknownEffect(schema)({ b: "b", a: "a" })
        deepStrictEqual(output, { a: "a", b: "b" })
      }))
  })
}

it("does not build detailed failures inside validate", () => {
  const schema = Schema.Struct({ value: Schema.String })
  SchemaJITCompiler.enable(schema.ast)
  let reads = 0
  const input = {
    value: "a",
    get extra() {
      reads++
      return 1
    }
  }
  const result = SchemaParser.decodeUnknownResult(schema)(input, { onExcessProperty: "error", reportInput: true })
  assert(Result.isFailure(result))
  strictEqual(reads, 1)
})

it("round-trips options through the structural representation", () => {
  const schema = Schema.Union([
    Schema.Struct({ a: Schema.String }),
    Schema.Struct({ b: Schema.Number })
  ], { mode: "oneOf" })
  const document = SchemaRepresentation.toRepresentation(schema.ast)
  const rebuilt = SchemaRepresentation.fromRepresentation(document, { revivers: [] })
  deepStrictEqual(SchemaRepresentation.toRepresentation(rebuilt.ast), document)
})

it("omits object order configuration and retains oneOf in generated schema source", () => {
  const schemas = [
    Schema.Struct({ a: Schema.String }),
    Schema.Record(Schema.String, Schema.Number),
    Schema.Union([Schema.Literal("a"), Schema.Literal("a")], { mode: "oneOf" })
  ]
  const document = SchemaRepresentation.toCodeDocument(
    SchemaRepresentation.toRepresentations([schemas[0].ast, schemas[1].ast, schemas[2].ast])
  )
  strictEqual(document.codes[0].runtime, "Schema.Struct({ \"a\": Schema.String })")
  strictEqual(document.codes[1].runtime, "Schema.Record(Schema.String, Schema.Number)")
  strictEqual(document.codes[2].runtime.includes("mode: \"oneOf\""), true)
})
