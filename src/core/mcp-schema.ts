type Schema = Record<string, unknown>;

/** Keywords that stay. Anything else is dropped, because providers reject JSON Schema they do not support. */
const KEEP = new Set([
  "type", "properties", "required", "description", "enum", "const", "default", "title", "format",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
  "minLength", "maxLength", "pattern", "minItems", "maxItems", "uniqueItems",
  "items", "prefixItems", "additionalProperties", "anyOf", "oneOf", "allOf", "not",
]);
const NESTED = new Set(["properties", "items", "not", "prefixItems", "anyOf", "oneOf", "allOf", "additionalProperties"]);
const MAX_DEPTH = 24;

const isObject = (value: unknown): value is Schema => typeof value === "object" && value !== null && !Array.isArray(value);

/** Resolves a local "#/$defs/x" or "#/definitions/x" reference. Returns undefined for anything else. */
function lookup(root: Schema, ref: unknown): Schema | undefined {
  if (typeof ref !== "string" || !ref.startsWith("#/")) return undefined;
  let node: unknown = root;
  for (const part of ref.slice(2).split("/")) node = isObject(node) ? node[part.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined;
  return isObject(node) ? node : undefined;
}

function clean(node: unknown, root: Schema, depth: number, seen: readonly string[]): Schema {
  if (!isObject(node) || depth > MAX_DEPTH) return {};
  if (typeof node.$ref === "string") {
    // Inline a reference once. A recursive one (z.lazy) becomes {}, which accepts anything.
    const target = seen.includes(node.$ref) ? undefined : lookup(root, node.$ref);
    return target ? clean(target, root, depth + 1, [...seen, node.$ref]) : {};
  }
  const out: Schema = {};
  for (const [key, value] of Object.entries(node)) {
    if (!KEEP.has(key)) continue;
    if (key === "properties" && isObject(value)) {
      out.properties = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, clean(child, root, depth + 1, seen)]));
    } else if (key === "items" || key === "not") {
      out[key] = clean(value, root, depth + 1, seen);
    } else if (key === "additionalProperties") {
      out[key] = typeof value === "boolean" ? value : clean(value, root, depth + 1, seen);
    } else if ((key === "prefixItems" || key === "anyOf" || key === "oneOf" || key === "allOf") && Array.isArray(value)) {
      out[key] = value.map((child) => clean(child, root, depth + 1, seen));
    } else if (!NESTED.has(key)) {
      out[key] = value;
    }
  }
  // patternProperties is not supported, so keep its values as additionalProperties when none is set.
  if (isObject(node.patternProperties) && out.additionalProperties === undefined) {
    const first = Object.values(node.patternProperties)[0];
    if (first !== undefined) out.additionalProperties = clean(first, root, depth + 1, seen);
  }
  return out;
}

/** Makes an MCP tool inputSchema safe for the model provider: drops propertyNames and other unsupported keywords, and always returns type object. */
export function sanitizeMcpSchema(schema: unknown): Schema & { type: "object" } {
  if (!isObject(schema)) return { type: "object", properties: {} };
  const out = clean(schema, schema, 0, []);
  // A root that is not an object (a union, say) cannot be a tool input, so it falls back to an open object.
  return out.type === "object" ? (out as Schema & { type: "object" }) : { type: "object", properties: {} };
}
