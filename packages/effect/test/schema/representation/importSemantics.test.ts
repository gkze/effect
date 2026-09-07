/* oxlint-disable unicorn/no-thenable -- JSON Schema conditional keywords */
import { assert, describe, it } from "@effect/vitest"
import { Exit, JsonSchema, Schema, SchemaRepresentation } from "effect"

// oxlint-disable-next-line @typescript-eslint/no-require-imports
const Ajv = require("ajv")
// oxlint-disable-next-line @typescript-eslint/no-require-imports
const Ajv2020 = require("ajv/dist/2020")

function assertImport(
  json: JsonSchema.JsonSchema,
  valid: ReadonlyArray<Schema.Json>,
  invalid: ReadonlyArray<Schema.Json>
) {
  const schema = SchemaRepresentation.fromJsonSchemaDocument(JsonSchema.fromSchemaDraft07(json), {
    patterns: "apply"
  }) as Schema.Codec<unknown>
  const exported = Schema.toJsonSchemaDocument(schema)
  const validators = [
    new Ajv({ strict: false }).compile(json),
    new Ajv2020({ strict: false }).compile({ ...exported.schema, $defs: exported.definitions })
  ]
  for (const [inputs, expected] of [[valid, true], [invalid, false]] as const) {
    for (const input of inputs) {
      for (const validate of validators) assert.strictEqual(validate(input), expected, JSON.stringify(input))
      const result = Schema.decodeUnknownExit(schema, { onExcessProperty: "error" })(input)
      assert.strictEqual(Exit.isSuccess(result), expected, JSON.stringify(input))
      if (Exit.isSuccess(result)) assert.deepStrictEqual(result.value, input)
    }
  }
  return SchemaRepresentation.toCodeDocument(SchemaRepresentation.toRepresentations([schema.ast]))
}

