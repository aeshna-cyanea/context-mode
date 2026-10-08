import "../setup-home";
/**
 * Pi active_memory window tests.
 *
 * The Pi adapter rebuilds the active_memory block on EVERY turn from
 * `db.getEvents(_sessionId, { minPriority: 3, limit: 50 })`. That query is
 * `ORDER BY id ASC LIMIT 50` — the OLDEST 50 high-priority events, not the
 * newest. Past 50 such events the injected block stops moving: every later
 * decision, skill, and intent lands outside the window, and the model keeps
 * being told a classification the session abandoned days ago.
 *
 * Fix: `db.getRecentEvents()` takes the newest-N (DESC + LIMIT, reversed back
 * to chronological order). These tests pin the injected block to the newest
 * signals.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionDB, resolveSessionDbPath } from "../../src/session/db.js";

type HandlerFn = (...args: any[]) => any;

function createMockPiApi() {
  const handlers: Record<string, HandlerFn[]> = {};
  const commands: Record<string, any> = {};
  const statuses = new Map<string, string | undefined>();

  return {
    on: (event: string, handler: HandlerFn) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
    },
    registerCommand: (name: string, opts: any) => {
      commands[name] = opts;
    },
    registerTool: () => {},
    sendMessage: () => {},
    exec: async () => ({ output: "", code: 0 }),
    getFlag: () => undefined,
    appendEntry: () => {},
    events: { emit: () => {}, on: () => () => {} },

    // ── Test helpers ──
    _trigger: async (event: string, ...args: any[]) => {
      for (const h of handlers[event] ?? []) {
        const result = await h(...args);
        if (result) return result;
      }
    },
    _getCommand: (name: string) => commands[name],
    _status: statuses,
    _ui: {
      notify: () => {},
      setStatus: (key: string, text: string | undefined) => {
        statuses.set(key, text);
      },
    },
  };
}

let tempDir: string;
let api: ReturnType<typeof createMockPiApi>;

async function registerPiExtension(
  mockApi: ReturnType<typeof createMockPiApi>,
  opts?: { projectDir?: string },
) {
  const projectDir = opts?.projectDir ?? tempDir;
  process.env.PI_PROJECT_DIR = projectDir;
  process.env.CLAUDE_PROJECT_DIR = projectDir;

  const mod = await import("../../src/adapters/pi/extension.js");
  await mod.default(mockApi);
  return mockApi;
}

/** Open the same DB file the extension just wrote to (mirrors #645 resolver). */
function openExtensionDB(projectDir: string): SessionDB {
  const sessionsDir = join(process.env.HOME!, ".pi", "context-mode", "sessions");
  return new SessionDB({
    dbPath: resolveSessionDbPath({ projectDir, sessionsDir }),
  });
}

/** Pi derives the context-mode session id from the session file path. */
function expectedSessionId(sessionFile: string): string {
  return createHash("sha256").update(sessionFile).digest("hex").slice(0, 16);
}

/** Start a session and return its context-mode session id. */
async function startSession(sessionFile: string): Promise<string> {
  await api._trigger(
    "session_start",
    { type: "session_start", reason: "startup" },
    { sessionManager: { getSessionFile: () => sessionFile }, hasUI: true, ui: api._ui },
  );
  return expectedSessionId(sessionFile);
}

/** Run one turn and return the text the context hook appended to the transcript. */
async function injectedContextFor(prompt: string): Promise<string> {
  await api._trigger("before_agent_start", {
    systemPrompt: "You are a helpful assistant.",
    prompt,
  });
  const messages: any[] = [{ role: "system", content: "You are a helpful assistant." }];
  await api._trigger("context", { messages });
  expect(messages.length).toBe(2);
  return String(messages[1].content);
}

describe("Pi active_memory window — newest-N, not oldest-N", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pi-window-test-"));
    mkdirSync(tempDir, { recursive: true });
    api = createMockPiApi();
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* cleanup best effort */
    }
    delete process.env.PI_PROJECT_DIR;
    delete process.env.CLAUDE_PROJECT_DIR;
  });

  // A prompt long enough to skip intent classification entirely (>60
  // codepoints, no question mark): the injected mode can only come from the
  // stored window, never from the current prompt.
  const NEUTRAL_PROMPT =
    "Carry on with the part of the work we already began, and do not change anything about how it is organized.";

  it("injects the NEWEST intent, not the session's first one", async () => {
    await registerPiExtension(api);
    const sessionId = await startSession(join(tempDir, "session-window-1.jsonl"));

    const db = openExtensionDB(tempDir);
    try {
      for (let i = 0; i < 60; i++) {
        const mode = i >= 55 ? "implement" : "investigate";
        db.insertEvent(
          sessionId,
          // type varies so insertEvent's dedup (type + data_hash over the last
          // 5 events) does not collapse 60 identical intents into one row.
          { type: `intent-${i}`, category: "intent", data: mode, priority: 4 },
          "UserPromptSubmit",
        );
      }
    } finally {
      db.close();
    }

    const injected = await injectedContextFor(NEUTRAL_PROMPT);
    expect(injected).toContain("<session_mode>implement</session_mode>");
    expect(injected).not.toContain("<session_mode>investigate</session_mode>");
  });

  it("keeps <rules> on the latest decisions instead of the first five", async () => {
    await registerPiExtension(api);
    const sessionId = await startSession(join(tempDir, "session-window-2.jsonl"));

    const db = openExtensionDB(tempDir);
    try {
      for (let i = 0; i < 60; i++) {
        db.insertEvent(
          sessionId,
          { type: `decision-${i}`, category: "decision", data: `pick option ${i}`, priority: 3 },
          "UserPromptSubmit",
        );
      }
    } finally {
      db.close();
    }

    const injected = await injectedContextFor(NEUTRAL_PROMPT);
    const rules = injected.match(/<rules>([\s\S]*?)<\/rules>/)?.[1] ?? "";
    expect(rules).toContain("pick option 59");
    expect(rules).toContain("pick option 55");
    expect(rules).not.toContain("pick option 0");
  });

  it("short sessions are unaffected — the window still holds everything", async () => {
    await registerPiExtension(api);
    const sessionId = await startSession(join(tempDir, "session-window-3.jsonl"));

    const db = openExtensionDB(tempDir);
    try {
      db.insertEvent(
        sessionId,
        { type: "intent", category: "intent", data: "investigate", priority: 4 },
        "UserPromptSubmit",
      );
    } finally {
      db.close();
    }

    const injected = await injectedContextFor(NEUTRAL_PROMPT);
    expect(injected).toContain("<session_mode>investigate</session_mode>");
  });
});
