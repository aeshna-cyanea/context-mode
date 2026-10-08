/**
 * Fork feature: CONTEXT_MODE_DEFAULT_LANGUAGE — the opt-in default for the
 * `language` field of ctx_execute / ctx_execute_file.
 *
 * Upstream makes `language` required, so an omitted call dies in schema
 * validation ("language: must have required properties language") and costs a
 * whole round trip. This fork adds an opt-in default.
 *
 * The contract autumn set, and the thing this file exists to keep true:
 *   UNSET (or invalid)  -> the upstream field, unchanged. Required, same
 *                          description string. No behaviour this fork invented.
 *   SET to a language   -> optional, carries `default`, runs in that language.
 *
 * The unset half is the load-bearing one: it is what keeps the fork's default
 * shape identical to upstream, so there is nothing extra to re-verify at every
 * `git fetch` + sync.
 *
 * Run: npx vitest run tests/core/language-default.test.ts
 */

import { describe, test, expect } from "vitest";
import { z } from "zod";

import { languageField, resolveDefaultLanguage } from "../../src/server.js";

/** Upstream's exact description string for the `language` field. */
const UPSTREAM_DESCRIPTION = "Runtime language";

describe("resolveDefaultLanguage", () => {
  test("unset -> undefined (meaning: emit the upstream field)", () => {
    expect(resolveDefaultLanguage({})).toBeUndefined();
  });

  test("empty or whitespace-only -> undefined", () => {
    expect(resolveDefaultLanguage({ CONTEXT_MODE_DEFAULT_LANGUAGE: "" })).toBeUndefined();
    expect(resolveDefaultLanguage({ CONTEXT_MODE_DEFAULT_LANGUAGE: "   " })).toBeUndefined();
  });

  test("valid language -> that language", () => {
    expect(resolveDefaultLanguage({ CONTEXT_MODE_DEFAULT_LANGUAGE: "python" })).toBe("python");
    expect(resolveDefaultLanguage({ CONTEXT_MODE_DEFAULT_LANGUAGE: "shell" })).toBe("shell");
    expect(resolveDefaultLanguage({ CONTEXT_MODE_DEFAULT_LANGUAGE: "csharp" })).toBe("csharp");
  });

  test("surrounding whitespace is tolerated", () => {
    expect(resolveDefaultLanguage({ CONTEXT_MODE_DEFAULT_LANGUAGE: "  python  " })).toBe("python");
  });

  test("case-insensitive, so CONTEXT_MODE_DEFAULT_LANGUAGE=PYTHON is not a silent no-op", () => {
    expect(resolveDefaultLanguage({ CONTEXT_MODE_DEFAULT_LANGUAGE: "Python" })).toBe("python");
    expect(resolveDefaultLanguage({ CONTEXT_MODE_DEFAULT_LANGUAGE: "TYPESCRIPT" })).toBe("typescript");
  });

  test("a value outside the language list -> undefined, never a runtime error later", () => {
    expect(resolveDefaultLanguage({ CONTEXT_MODE_DEFAULT_LANGUAGE: "klingon" })).toBeUndefined();
    expect(resolveDefaultLanguage({ CONTEXT_MODE_DEFAULT_LANGUAGE: "js" })).toBeUndefined();
    expect(resolveDefaultLanguage({ CONTEXT_MODE_DEFAULT_LANGUAGE: "node" })).toBeUndefined();
  });
});

describe("languageField — unset: upstream parity", () => {
  test("description is upstream's string verbatim", () => {
    expect(languageField(undefined).description).toBe(UPSTREAM_DESCRIPTION);
  });

  test("field is required — an omitted `language` fails validation, as upstream", () => {
    const field = languageField(undefined);
    expect(field.isOptional()).toBe(false);
    const shape = z.object({ language: field, code: z.string() });
    const parsed = shape.safeParse({ code: "console.log(1)" });
    expect(parsed.success).toBe(false);
    expect(parsed.error.issues.some((i) => i.path[0] === "language")).toBe(true);
  });

  test("no default is carried into the field", () => {
    const field = languageField(undefined);
    // zod 3.25 keeps the default behind _def.defaultValue(); a plain ZodEnum
    // has no such accessor. Asserting `.defaultValue` directly would pass
    // against either shape, which is the whole trap.
    expect(typeof (field as any)._def.defaultValue).toBe("undefined");
  });
});

describe("languageField — set: opt-in default", () => {
  test("field becomes optional and carries the default", () => {
    const field = languageField("python");
    expect(field.isOptional()).toBe(true);
    expect((field as any)._def.defaultValue()).toBe("python");
  });

  test("description names the default so the model can see it", () => {
    expect(languageField("python").description).toContain("python");
  });

  test("an omitted `language` parses to the configured language", () => {
    const shape = z.object({ language: languageField("python"), code: z.string() });
    const parsed = shape.safeParse({ code: "print(1)" });
    expect(parsed.success).toBe(true);
    expect((parsed.data as any).language).toBe("python");
  });

  test("an explicit `language` still wins over the default", () => {
    const shape = z.object({ language: languageField("python"), code: z.string() });
    const parsed = shape.safeParse({ code: "echo hi", language: "shell" });
    expect((parsed.data as any).language).toBe("shell");
  });

  test("the default never overrides the enum: an invalid explicit value is rejected", () => {
    const shape = z.object({ language: languageField("python"), code: z.string() });
    expect(shape.safeParse({ code: "x", language: "klingon" }).success).toBe(false);
  });
});
