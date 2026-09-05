import { assert, describe, it } from "@effect/vitest"
import { Effect, Result, Schema, SchemaParser, SchemaTransformation } from "effect"
import { SchemaCompiler, SchemaJITCompiler } from "effect/unstable/schema"
import { deepStrictEqual, strictEqual, throws } from "../utils/assert.ts"

describe("compiler regression contracts", () => {
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
