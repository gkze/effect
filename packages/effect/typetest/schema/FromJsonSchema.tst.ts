import { type JsonSchema, Schema, SchemaRepresentation } from "effect"
import { describe, expect, it } from "tstyche"

describe("JSON Schema importer", () => {
  it("exposes exact synchronous signatures", () => {
    const fromDocument: (
      document: JsonSchema.Document<"draft-2020-12">,
      options?: SchemaRepresentation.FromJsonSchemaOptions
    ) => Schema.Top = SchemaRepresentation.fromJsonSchemaDocument
    const fromMultiDocument: (
      document: JsonSchema.MultiDocument<"draft-2020-12">,
      options?: SchemaRepresentation.FromJsonSchemaOptions
    ) => readonly [Schema.Top, ...Array<Schema.Top>] = SchemaRepresentation.fromJsonSchemaMultiDocument
    expect(fromDocument).type.toBe<
      (
        document: JsonSchema.Document<"draft-2020-12">,
        options?: SchemaRepresentation.FromJsonSchemaOptions
      ) => Schema.Top
    >()
    expect(fromMultiDocument).type.toBe<
      (
        document: JsonSchema.MultiDocument<"draft-2020-12">,
        options?: SchemaRepresentation.FromJsonSchemaOptions
      ) => readonly [Schema.Top, ...Array<Schema.Top>]
    >()
  })

  it("keeps onEnter limited to JSON Schema nodes", () => {
    const options: SchemaRepresentation.FromJsonSchemaOptions = {
      onEnter: (schema) => ({ ...schema, description: "entered" })
    }

    expect(options.onEnter).type.toBe<
      ((schema: JsonSchema.JsonSchema) => JsonSchema.JsonSchema) | undefined
    >()
  })

  it("limits the pattern policy to the supported modes", () => {
    const options: SchemaRepresentation.FromJsonSchemaOptions = { patterns: "error" }

    expect(options.patterns).type.toBe<"error" | "ignore" | "apply" | undefined>()

    const invalidOptions: SchemaRepresentation.FromJsonSchemaOptions = {
      // @ts-expect-error Type '"safe"' is not assignable to type
      patterns: "safe"
    }
    void invalidOptions
  })
  it("accepts an explicit resource registry and format policy", () => {
    const options: SchemaRepresentation.FromJsonSchemaOptions = {
      formats: "apply",
      references: {
        "https://example.test/value": { dialect: "draft-2020-12", schema: { type: "string" }, definitions: {} }
      }
    }
    expect(options.formats).type.toBe<"apply" | "ignore" | undefined>()
    expect(options.references).type.toBe<Readonly<Record<string, JsonSchema.Document<"draft-2020-12">>> | undefined>()
  })

  it("preserves the checked schema type for imported assertions", () => {
    const text = Schema.String.check(Schema.isFormat("uri"))
    const conditional = Schema.Number.check(Schema.isConditional(Schema.Number, Schema.Number, Schema.Never))
    const object = Schema.Struct({ name: Schema.String }).check(
      Schema.isAdditionalProperties({ properties: ["name"], patterns: [] }, Schema.Boolean)
    )
    expect<typeof text.Type>().type.toBe<string>()
    expect<typeof conditional.Type>().type.toBe<number>()
    expect<typeof object.Type>().type.toBe<{ readonly name: string }>()
  })
})