describe("JSON Schema import semantics", () => {
  it("applies typed additional properties only outside declared names", () => {
    for (const name of ["a", "", "a\n", "a.b", "(a)|b", "a\\b", "☃"]) {
      const code = assertImport(
        {
          type: "object",
          properties: { [name]: { type: "string" } },
          required: [name, "extra"],
          additionalProperties: { type: "boolean" }
        },
        [{ [name]: "ok", extra: true }, { [name]: "ok", extra: true, [name + "\n"]: false }],
        [
          { [name]: true, extra: true },
          { [name]: "ok" },
          { [name]: "ok", extra: "bad" },
          { [name]: "ok", extra: true, [name + "\n"]: "bad" }
        ]
      )
      const generated = new Function("Schema", `return ${code.codes[0].runtime}`)(Schema) as Schema.Codec<unknown>
      assert.isTrue(Schema.is(generated)({ [name]: "ok", extra: true }))
      assert.isFalse(Schema.is(generated)({ [name]: "ok", extra: "bad" }))
    }
  })

  it("keeps repeated annotated recursive references without expanding their unions", () => {
    assertImport(
      {
        $ref: "#/definitions/entry",
        definitions: {
          entry: {
            oneOf: [
              { type: "string" },
              {
                type: "object",
                properties: { child: { $ref: "#/definitions/entry", description: "Declared entry" } },
                patternProperties: { "^child$": { $ref: "#/definitions/entry", description: "Pattern entry" } },
                additionalProperties: false
              }
            ]
          }
        }
      },
      ["ok", {}, { child: "ok" }, { child: { child: "ok" } }],
      [1, { child: 1 }, { child: { other: "bad" } }]
    )
  })
  it("excludes declared and patterned properties from the additional value schema", () => {
    assertImport(
      {
        type: "object",
        properties: { name: { type: "string" } },
        patternProperties: { "^n": { type: "string" }, "x$": { minLength: 2 } },
        additionalProperties: { type: "boolean" }
      },
      [{ name: "ok", next: "ok", ax: "ok", extra: true }, { nx: "ok" }],
      [{ name: false }, { next: false }, { ax: "a" }, { nx: "a" }, { extra: "bad" }]
    )
  })

  it("selects conditional branches without narrowing unrelated types", () => {
    assertImport({ if: { type: "string" }, then: { minLength: 2 }, else: { enum: [null, 1] } }, ["ab", null, 1], [
      "a",
      2,
      {},
      []
    ])
    assertImport({ if: { type: "string" }, then: false }, [1, {}, null], ["a", ""])
    assertImport({ if: { type: "string" }, else: false }, ["a", ""], [1, {}, null])
    assertImport(
      {
        allOf: [
          { if: { required: ["a"] }, then: { required: ["b"] } },
          { type: "object", properties: { b: { type: "number" } } }
        ]
      },
      [{}, { b: 1 }, { a: true, b: 1 }],
      [{ a: true }, { b: "bad" }, 1]
    )
  })

  it("enforces required and schema dependencies only when an object has the trigger", () => {
    assertImport({ dependencies: { a: ["b"], c: { properties: { b: { type: "number" } }, required: ["b"] } } }, [
      null,
      1,
      [],
      {},
      { b: "ok" },
      { a: true, b: "ok" },
      { c: true, b: 1 }
    ], [{ a: true }, { c: true }, { c: true, b: "bad" }])
  })

  it("discards impossible structured enum members without losing oneOf exclusivity", () => {
    assertImport({ type: "string", enum: [[], {}, "ok"] }, ["ok"], [[], {}, "bad", 1])
    assertImport(
      {
        type: ["string", "number"],
        oneOf: [
          { anyOf: [{ type: "string" }, { enum: [1] }] },
          { enum: [1, 2] }
        ]
      },
      ["ok", 2],
      [1, {}, null]
    )
    assert.throws(() =>
      SchemaRepresentation.fromJsonSchemaDocument(
        JsonSchema.fromSchemaDraft2020_12({ enum: [{}] })
      ), /Unsupported structured JSON Schema value/)
  })

  it("resolves recursive roots, deep pointers, and escaped keys", () => {
    assertImport(
      { type: "object", properties: { value: { type: "string" }, child: { $ref: "#" } }, additionalProperties: false },
      [{}, { value: "ok", child: { value: "ok" } }],
      [{ value: 1 }, { child: { value: 1 } }, { extra: true }]
    )
    assertImport(
      {
        $ref: "#/definitions/a~1b/properties/x~0y",
        definitions: {
          "a/b": { properties: { "x~y": { type: "string" } } }
        }
      },
      ["ok"],
      [1, {}]
    )
  })

  it("resolves resource identifiers and anchors with explicit external documents", () => {
    const schema = SchemaRepresentation.fromJsonSchemaDocument(
      JsonSchema.fromSchemaDraft2020_12({
        $id: "https://example.test/main.json",
        $ref: "other.json#%65ntry"
      }),
      {
        references: {
          "https://example.test/other.json": JsonSchema.fromSchemaDraft2020_12({
            $id: "other.json",
            $defs: {
              entry: {
                $anchor: "entry",
                type: "object",
                properties: { value: { type: "string" }, child: { $ref: "#entry" } },
                additionalProperties: false
              }
            }
          })
        }
      }
    )
    assert.isTrue(Schema.is(schema)({ value: "ok", child: { value: "ok" } }))
    assert.isFalse(Schema.is(schema)({ child: { value: 1 } }))
    assert.throws(() =>
      SchemaRepresentation.fromJsonSchemaDocument(JsonSchema.fromSchemaDraft2020_12({
        $ref: "https://example.test/missing.json"
      })), /Unsupported reference/)
    assert.throws(() =>
      SchemaRepresentation.fromJsonSchemaDocument(JsonSchema.fromSchemaDraft2020_12({
        examples: [{ type: "string" }],
        $ref: "#/examples/0"
      })), /Invalid reference/)
  })

  it("keeps relative references scoped to their root resources", () => {
    const schemas = SchemaRepresentation.fromJsonSchemaMultiDocument({
      dialect: "draft-2020-12",
      schemas: [
        { $id: "https://a.test/root", $ref: "#/$defs/value" },
        { $id: "https://b.test/root", $ref: "#/$defs/value" }
      ],
      definitions: { value: { $ref: "value" } }
    }, {
      references: {
        "https://a.test/value": JsonSchema.fromSchemaDraft2020_12({ type: "string" }),
        "https://b.test/value": JsonSchema.fromSchemaDraft2020_12({ type: "number" })
      }
    })
    assert.isTrue(Schema.is(schemas[0])("ok"))
    assert.isFalse(Schema.is(schemas[0])(1))
    assert.isTrue(Schema.is(schemas[1])(1))
    assert.isFalse(Schema.is(schemas[1])("ok"))
  })

  it("applies opt-in formats in native and generated schemas", () => {
    const examples = {
      uri: {
        valid: ["https://example.test/a?b=c#d", "urn:example:animal", "mailto:a@b.test", "http://[::1]/"],
        invalid: ["relative", "http://a/%xx", "http://[bad]/", "https://a/\n"]
      },
      email: {
        valid: ["a+b@example.test", "a.b@sub.example.test"],
        invalid: ["a@b", "a..b@example.test", "a@-bad.test"]
      },
      date: {
        valid: ["2000-02-29", "2024-02-29", "2023-12-31"],
        invalid: ["1900-02-29", "2023-02-29", "2024-04-31", "2024-13-01"]
      },
      regex: { valid: ["^a+$", ""], invalid: ["[", "("] }
    }
    for (const [format, values] of Object.entries(examples)) {
      const document = JsonSchema.fromSchemaDraft2020_12({ type: "string", format })
      const schema = SchemaRepresentation.fromJsonSchemaDocument(document, { formats: "apply" })
      const code = SchemaRepresentation.toCodeDocument(SchemaRepresentation.toRepresentations([schema.ast]))
      const generated = new Function("Schema", `return ${code.codes[0].runtime}`)(Schema) as Schema.Codec<unknown>
      for (const value of values.valid) {
        assert.isTrue(Schema.is(schema)(value), value)
        assert.isTrue(Schema.is(generated)(value), value)
      }
      for (const value of values.invalid) {
        assert.isFalse(Schema.is(schema)(value), value)
        assert.isFalse(Schema.is(generated)(value), value)
        assert.isTrue(Schema.is(SchemaRepresentation.fromJsonSchemaDocument(document))(value))
      }
    }
    assert.throws(() =>
      SchemaRepresentation.fromJsonSchemaDocument(
        JsonSchema.fromSchemaDraft2020_12({ type: "string", format: "custom" }),
        { formats: "apply" }
      ), /Unsupported JSON Schema format/)
  })
  it("resolves nested resource IDs and empty identifier fragments", () => {
    const schema = SchemaRepresentation.fromJsonSchemaDocument(JsonSchema.fromSchemaDraft2020_12({
      $id: "https://example.test/root#",
      $ref: "child#/$defs/value",
      $defs: {
        child: { $id: "child", $defs: { value: { type: "string" } } }
      }
    }))
    assert.isTrue(Schema.is(schema)("ok"))
    assert.isFalse(Schema.is(schema)(1))
  })
  it("preserves conditional checks when intersecting literal unions in either order", () => {
    for (
      const allOf of [
        [{ enum: ["a", "b"] }, { const: "a", if: true, then: false }],
        [{ const: "a", if: true, then: false }, { enum: ["a", "b"] }]
      ]
    ) {
      assertImport({ allOf }, [], ["a", "b", null, 1])
    }
  })
})
