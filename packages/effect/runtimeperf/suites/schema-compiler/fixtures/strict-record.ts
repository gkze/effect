import * as Schema from "effect/Schema"
import * as SchemaParser from "effect/SchemaParser"
import * as SchemaJITCompiler from "effect/unstable/schema/SchemaJITCompiler"
import assert from "node:assert/strict"

const recordCase = (size, valid, compiled) => () => {
  const schema = Schema.Record(Schema.String, Schema.Number)
  if (compiled) SchemaJITCompiler.enable(schema.ast)
  const input = Object.fromEntries(Array.from({ length: size }, (_, i) => [`key${i}`, i]))
  if (!valid) input[`key${size - 1}`] = "invalid"
  const decode = SchemaParser.decodeUnknownResult(schema, { onExcessProperty: "error" })
  return {
    run: () => decode(input),
    validate: (result) => {
      assert.equal(result._tag, valid ? "Success" : "Failure")
      if (valid) {
        assert.deepEqual(result.success, input)
      } else {
        assert.equal(result.failure._tag, "Composite")
        assert.equal(result.failure.issues.length, 1)
        const issue = result.failure.issues[0]
        assert.equal(issue._tag, "Pointer")
        assert.deepEqual(issue.path, [`key${size - 1}`])
        assert.equal(issue.issue._tag, "InvalidType")
      }
    }
  }
}

export const valid1024 = recordCase(1024, true, false)
export const valid1024Compiled = recordCase(1024, true, true)
export const valid4096 = recordCase(4096, true, false)
export const valid4096Compiled = recordCase(4096, true, true)
export const invalid4096 = recordCase(4096, false, false)
export const invalid4096Compiled = recordCase(4096, false, true)
