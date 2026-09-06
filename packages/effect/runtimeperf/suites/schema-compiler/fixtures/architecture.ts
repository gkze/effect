import * as Schema from "effect/Schema"
import * as SchemaParser from "effect/SchemaParser"
import * as SchemaJITCompiler from "effect/unstable/schema/SchemaJITCompiler"
import assert from "node:assert/strict"

const setCase = (compiled: boolean) => {
  const child = Schema.Struct({ name: Schema.String, count: Schema.Number })
  const schema = Schema.ReadonlySet(child)
  const input = new Set(Array.from({ length: 32 }, (_, count) => ({ name: "value", count })))
  if (compiled) SchemaJITCompiler.enable(schema.ast)
  const decode = SchemaParser.decodeUnknownSync(schema)
  return { run: () => decode(input), validate: (result) => assert.deepEqual(result, input) }
}

export const declarationSet = () => setCase(false)
export const declarationSetCompiled = () => setCase(true)

const checkedStructCase = (invalid: boolean, compiled: boolean) => {
  const schema = Schema.Struct(Object.fromEntries(
    Array.from({ length: 32 }, (_, i) => [`field${i}`, Schema.NumberFromString])
  )).check(Schema.makeFilter((output) => output.field31 > 0))
  const input = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`field${i}`, String(invalid ? -i : i)]))
  const expected = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`field${i}`, i]))
  if (compiled) SchemaJITCompiler.enable(schema.ast)
  const decode = SchemaParser.decodeUnknownSync(schema)
  return {
    run: invalid ?
      () => {
        try {
          decode(input)
          return false
        } catch {
          return true
        }
      } :
      () => decode(input),
    validate: (result) => assert.deepEqual(result, invalid ? true : expected)
  }
}

export const checkedStructValid = () => checkedStructCase(false, true)
export const checkedStructInvalid = () => checkedStructCase(true, true)
export const checkedStructValidInterpreted = () => checkedStructCase(false, false)
export const checkedStructInvalidInterpreted = () => checkedStructCase(true, false)

const syncCase = (encode: boolean, compiled: boolean) => {
  const schema = Schema.Struct({ name: Schema.String, count: Schema.Number, active: Schema.Boolean })
  const input = { name: "value", count: 1, active: true }
  if (compiled) SchemaJITCompiler.enable(schema.ast)
  const parse = encode ? SchemaParser.encodeUnknownSync(schema) : SchemaParser.decodeUnknownSync(schema)
  return { run: () => parse(input), validate: (result) => assert.deepEqual(result, input) }
}

export const syncDecode = () => syncCase(false, true)
export const syncEncode = () => syncCase(true, true)
export const syncDecodeInterpreted = () => syncCase(false, false)
export const syncEncodeInterpreted = () => syncCase(true, false)
