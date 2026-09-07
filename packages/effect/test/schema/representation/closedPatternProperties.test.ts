import { assert, describe, it } from "@effect/vitest"
import { Exit, JsonSchema, Schema, SchemaRepresentation } from "effect"

// oxlint-disable-next-line @typescript-eslint/no-require-imports
const AjvDraft07 = require("ajv")
// oxlint-disable-next-line @typescript-eslint/no-require-imports
const Ajv2020 = require("ajv/dist/2020")

function assertCases(
  json: JsonSchema.JsonSchema,
  valid: ReadonlyArray<Schema.Json>,
  invalid: ReadonlyArray<Schema.Json>
) {
  const schema = SchemaRepresentation.fromJsonSchemaDocument(JsonSchema.fromSchemaDraft07(json), {
    patterns: "apply"
  }) as Schema.Codec<unknown>
  const document = SchemaRepresentation.toRepresentations([schema.ast])
  const code = SchemaRepresentation.toCodeDocument(document)
  const generated = new Function("Schema", `return ${code.codes[0].runtime}`)(Schema) as Schema.Codec<unknown>
  const roundtrip = Schema.toJsonSchemaDocument(schema)
  const schemas = [schema, generated]
  const validators = [
    new AjvDraft07({ strict: false }).compile(json),
    new Ajv2020({ strict: false }).compile(roundtrip.schema)
  ]
  for (const [inputs, expected] of [[valid, true], [invalid, false]] as const) {
    for (const input of inputs) {
      for (const validate of validators) assert.strictEqual(validate(input), expected, JSON.stringify(input))
      for (const candidate of schemas) {
        assert.strictEqual(Schema.is(candidate)(input), expected, JSON.stringify(input))
        for (const options of [undefined, { onExcessProperty: "error" }] as const) {
          const result = Schema.decodeUnknownExit(candidate, options)(input)
          assert.strictEqual(Exit.isSuccess(result), expected, JSON.stringify(input))
          if (Exit.isSuccess(result)) assert.deepStrictEqual(result.value, input)
        }
      }
    }
  }
}

describe("closed pattern properties", () => {
  it("accepts declared and patterned exports while rejecting unrelated keys", () => {
    assertCases(
      {
        type: "object",
        properties: { ".": { type: "string" } },
        patternProperties: { "^\\./.+": { type: "string" } },
        additionalProperties: false
      },
      [{}, { ".": "./index.js", "./feature": "./feature.js" }],
      [
        { feature: "./feature.js" },
        { "./feature": false },
        { ".": false }
      ]
    )
  })

  it("intersects overlapping patterns and applies them to declared properties", () => {
    assertCases(
      {
        type: "object",
        properties: { ab: { type: "integer" } },
        required: ["ab"],
        patternProperties: { "^a": { type: "number", minimum: 0 }, "b$": { type: "number", maximum: 10 } },
        additionalProperties: false
      },
      [{ ab: 5, ax: 20, xb: -5, axb: 5 }],
      [
        { ab: 5.5 },
        { ab: -1 },
        { ab: 11 },
        { ab: 5, axb: 11 },
        { ab: 5, axb: -1 },
        { ab: 5, extra: 0 },
        { ax: 5 }
      ]
    )
  })

  it("keeps declared property types independent of nonmatching patterns", () => {
    assertCases(
      {
        type: "object",
        properties: { count: { type: "integer" } },
        patternProperties: { "^s": { type: "string" } },
        additionalProperties: false
      },
      [{ count: 1, str: "value" }],
      [{ count: "1" }, { str: 1 }, { other: "value" }]
    )
  })

  it("allows required-only names only when a pattern matches", () => {
    for (const required of ["abc", "other"]) {
      assertCases(
        {
          type: "object",
          required: [required],
          patternProperties: { "^a": { type: "number" } },
          additionalProperties: false
        },
        required === "abc" ? [{ abc: 1 }] : [],
        [
          {},
          { other: 1 },
          { abc: "value" },
          { abc: 1, other: 1 }
        ]
      )
    }
  })

  it("preserves captures, backreferences, empty matches, and newlines", () => {
    for (const pattern of ["^(a)\\1$", "^(b)\\1$", "", "a*", "\n"]) {
      const valid: Array<Schema.Json> = []
      const invalid: Array<Schema.Json> = []
      for (const key of ["", "aa", "bb", "ab", "other", "\n"]) {
        ;(new RegExp(pattern).test(key) ? valid : invalid).push({ [key]: "value" })
        invalid.push({ [key]: 1 })
      }
      assertCases(
        { type: "object", patternProperties: { [pattern]: { type: "string" } }, additionalProperties: false },
        valid,
        invalid
      )
    }
    assertCases(
      {
        type: "object",
        patternProperties: { "^(a)\\1$": { type: "string" }, "^(b)\\1$": { type: "number" } },
        additionalProperties: false
      },
      [{ aa: "value", bb: 1 }],
      [{ ab: 1 }, { bb: "value" }]
    )
  })

  it("combines closure with propertyNames and property counts", () => {
    assertCases(
      {
        type: "object",
        patternProperties: { "^a": { type: "number" } },
        propertyNames: { maxLength: 2 },
        minProperties: 1,
        maxProperties: 2,
        additionalProperties: false
      },
      [{ a: 1, ab: 2 }],
      [{}, { abc: 1 }, { a: 1, ab: 2, ac: 3 }, { b: 1 }]
    )
  })

  it("preserves the closed scope through references and finite intersections", () => {
    const json = {
      type: "object",
      properties: { ab: { type: "number" }, other: { type: "number" } },
      additionalProperties: false,
      allOf: [
        { $ref: "#/definitions/closed" }
      ],
      definitions: {
        closed: {
          type: "object",
          patternProperties: { "^a": { type: "number", minimum: 0 } },
          additionalProperties: false
        }
      }
    }
    const schema = SchemaRepresentation.fromJsonSchemaDocument(JsonSchema.fromSchemaDraft07(json), {
      patterns: "apply"
    }) as Schema.Codec<unknown>
    const validate = new AjvDraft07({ strict: false }).compile(json)
    // Finite object domains use the standard excess-property decoding option.
    const decode = Schema.decodeUnknownExit(schema, { onExcessProperty: "error" })
    for (const input of [{}, { ab: 1 }, { ab: -1 }, { other: 1 }, { ax: 1 }]) {
      assert.strictEqual(Exit.isSuccess(decode(input)), validate(input))
    }
  })
})
