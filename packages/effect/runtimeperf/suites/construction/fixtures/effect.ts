import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as SchemaParser from "effect/SchemaParser"
import assert from "node:assert/strict"

export const struct = () => {
  const schema = Schema.Struct({ a: Schema.String, b: Schema.Number })
  const make = SchemaParser.make(schema)
  const input = { a: "a", b: 1 }
  return { run: () => make(input), validate: (out) => assert.deepEqual(out, input) }
}

export const defaults = () => {
  const schema = Schema.Struct({
    a: Schema.String,
    b: Schema.Number.pipe(Schema.withConstructorDefault(Effect.succeed(1)))
  })
  const make = SchemaParser.make(schema)
  const input = { a: "a" }
  return { run: () => make(input), validate: (out) => assert.deepEqual(out, { a: "a", b: 1 }) }
}

export const array = () => {
  const schema = Schema.Array(Schema.Struct({ a: Schema.String }))
  const make = SchemaParser.make(schema)
  const input = Array.from({ length: 32 }, () => ({ a: "a" }))
  return { run: () => make(input), validate: (out) => assert.deepEqual(out, input) }
}

export const union = () => {
  const schema = Schema.Union([
    Schema.Struct({ _tag: Schema.tag("A"), a: Schema.String }),
    Schema.Struct({ _tag: Schema.tag("B"), b: Schema.Number })
  ])
  const make = SchemaParser.make(schema)
  const input = { a: "a" }
  return { run: () => make(input), validate: (out) => assert.deepEqual(out, { _tag: "A", a: "a" }) }
}

export const classValue = () => {
  class A extends Schema.Class<A>("A")({ a: Schema.String }) {}
  const make = SchemaParser.make(A)
  const input = { a: "a" }
  return {
    run: () => make(input),
    validate: (out) => {
      assert(out instanceof A)
      assert.equal(out.a, "a")
    }
  }
}

export const cold = () => ({
  run: () => SchemaParser.make(Schema.Struct({ a: Schema.String }))({ a: "a" }),
  validate: (out) => assert.deepEqual(out, { a: "a" })
})
