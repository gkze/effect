import { assert, describe, it } from "@effect/vitest"
import { Effect, Result, Schema, SchemaParser, SchemaRepresentation } from "effect"
import { SchemaJITCompiler } from "effect/unstable/schema"
import { deepStrictEqual, strictEqual } from "../utils/assert.ts"

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
      strictEqual(SchemaParser.is(schema, { onExcessProperty: "error" })(value), true)
      strictEqual(SchemaParser.is(schema, { onExcessProperty: "error" })({ ...value, extra: 1 }), false)
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
      strictEqual(SchemaParser.is(schema, { onExcessProperty: "error" })({ "n-a": -1 }), false)
      strictEqual(SchemaParser.is(schema, { onExcessProperty: "error", disableChecks: true })({ "n-a": -1 }), true)
      strictEqual(SchemaParser.is(schema, { onExcessProperty: "error" })({ other: 1 }), true)
    })

    it("propagates runtime order to nested objects and checks", () => {
      const child = Schema.Struct({ a: Schema.String, b: Schema.String })
        .check(Schema.makeFilter((value) => Object.keys(value)[0] === "b"))
      const schema = prepare(Schema.Struct({ child, a: Schema.String }))
      const input = { a: "a", child: { b: "b", a: "a", extra: true } }
      const output = SchemaParser.decodeUnknownSync(schema)(input, { propertyOrder: "original" })
      deepStrictEqual(Object.keys(output), ["a", "child"])
      deepStrictEqual(Object.keys(output.child), ["b", "a"])
      strictEqual(SchemaParser.is(schema)(input), false)
      strictEqual(SchemaParser.is(schema, { propertyOrder: "original" })(input), true)
      strictEqual(SchemaParser.is(schema, { propertyOrder: "none" })(input), false)
      deepStrictEqual(
        Object.keys(
          SchemaParser.encodeUnknownSync(schema)(output, {
            propertyOrder: "original"
          }).child
        ),
        ["b", "a"]
      )
    })

    it("honors per-call order overrides without changing the cached decoder", () => {
      const schema = prepare(Schema.Struct({ a: Schema.String, b: Schema.String }))
      const input = { b: "b", a: "a", extra: true }
      const decode = SchemaParser.decodeUnknownSync(schema, { propertyOrder: "original" })
      deepStrictEqual(Object.keys(decode(input)), ["b", "a"])
      deepStrictEqual(Object.keys(decode(input, { propertyOrder: "none" })), ["a", "b"])
      deepStrictEqual(Object.keys(decode(input)), ["b", "a"])
      const defaultDecode = SchemaParser.decodeUnknownSync(schema)
      deepStrictEqual(Object.keys(defaultDecode(input)), ["a", "b"])
      deepStrictEqual(Object.keys(defaultDecode(input, { propertyOrder: "original" })), ["b", "a"])
      deepStrictEqual(Object.keys(defaultDecode(input)), ["a", "b"])
    })

    it("propagates runtime order through arrays, unions and transformed fields", () => {
      const child = Schema.Struct({ a: Schema.NumberFromString, b: Schema.String })
      const schema = prepare(Schema.Array(Schema.Union([child, Schema.Boolean])))
      const input = [{ b: "b", a: "1" }]
      const output = SchemaParser.decodeUnknownSync(schema)(input, { propertyOrder: "original" })
      deepStrictEqual(output, [{ b: "b", a: 1 }])
      deepStrictEqual(Object.keys(output[0]), ["b", "a"])
      const encoded = SchemaParser.encodeUnknownSync(schema)(output, { propertyOrder: "original" })
      deepStrictEqual(encoded, input)
      deepStrictEqual(Object.keys(encoded[0]), ["b", "a"])
    })

    it("retains new record keys when restoring original order", () => {
      const schema = prepare(Schema.Record(Schema.Trim, Schema.NumberFromString))
      deepStrictEqual(SchemaParser.decodeUnknownSync(schema)({ " a ": "1" }, { propertyOrder: "original" }), { a: 1 })
    })

    it("keeps the empty struct's non-nullish contract", () => {
      const schema = prepare(Schema.Struct({}))
      for (const input of [1, "a", false, [], {}]) {
        strictEqual(
          SchemaParser.decodeUnknownSync(schema)(input, {
            onExcessProperty: "error",
            propertyOrder: "original"
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

    it.effect("preserves runtime order after an asynchronous property", () =>
      Effect.gen(function*() {
        const value = Schema.String.pipe(
          Schema.middlewareDecoding((decode) => Effect.flatMap(Effect.yieldNow, () => decode))
        )
        const schema = prepare(Schema.Struct({ a: value, b: Schema.String }))
        const output = yield* SchemaParser.decodeUnknownEffect(schema)({ b: "b", a: "a" }, {
          propertyOrder: "original"
        })
        deepStrictEqual(Object.keys(output), ["b", "a"])
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

it("applies runtime order after mapping fields and projecting the AST", () => {
  const source = Schema.Struct({ a: Schema.NumberFromString, b: Schema.String })
  const schema = source.mapFields((fields) => fields)
  const decoded = SchemaParser.decodeUnknownSync(schema)({ b: "b", a: "1" }, { propertyOrder: "original" })
  deepStrictEqual(Object.keys(decoded), ["b", "a"])
  const typeDecoded = SchemaParser.decodeUnknownSync(Schema.toType(schema))(decoded, { propertyOrder: "original" })
  deepStrictEqual(Object.keys(typeDecoded), ["b", "a"])
  const encoded = SchemaParser.decodeUnknownSync(Schema.toEncoded(schema))({ b: "b", a: "1" }, {
    propertyOrder: "original"
  })
  deepStrictEqual(Object.keys(encoded), ["b", "a"])
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

it("applies runtime order to both class extension forms", () => {
  class Base extends Schema.Class<Base>("OrderedBase")({ a: Schema.String }) {}
  class Fields extends Base.extend<Fields>("OrderedFields")({ b: Schema.String }) {}
  class Struct extends Base.extend<Struct>("OrderedStruct")(
    Schema.Struct({ b: Schema.String })
  ) {}
  for (const schema of [Fields, Struct]) {
    const output = SchemaParser.decodeUnknownSync(schema)({ b: "b", a: "a" }, { propertyOrder: "original" })
    deepStrictEqual(Object.keys(output), ["b", "a"])
  }
})

it("propagates runtime order when renaming encoded keys", () => {
  const schema = Schema.Struct({ a: Schema.String, b: Schema.String })
    .pipe(Schema.encodeKeys({ a: "first" }))
  deepStrictEqual(
    Object.keys(
      SchemaParser.decodeUnknownSync(schema)({ b: "b", first: "a" }, {
        propertyOrder: "original"
      })
    ),
    ["b", "a"]
  )
  deepStrictEqual(
    Object.keys(
      SchemaParser.encodeUnknownSync(schema)({ b: "b", a: "a" }, {
        propertyOrder: "original"
      })
    ),
    ["b", "first"]
  )
})

it("omits implicit closure but retains explicit index value constraints in JSON Schema", () => {
  const struct = Schema.toJsonSchemaDocument(Schema.Struct({ a: Schema.String })).schema
  strictEqual(Object.hasOwn(struct, "additionalProperties"), false)
  deepStrictEqual(Schema.toJsonSchemaDocument(Schema.Record(Schema.String, Schema.Finite)).schema, {
    type: "object",
    additionalProperties: { type: "number" }
  })
  const explicit =
    Schema.toJsonSchemaDocument(Schema.Struct({ a: Schema.String }), { additionalProperties: false }).schema
  strictEqual(explicit.additionalProperties, false)
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
