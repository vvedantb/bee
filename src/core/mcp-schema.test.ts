import { describe, expect, it } from "vitest";
import { z } from "zod";
import { sanitizeMcpSchema } from "./mcp-schema";

const text = (value: unknown) => JSON.stringify(value);

describe("sanitizeMcpSchema", () => {
  it("keeps a simple object schema", () => {
    const schema = { type: "object", properties: { table: { type: "string" } }, required: ["table"] };
    expect(sanitizeMcpSchema(schema)).toEqual(schema);
  });

  it("drops propertyNames from a Zod record and keeps additionalProperties", () => {
    const zodSchema = z.object({ questions: z.record(z.string().min(1).max(64).regex(/^[a-z_]+$/), z.object({ text: z.string() })) });
    const raw = z.toJSONSchema(zodSchema);
    expect(text(raw)).toContain("propertyNames");
    const clean = sanitizeMcpSchema(raw);
    expect(text(clean)).not.toContain("propertyNames");
    expect(text(clean)).not.toContain("$schema");
    const questions = (clean.properties as Record<string, Record<string, unknown>>).questions as Record<string, unknown>;
    expect(questions.additionalProperties).toEqual({ type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false });
  });

  it("cleans nested keywords and refs", () => {
    const clean = sanitizeMcpSchema({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "x",
      type: "object",
      $defs: { json: { anyOf: [{ type: "string" }, { type: "array", items: { $ref: "#/$defs/json" } }] }, id: { type: "string", minLength: 1 } },
      properties: {
        id: { $ref: "#/$defs/id" },
        value: { $ref: "#/$defs/json" },
        list: { type: "array", items: { type: "object", propertyNames: { maxLength: 4 }, additionalProperties: { type: "number" }, unevaluatedProperties: false } },
        choice: { anyOf: [{ type: "string", contentEncoding: "base64", contentMediaType: "image/png" }, { type: "null" }] },
        map: { type: "object", patternProperties: { "^a": { type: "string" } } },
        cond: { type: "object", if: { properties: {} }, then: { required: ["a"] }, else: {}, dependentSchemas: {}, dependentRequired: {} },
      },
    });
    const out = text(clean);
    for (const word of ["$schema", "$id", "$ref", "$defs", "propertyNames", "unevaluated", "contentEncoding", "contentMediaType", "patternProperties", '"if"', '"then"', '"else"', "dependent"]) {
      expect(out).not.toContain(word);
    }
    const props = clean.properties as Record<string, Record<string, unknown>>;
    expect(props.id).toEqual({ type: "string", minLength: 1 });
    expect(props.list?.items).toEqual({ type: "object", additionalProperties: { type: "number" } });
    expect(props.map?.additionalProperties).toEqual({ type: "string" });
    // The recursive ref is inlined once, so the self-reference becomes {}.
    expect(props.value).toEqual({ anyOf: [{ type: "string" }, { type: "array", items: {} }] });
  });

  it("falls back to an open object for a missing or non-object root", () => {
    expect(sanitizeMcpSchema(undefined)).toEqual({ type: "object", properties: {} });
    expect(sanitizeMcpSchema({ anyOf: [{ type: "string" }] })).toEqual({ type: "object", properties: {} });
  });
});
