/**
 * Issue #542 (CLI half) — cli.ts upgrade() MUST honor a `--platform <id>`
 * flag and skip detectPlatform() when present (the bundle drift root
 * cause — bundled Lf() called detectPlatform() without clientInfo).
 *
 * Fork note (2026-10-05): the server.ts ctx_upgrade handler tests were
 * removed along with the handler — ctx_upgrade is a NO-OP in the
 * aeshna-cyanea/context-mode fork (see "ctx_upgrade fork policy (no-op)"
 * in tests/core/server.test.ts).
 *
 * Source-text inspection mirrors tests/util/cli-upgrade-verification.test.ts.
 */

import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");

const cliSrc = readFileSync(resolve(ROOT, "src", "cli.ts"), "utf-8");

describe("cli.ts upgrade() honors --platform flag (issue #542)", () => {
  test("argv parse extracts --platform <id> before invoking upgrade()", () => {
    // The entry-point switch (cli.ts:141) must forward the flag — either
    // as a function argument or by setting CONTEXT_MODE_PLATFORM env var
    // before detectPlatform() runs.
    expect(cliSrc).toMatch(/--platform/);
  });

  test("upgrade() prefers explicit --platform over detectPlatform()", () => {
    // When --platform is supplied, detectPlatform()'s heuristic chain
    // must NOT override it. We assert the source threads the flag into
    // either getAdapter() directly or CONTEXT_MODE_PLATFORM (which
    // detectPlatform() already honors as the explicit-override tier).
    const upgradeIdx = cliSrc.indexOf("async function upgrade");
    const upgradeBody = cliSrc.slice(upgradeIdx, upgradeIdx + 14000);
    expect(upgradeBody).toMatch(/--platform|platformOverride|opts\.platform/);
  });

  test("upgrade() passes CONTEXT_MODE_PLATFORM into the nested doctor check", () => {
    // The final verification step must not rediscover Claude Code via ~/.claude
    // after upgrade() has already resolved OpenCode. Thread the chosen platform
    // into the spawned doctor process so the child stays on the same path.
    const upgradeIdx = cliSrc.indexOf("async function upgrade");
    const upgradeBody = cliSrc.slice(upgradeIdx);
    expect(upgradeBody).toContain('execFileSync("node", [cliPath, "doctor"], {');
    expect(upgradeBody).toContain('CONTEXT_MODE_PLATFORM: detection.platform');
  });
});
