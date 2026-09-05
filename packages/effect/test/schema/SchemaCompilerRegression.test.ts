import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Option, Result, Schema, SchemaAST, SchemaParser, SchemaTransformation } from "effect"
import * as CompilerRegistry from "effect/internal/schema/compilerRegistry"
import { SchemaCompiler, SchemaJITCompiler } from "effect/unstable/schema"
import { deepStrictEqual, strictEqual, throws } from "../utils/assert.ts"

describe("compiler regression contracts", () => {
  it.effect("resolved parsers return Effects containing their actual output", () =>
    Effect.gen(function*() {
      const object = { value: "a" }
      const cases: ReadonlyArray<readonly [Schema.Constraint, unknown, unknown]> = [
        [Schema.String, "a", "a"],
        [Schema.Number, -0, -0],
        [Schema.Literal(0), -0, -0],
        [Schema.Undefined, undefined, undefined],
        [Schema.ObjectKeyword, object, object],
        [Schema.Json, object, object],
        [Schema.Struct({}), 1, 1],
        [Schema.TemplateLiteral(["a"]), "a", "a"],
        [Schema.FiniteFromString, "1", 1]
      ]
      for (const [schema, input, expected] of cases) {
        for (const compiled of [false, true]) {
          if (compiled) SchemaJITCompiler.enable(schema.ast)
          const parser = CompilerRegistry.resolve(schema.ast)
          const output = yield* Effect.map(parser(input, SchemaAST.defaultParseOptions), (value) => value)
          strictEqual(Object.is(output, expected), true)
        }
      }
    }))

  it("calls installed operations with options without inspecting extra function properties", () => {
    const schema = Schema.Struct({ value: Schema.String })
    const seen: Array<SchemaAST.ParseOptions> = []
    const is: SchemaCompiler.Is = (_input, options) => {
      seen.push(options)
      return true
    }
    const validate: SchemaCompiler.Validate = (input, options) => {
      seen.push(options)
      return input
    }
    for (const operation of [is, validate]) {
      Object.defineProperty(operation, "default", {
        get() {
          throw new Error("Not part of the compiled decoder contract")
        }
      })
    }
    SchemaCompiler.set(schema.ast, { is, validate, decode: Effect.succeed })
    const input = { value: "a" }
    strictEqual(SchemaParser.is(schema)(input), true)
    strictEqual(SchemaParser.decodeUnknownSync(schema)(input), input)
    const options = { reportInput: true }
    strictEqual(SchemaParser.is(schema, options)(input), true)
    strictEqual(SchemaParser.decodeUnknownSync(schema, options)(input), input)
    deepStrictEqual(seen, [SchemaAST.defaultParseOptions, SchemaAST.defaultParseOptions, options, options])
  })

  it("bounds inlining of shared subgraphs", () => {
    let schema: Schema.Codec<unknown> = Schema.Struct({ value: Schema.optionalKey(Schema.String) })
    let valid: unknown = { value: "value" }
    let invalid: unknown = { value: 1 }
    for (let i = 0; i < 16; i++) {
      schema = Schema.Struct({
        left: Schema.optionalKey(schema),
        right: Schema.optionalKey(schema)
      })
      valid = { left: valid }
      invalid = { left: invalid }
    }
    const cases = [
      { schema, valid, invalid },
      { schema, valid: { left: { right: {} } }, invalid: { left: { right: 1 } } },
      { schema: Schema.Array(schema), valid: [{}], invalid: [1] },
      { schema: Schema.Union([schema, Schema.String]), valid: {}, invalid: 1 }
    ]
    for (const { schema, valid, invalid } of cases) {
      const expected = SchemaParser.decodeUnknownResult(schema)(invalid)
      assert(Result.isFailure(expected))
      SchemaJITCompiler.enable(schema.ast)
      deepStrictEqual(SchemaParser.decodeUnknownSync(schema)(valid), valid)
      strictEqual(SchemaParser.is(schema)(valid), true)
      strictEqual(SchemaParser.is(schema)(invalid), false)
      deepStrictEqual(SchemaParser.decodeUnknownResult(schema)(invalid), expected)
    }
  })

  it("bounds generated composed parsers for wide objects", () => {
    const property = Schema.optionalKey(Schema.String)
    const schema = Schema.Struct(Object.fromEntries(
      Array.from({ length: 4096 }, (_, i) => [`key${i}`, property])
    ))
    SchemaJITCompiler.enable(schema.ast)
    const input = { key4095: "last" }
    deepStrictEqual(SchemaParser.decodeUnknownSync(schema)(input), input)
    strictEqual(SchemaParser.is(schema)(input), true)
    strictEqual(SchemaParser.is(schema)({ key4095: 1 }), false)
  })

  it("stops oneOf after its second successful candidate", () => {
    const schema = Schema.Union([
      Schema.String.check(Schema.isMinLength(1)),
      Schema.String.check(Schema.isMaxLength(10)),
      Schema.String.check(Schema.makeFilter(() => {
        throw new Error("The third candidate must not be evaluated")
      }))
    ], { mode: "oneOf" })
    for (const compiled of [false, true]) {
      if (compiled) SchemaJITCompiler.enable(schema.ast)
      for (const options of [undefined, { errors: "all" }] as const) {
        strictEqual(SchemaParser.is(schema, options)("hello"), false)
        const result = SchemaParser.decodeUnknownResult(schema, options)("hello")
        assert(Result.isFailure(result))
        strictEqual(result.failure._tag, "OneOf")
      }
    }
  })

  it.effect("accepts both zero signs and preserves the input across parser adapters", () =>
    Effect.gen(function*() {
      const options: Array<SchemaAST.ParseOptions | undefined> = [
        undefined,
        { errors: "all" },
        { reportInput: true }
      ]
      for (const literal of [0, -0]) {
        const schemas = [
          Schema.Literal(literal),
          Schema.Union([Schema.Literal(literal), Schema.Literal(1)]),
          Schema.Literal(literal).check(Schema.makeFilter((n) => Object.is(n, -0)))
        ]
        for (const schema of schemas) {
          const nested = Schema.Struct({ values: Schema.Array(schema) })
          for (const compiled of [false, true]) {
            if (compiled) {
              SchemaJITCompiler.enable(schema.ast)
              SchemaJITCompiler.enable(nested.ast)
            }
            for (const input of [0, -0]) {
              if (schema.ast.checks && !Object.is(input, -0)) {
                strictEqual(SchemaParser.is(schema)(input), false)
                assert(Result.isFailure(SchemaParser.decodeUnknownResult(schema)(input)))
                continue
              }
              for (const option of options) {
                strictEqual(SchemaParser.is(schema, option)(input), true)
                strictEqual(Object.is(SchemaParser.decodeUnknownSync(schema, option)(input), input), true)
                strictEqual(Object.is(SchemaParser.encodeUnknownSync(schema, option)(input), input), true)
                const result = SchemaParser.decodeUnknownResult(schema, option)(input)
                assert(Result.isSuccess(result))
                strictEqual(Object.is(result.success, input), true)
                const exit = SchemaParser.decodeUnknownExit(schema, option)(input)
                assert(Exit.isSuccess(exit))
                strictEqual(Object.is(exit.value, input), true)
                const optional = SchemaParser.decodeUnknownOption(schema, option)(input)
                assert(Option.isSome(optional))
                strictEqual(Object.is(optional.value, input), true)
                const output = yield* SchemaParser.decodeUnknownEffect(schema, option)(input)
                strictEqual(Object.is(output, input), true)
                const decoded = SchemaParser.decodeUnknownSync(nested, option)({ values: [input] })
                strictEqual(Object.is(decoded.values[0], input), true)
              }
            }
          }
        }
      }
    }))

  it("retains the original encoding AST in local checks", () => {
    const schema = Schema.NumberFromString.check(
      Schema.makeFilter((_value, ast) => ast === schema.ast && ast.encoding !== undefined)
    )
    strictEqual(SchemaParser.decodeUnknownSync(schema)("1"), 1)
    SchemaJITCompiler.enable(schema.ast)
    strictEqual(SchemaParser.decodeUnknownSync(schema)("1"), 1)
  })

  it("retains the original encoding AST in structural issues", () => {
    const schema = Schema.String.pipe(Schema.decodeTo(
      Schema.Number,
      SchemaTransformation.transform({ decode: () => "invalid" as any, encode: String })
    ))
    for (const compiled of [false, true]) {
      if (compiled) SchemaJITCompiler.enable(schema.ast)
      const result = SchemaParser.decodeUnknownResult(schema)("input")
      assert(Result.isFailure(result))
      assert(result.failure._tag === "InvalidType")
      strictEqual(result.failure.ast, schema.ast)
    }
  })

  it("installs accessors without evaluating them and reads only the selected operation once", () => {
    const schema = Schema.Struct({ value: Schema.String })
    const reads: Array<string> = []
    const decoder = {
      get is() {
        strictEqual(this, decoder)
        reads.push("is")
        return (_input: unknown) => true
      },
      get validate() {
        strictEqual(this, decoder)
        reads.push("validate")
        return (input: unknown) => input
      },
      get decode() {
        strictEqual(this, decoder)
        reads.push("decode")
        return Effect.succeed
      }
    }
    SchemaCompiler.set(schema.ast, decoder)
    deepStrictEqual(reads, [])
    strictEqual(SchemaParser.is(schema)({ value: "a" }), true)
    strictEqual(SchemaParser.is(schema)({ value: "b" }), true)
    deepStrictEqual(reads, ["is"])
    const input = { value: "a" }
    strictEqual(SchemaParser.decodeUnknownSync(schema)(input), input)
    strictEqual(SchemaParser.decodeUnknownSync(schema)(input), input)
    deepStrictEqual(reads, ["is", "validate"])
  })

  it("memoizes an absent optional operation", () => {
    const schema = Schema.Struct({ value: Schema.String })
    let reads = 0
    SchemaCompiler.set(schema.ast, {
      get is() {
        reads++
        return undefined
      },
      validate: (input) => input,
      decode: Effect.succeed
    })
    strictEqual(SchemaParser.is(schema)({ value: "a" }), true)
    strictEqual(SchemaParser.is(schema)({ value: "b" }), true)
    strictEqual(reads, 1)
  })

  it("does not hide generated-source defects when Function is available", () => {
    const schema = Schema.Struct({ value: Schema.String })
    const original = globalThis.Function
    const defect = new SyntaxError("generated source defect")
    try {
      globalThis.Function = ((...parameters: Array<string>) => {
        if (parameters.length === 1 && parameters[0] === "return true") return original(...parameters)
        throw defect
      }) as FunctionConstructor
      SchemaJITCompiler.enable(schema.ast)
      throws(() => SchemaParser.decodeUnknownSync(schema)({ value: "a" }), (error) => {
        strictEqual(error, defect)
      })
    } finally {
      globalThis.Function = original
    }
  })
})
