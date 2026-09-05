import { Schema, SchemaParser } from "effect"
import type { SchemaAST } from "effect"
import { describe, expect, it } from "tstyche"

describe("runtime and AST options", () => {
  it("keeps excess handling and output order at runtime", () => {
    expect<SchemaAST.ParseOptions["onExcessProperty"]>().type.toBe<"ignore" | "error" | undefined>()
    expect<SchemaAST.ParseOptions["propertyOrder"]>().type.toBe<"none" | "original" | undefined>()
    expect<Extract<keyof SchemaAST.ParseOptions, "concurrency">>().type.toBe<never>()
    const schema = Schema.Struct({ a: Schema.String })
    expect<Extract<keyof SchemaAST.Objects, "options">>().type.toBe<never>()
    expect(SchemaParser.decodeUnknownSync(schema, { propertyOrder: "original" })({ a: "a" }))
      .type.toBe<{ readonly a: string }>()
    expect(SchemaParser.is(schema, { propertyOrder: "original" })).type.toBe<
      <I>(input: I) => input is I & { readonly a: string }
    >()
    expect(Schema.Record(Schema.String, Schema.Number).Type)
      .type.toBe<{ readonly [x: string]: number }>()
  })

  it("stores mode in the Union options bag", () => {
    const schema = Schema.Union([Schema.String, Schema.Number], { mode: "oneOf" })
    expect(schema.ast.options).type.toBe<SchemaAST.UnionOptions | undefined>()
    expect<Extract<keyof SchemaAST.Union, "mode">>().type.toBe<never>()
  })
})
