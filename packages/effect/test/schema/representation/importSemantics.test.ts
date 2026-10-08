/* oxlint-disable unicorn/no-thenable -- JSON Schema conditional keywords */
import { assert, describe, it } from "@effect/vitest"
import { Exit, JsonSchema, Schema, SchemaRepresentation } from "effect"

// oxlint-disable-next-line @typescript-eslint/no-require-imports
const AjvDraft07 = require("ajv")
// oxlint-disable-next-line @typescript-eslint/no-require-imports
const AjvDraft2020 = require("ajv/dist/2020")

/**
 * Compares an imported schema with an independent validator for the source
 * document and for the document exported from the imported schema.
 */
function assertImport(
  json: JsonSchema.JsonSchema,
  valid: ReadonlyArray<Schema.Json>,
  invalid: ReadonlyArray<Schema.Json>
) {
  const schema = SchemaRepresentation.fromJsonSchemaDocument(JsonSchema.fromSchemaDraft07(json), {
    patterns: "apply"
  }) as Schema.Codec<unknown>
  const exported = Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" })
  const validators = [
    new AjvDraft07.default({ strict: false }).compile(json),
    new AjvDraft2020.default({ strict: false }).compile({ ...exported.schema, $defs: exported.definitions })
  ]
  for (const [inputs, expected] of [[valid, true], [invalid, false]] as const) {
    for (const input of inputs) {
      for (const validate of validators) assert.strictEqual(validate(input), expected, JSON.stringify(input))
      const result = Schema.decodeUnknownExit(schema, { onExcessProperty: "error" })(input)
      assert.strictEqual(Exit.isSuccess(result), expected, JSON.stringify(input))
      if (Exit.isSuccess(result)) assert.deepStrictEqual(result.value, input)
    }
  }
  const code = SchemaRepresentation.toCodeDocument(SchemaRepresentation.toRepresentations([schema.ast]))
  // Recursive references carry TypeScript return types; evaluate them as JavaScript.
  const javascript = (runtime: string) => runtime.replace(/\(\): Schema\.Codec<\w+> =>/g, "() =>")
  const declarations = [
    ...code.references.nonRecursives.map(({ $ref, code }) => `const ${$ref} = ${javascript(code.runtime)};`),
    ...Object.entries(code.references.recursives).map(([$ref, code]) => `const ${$ref} = ${javascript(code.runtime)};`)
  ]
  const generated = new Function("Schema", `${declarations.join("\n")}\nreturn ${javascript(code.codes[0].runtime)}`)(
    Schema
  ) as Schema.Codec<unknown>
  for (const [inputs, expected] of [[valid, true], [invalid, false]] as const) {
    for (const input of inputs) {
      const result = Schema.decodeUnknownExit(generated, { onExcessProperty: "error" })(input)
      assert.strictEqual(Exit.isSuccess(result), expected, `generated: ${JSON.stringify(input)}`)
    }
  }
  return code
}

describe("JSON Schema import semantics", () => {
  it("applies typed additional properties only outside declared names", () => {
    for (const name of ["a", "", "a\n", "a.b", "(a)|b", "a\\b", "☃"]) {
      assertImport(
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
    }
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

  it("checks open patterns without typing unmatched keys", () => {
    assertImport(
      { type: "object", properties: { a: { type: "string" } }, patternProperties: { "^_": { type: "number" } } },
      [{}, { a: "ok", _b: 1, c: "any" }],
      [{ a: 1 }, { _b: "bad" }]
    )
  })

  it("keeps each object scope's additional values when intersecting", () => {
    assertImport(
      {
        allOf: [
          { type: "object", properties: { a: { type: "string" } }, additionalProperties: { type: "number" } },
          {
            type: "object",
            properties: { c: { type: "number" } },
            additionalProperties: { type: ["number", "string"] }
          }
        ]
      },
      [{}, { a: "x", c: 1 }, { a: "x", d: 2 }],
      [{ a: "x", d: "y" }, { c: "x" }, { a: 1 }, { d: true }]
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
    assertImport({ if: { type: "string" } }, ["a", 1, null], [])
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

  it("applies conditions to references", () => {
    assertImport(
      {
        allOf: [{ $ref: "#/definitions/value" }],
        if: { type: "string" },
        then: { minLength: 2 },
        definitions: { value: { type: ["string", "number"] } }
      },
      ["ab", 1],
      ["a", null]
    )
  })

  it("preserves conditional checks when intersecting literal unions in either order", () => {
    for (
      const allOf of [
        [{ enum: ["a", "b"] }, { enum: ["a", "c"], if: true, then: false }],
        [{ enum: ["a", "c"], if: true, then: false }, { enum: ["a", "b"] }],
        [{ enum: ["a", "b"] }, { const: "a", if: true, then: false }],
        [{ const: "a", if: true, then: false }, { enum: ["a", "b"] }]
      ]
    ) {
      assertImport({ allOf }, [], ["a", "b", null, 1])
    }
  })

  it("discards structured enum members excluded by an explicit type", () => {
    assertImport({ type: "string", enum: [[], {}, "ok"] }, ["ok"], [[], {}, "bad", 1])
    assertImport({ type: ["string", "array"], enum: [{}, "ok"] }, ["ok"], [{}, [], "bad"])
    for (const json of [{ enum: [{}] }, { type: ["string", "object"], enum: [{}] }]) {
      assert.throws(
        () => SchemaRepresentation.fromJsonSchemaDocument(JsonSchema.fromSchemaDraft2020_12(json)),
        /Only primitive values are supported in "const" and "enum"/
      )
    }
  })

  it("keeps repeated annotated recursive references in closed patterned objects", () => {
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
})
