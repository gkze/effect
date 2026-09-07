import * as JsonPointer from "../../JsonPointer.ts"
import type * as JsonSchema from "../../JsonSchema.ts"
import { errorWithPath } from "../errors.ts"

type Path = ReadonlyArray<string | number>

interface Target {
  readonly input: unknown
  readonly path: Path
  readonly base: string
  readonly isRoot: boolean
}

const maps = new Set(["$defs", "properties", "patternProperties", "dependentSchemas"])
const arrays = new Set(["prefixItems", "allOf", "anyOf", "oneOf"])
const singles = new Set([
  "items",
  "additionalProperties",
  "propertyNames",
  "contains",
  "not",
  "if",
  "then",
  "else",
  "unevaluatedItems",
  "unevaluatedProperties"
])

/** @internal */
export function makeReferenceIndex(
  document: JsonSchema.MultiDocument<"draft-2020-12">,
  external: Readonly<Record<string, JsonSchema.Document<"draft-2020-12">>> | undefined,
  singleRoot: boolean
) {
  const locations = new Map<string, Target>()
  const resources = new Set<string>()
  const targets = new Map<string, Target>()
  const keys = new Map<Target, string>()
  const sharedDefinitions = new Map<unknown, Map<string, Target>>()
  const reserved = new Set(Object.keys(document.definitions))
  const bases = document.schemas.map((_, index) => `https://effect.invalid/.json-schema/${index}`)

  function register(address: string, target: Target): void {
    const previous = locations.get(address)
    if (previous !== undefined && previous.input !== target.input) {
      throw errorWithPath(`Duplicate JSON Schema resource ${JSON.stringify(address)}`, target.path)
    }
    locations.set(address, target)
  }

  function index(
    input: unknown,
    pointer: ReadonlyArray<string>,
    path: Path,
    base: string,
    scopes: ReadonlyArray<{ readonly uri: string; readonly pointer: ReadonlyArray<string> }>
  ): void {
    if (typeof input !== "boolean" && (typeof input !== "object" || input === null || Array.isArray(input))) return
    // Roots without a resource identifier share the document's definition scope.
    const definitionBase = path[0] === "definitions" && bases.includes(base) ? bases[0] : base
    let target: Target = { input, path, base: definitionBase, isRoot: pointer.length === 0 }
    if (path[0] === "definitions") {
      let scopes = sharedDefinitions.get(input)
      if (scopes === undefined) sharedDefinitions.set(input, scopes = new Map())
      const shared = scopes.get(definitionBase)
      if (shared === undefined) scopes.set(definitionBase, target)
      else target = shared
    }
    const schema = input as JsonSchema.JsonSchema
    if (typeof schema.$id === "string") {
      if (!URL.canParse(schema.$id, base)) {
        throw errorWithPath("Invalid JSON Schema resource identifier", [...path, "$id"])
      }
      const url = new URL(schema.$id, base)
      if (url.hash !== "") throw errorWithPath("Unsupported JSON Schema resource fragment", [...path, "$id"])
      url.hash = ""
      base = url.href
      scopes = [...scopes, { uri: base, pointer }]
    }
    for (const scope of scopes) {
      resources.add(scope.uri)
      register(`${scope.uri}\u0000${JSON.stringify(pointer.slice(scope.pointer.length))}`, target)
    }
    if (typeof schema.$anchor === "string") register(`${base}#${schema.$anchor}`, target)
    for (const [keyword, value] of Object.entries(input)) {
      if (maps.has(keyword) && typeof value === "object" && value !== null && !Array.isArray(value)) {
        for (const [key, member] of Object.entries(value)) {
          const memberPath = pointer.length === 0 && keyword === "$defs"
            ? path[0] === "references" ? [...path.slice(0, -1), "definitions", key] : ["definitions", key]
            : [...path, keyword, key]
          index(member, [...pointer, keyword, key], memberPath, base, scopes)
        }
      } else if (arrays.has(keyword) && Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          index(value[i], [...pointer, keyword, String(i)], [...path, keyword, i], base, scopes)
        }
      } else if (singles.has(keyword)) index(value, [...pointer, keyword], [...path, keyword], base, scopes)
    }
  }

  function addDocument(input: JsonSchema.Document<"draft-2020-12">, base: string, path: Path): void {
    index({ ...input.schema, $defs: input.definitions }, [], path, base, [{ uri: base, pointer: [] }])
  }

  for (let i = 0; i < document.schemas.length; i++) {
    addDocument(
      { dialect: document.dialect, schema: document.schemas[i], definitions: document.definitions },
      bases[i],
      singleRoot ? ["schema"] : ["schemas", i]
    )
  }
  for (const [uri, input] of Object.entries(external ?? {})) {
    if (!URL.canParse(uri) || new URL(uri).hash !== "") {
      throw errorWithPath("Invalid JSON Schema resource URI", ["references", uri])
    }
    const url = new URL(uri)
    url.hash = ""
    addDocument(input, url.href, ["references", uri, "schema"])
  }

  function resourceBase(input: JsonSchema.JsonSchema, base: string, path: Path): string {
    if (typeof input.$id !== "string") return base
    if (!URL.canParse(input.$id, base)) throw errorWithPath("Invalid JSON Schema resource identifier", [...path, "$id"])
    const url = new URL(input.$id, base)
    url.hash = ""
    return url.href
  }

  function reference(ref: string, base: string, path: Path): string {
    if (!URL.canParse(ref, base)) throw errorWithPath(`Unsupported reference ${JSON.stringify(ref)}`, path)
    const url = new URL(ref, base)
    const fragment = url.hash
    url.hash = ""
    const pointer = JsonPointer.parseUriFragment(fragment)
    let address: string
    if (pointer === undefined) {
      try {
        address = url.href + decodeURIComponent(fragment)
      } catch {
        throw errorWithPath(`Invalid reference ${JSON.stringify(ref)}`, path)
      }
    } else {
      address = `${url.href}\u0000${JSON.stringify(pointer)}`
    }
    const target = locations.get(address)
    if (target === undefined) {
      throw errorWithPath(
        `${resources.has(url.href) ? "Invalid" : "Unsupported"} reference ${JSON.stringify(ref)}`,
        path
      )
    }
    const existing = keys.get(target)
    if (existing !== undefined) return existing
    const localKey =
      pointer?.length === 2 && pointer[0] === "$defs" && target.input === document.definitions[pointer[1]] &&
        !targets.has(pointer[1])
        ? pointer[1]
        : undefined
    let key = localKey ?? (pointer?.length ? pointer[pointer.length - 1] : "Root")
    if (localKey === undefined) {
      const prefix = key
      let suffix = 1
      while (reserved.has(key)) key = `${prefix}_${suffix++}`
      reserved.add(key)
    }
    keys.set(target, key)
    targets.set(key, target)
    return key
  }

  return { bases, resourceBase, reference, targets }
}
