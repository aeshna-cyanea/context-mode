import "../setup-home";
/**
 * CONTEXT_MODE_PI_SESSION_STATE — the opt-out for context-mode's unsolicited
 * per-turn context on Pi.
 *
 * Every Pi turn used to receive a fixed routing anchor line plus a
 * `<session_state>` block of derived rules, skills, and a punctuation-classified
 * session mode. That is steering, not compression, and a host is entitled to the
 * compression alone. Unset keeps upstream behavior byte-identical.
 *
 * The opt-out is deliberately narrow: the resume snapshot and the footer status
 * line survive it.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { piSessionStateDisabled } from "../../src/adapters/pi/extension.js";

type HandlerFn = (...args: any[]) => any;

function createMockPiApi() {
  const handlers: Record<string, HandlerFn[]> = {};
  const statuses = new Map<string, string | undefined>();

  return {
    on: (event: string, handler: HandlerFn) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
    },
    registerCommand: () => {},
    registerTool: () => {},
    sendMessage: () => {},
    sendUserMessage: () => {},
    exec: async () => ({ output: "", code: 0 }),
    getFlag: () => undefined,
    appendEntry: () => {},
    events: { emit: () => {}, on: () => () => {} },
    _trigger: async (event: string, ...args: any[]) => {
      for (const h of handlers[event] ?? []) {
        const result = await h(...args);
        if (result) return result;
      }
    },
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

async function registerPiExtension(mockApi: ReturnType<typeof createMockPiApi>) {
  process.env.PI_PROJECT_DIR = tempDir;
  process.env.CLAUDE_PROJECT_DIR = tempDir;
  const mod = await import("../../src/adapters/pi/extension.js");
  await mod.default(mockApi);
  return mockApi;
}

async function startSession(sessionFile: string) {
  await api._trigger(
    "session_start",
    { type: "session_start", reason: "startup" },
    { sessionManager: { getSessionFile: () => sessionFile }, hasUI: true, ui: api._ui },
  );
}

/** Run one turn; return the appended transcript text, or "" when nothing was appended. */
async function runTurn(prompt: string): Promise<string> {
  await api._trigger(
    "before_agent_start",
    { systemPrompt: "You are a helpful assistant.", prompt },
    { hasUI: true, ui: api._ui },
  );
  const messages: any[] = [{ role: "system", content: "You are a helpful assistant." }];
  await api._trigger("context", { messages });
  return messages.length > 1 ? String(messages[1].content) : "";
}

describe("piSessionStateDisabled — value parsing", () => {
  it("unset, empty, or unrecognized keeps upstream behavior", () => {
    expect(piSessionStateDisabled({})).toBe(false);
    expect(piSessionStateDisabled({ CONTEXT_MODE_PI_SESSION_STATE: "" })).toBe(false);
    expect(piSessionStateDisabled({ CONTEXT_MODE_PI_SESSION_STATE: "on" })).toBe(false);
    expect(piSessionStateDisabled({ CONTEXT_MODE_PI_SESSION_STATE: "klingon" })).toBe(false);
    expect(piSessionStateDisabled({ CONTEXT_MODE_PI_SESSION_STATE: "off-ish" })).toBe(false);
  });

  it("off / 0 / false / no disable it, trimmed and case-insensitive", () => {
    for (const value of ["off", "OFF", " off ", "0", "false", "FALSE", "no", "No"]) {
      expect(piSessionStateDisabled({ CONTEXT_MODE_PI_SESSION_STATE: value })).toBe(true);
    }
  });
});

describe("CONTEXT_MODE_PI_SESSION_STATE — behavior", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pi-session-state-off-"));
    mkdirSync(tempDir, { recursive: true });
    api = createMockPiApi();
  });

  afterEach(() => {
    delete process.env.CONTEXT_MODE_PI_SESSION_STATE;
    delete process.env.PI_PROJECT_DIR;
    delete process.env.CLAUDE_PROJECT_DIR;
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* cleanup best effort */
    }
  });

  it("unset: the anchor and the session_state block are injected (control)", async () => {
    await registerPiExtension(api);
    await startSession(join(tempDir, "state-on.jsonl"));

    const injected = await runTurn("why does the integration test fail on a cold cache?");
    expect(injected).toContain("Hierarchy: ctx_batch_execute");
    expect(injected).toContain("<session_state");
    expect(injected).toContain("<session_mode>investigate</session_mode>");
  });

  it("off: nothing is appended to the transcript at all", async () => {
    process.env.CONTEXT_MODE_PI_SESSION_STATE = "off";
    await registerPiExtension(api);
    await startSession(join(tempDir, "state-off.jsonl"));

    const injected = await runTurn("why does the integration test fail on a cold cache?");
    expect(injected).toBe("");
  });

  it("off: no anchor, no session_state, even with high-priority events recorded", async () => {
    process.env.CONTEXT_MODE_PI_SESSION_STATE = "off";
    await registerPiExtension(api);
    await startSession(join(tempDir, "state-off-events.jsonl"));

    // A question prompt records an intent event; the next turn would normally
    // inject it. With the opt-out the transcript stays untouched.
    await runTurn("what is the eviction order here?");
    const injected = await runTurn("and the dedup window?");
    expect(injected).not.toContain("Hierarchy: ctx_batch_execute");
    expect(injected).not.toContain("<session_state");
    expect(injected).not.toContain("<session_mode>");
  });

  it("off is narrow: the resume snapshot is still delivered", async () => {
    process.env.CONTEXT_MODE_PI_SESSION_STATE = "off";
    await registerPiExtension(api);
    await startSession(join(tempDir, "state-off-resume.jsonl"));

    await api._trigger("tool_result", {
      tool_name: "read",
      tool_input: { file_path: "/src/main.ts" },
      tool_result: "import express from 'express';",
    });
    await api._trigger("tool_result", {
      tool_name: "bash",
      tool_input: { command: "git commit -m 'feat: add express'" },
      tool_result: "[main abc1234] feat: add express",
    });
    await api._trigger("session_before_compact", {});
    await api._trigger("session_compact", {});

    const injected = await runTurn("continue");
    expect(injected).toContain("session_resume");
    expect(injected).not.toContain("Hierarchy: ctx_batch_execute");
  });

  it("off does not silence the footer status line", async () => {
    process.env.CONTEXT_MODE_PI_SESSION_STATE = "off";
    await registerPiExtension(api);
    await startSession(join(tempDir, "state-off-status.jsonl"));

    await runTurn("why does the integration test fail on a cold cache?");
    expect(api._status.get("ctx-mode")).toBe("mode: investigate");
  });
});
