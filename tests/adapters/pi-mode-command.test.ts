import "../setup-home";
/**
 * Pi `/mode` command tests.
 *
 * `<session_mode>` is injected every turn and was derived only from prompt
 * punctuation: a `?` anywhere means "investigate", otherwise a short prompt
 * means "implement", and a prompt over 60 codepoints with no `?` records
 * nothing at all — the label just stays where it was. `/mode` gives autumn an
 * explicit switch.
 *
 * Contract under test: the switch is ONE-TIME. It outranks the derived value
 * for exactly the next turn, then is discarded and classification resumes.
 * Derived intent events keep being recorded either way, so an explicit choice
 * never erases the session's real signal.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

type HandlerFn = (...args: any[]) => any;

function createMockPiApi() {
  const handlers: Record<string, HandlerFn[]> = {};
  const commands: Record<string, any> = {};
  const statuses = new Map<string, string | undefined>();
  const notices: string[] = [];

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
    sendUserMessage: vi.fn(),
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
    _runCommand: async (name: string, args = "") => {
      const cmd = commands[name];
      if (!cmd) throw new Error(`command /${name} is not registered`);
      return cmd.handler(args, { hasUI: true, ui: { notify: (t: string) => notices.push(t), setStatus: (k: string, v: string | undefined) => statuses.set(k, v) } });
    },
    _status: statuses,
    _notices: notices,
    _ui: {
      notify: (t: string) => notices.push(t),
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

async function startSession(sessionFile: string): Promise<string> {
  await api._trigger(
    "session_start",
    { type: "session_start", reason: "startup" },
    { sessionManager: { getSessionFile: () => sessionFile }, hasUI: true, ui: api._ui },
  );
  return createHash("sha256").update(sessionFile).digest("hex").slice(0, 16);
}

/** Run one turn; return the text the context hook appended to the transcript. */
async function runTurn(prompt: string): Promise<string> {
  await api._trigger(
    "before_agent_start",
    { systemPrompt: "You are a helpful assistant.", prompt },
    { hasUI: true, ui: api._ui },
  );
  const messages: any[] = [{ role: "system", content: "You are a helpful assistant." }];
  await api._trigger("context", { messages });
  expect(messages.length).toBe(2);
  return String(messages[1].content);
}

const QUESTION_PROMPT = "why does the integration test fail on a cold cache?";
const LONG_FLAT_PROMPT =
  "Carry on with the part of the work we already began, and do not change anything about how it is organized.";

describe("Pi /mode — one-time session mode switch", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pi-mode-test-"));
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

  it("outranks a question-mark prompt for one turn, then classification resumes", async () => {
    await registerPiExtension(api);
    await startSession(join(tempDir, "mode-onshot.jsonl"));

    await api._runCommand("mode", "implement");

    // Turn 1: the prompt is a question, but the explicit switch wins.
    const first = await runTurn(QUESTION_PROMPT);
    expect(first).toContain('<session_mode source="explicit">implement</session_mode>');
    expect(first).not.toContain("<session_mode>investigate</session_mode>");

    // Turn 2: the switch is gone. The question mark now decides, which also
    // proves the derived intent event from turn 1 was still recorded.
    const second = await runTurn(QUESTION_PROMPT);
    expect(second).toContain("<session_mode>investigate</session_mode>");
    expect(second).not.toContain('source="explicit"');
  });

  it("surfaces the effective mode in the footer status line", async () => {
    await registerPiExtension(api);
    await startSession(join(tempDir, "mode-status.jsonl"));

    await api._runCommand("mode", "implement");
    expect(api._status.get("ctx-mode")).toBe("mode: implement (explicit)");

    await runTurn(QUESTION_PROMPT);
    expect(api._status.get("ctx-mode")).toBe("mode: implement (explicit)");

    await runTurn(QUESTION_PROMPT);
    expect(api._status.get("ctx-mode")).toBe("mode: investigate");
  });

  it("works on a session that has recorded no high-priority events yet", async () => {
    await registerPiExtension(api);
    await startSession(join(tempDir, "mode-empty.jsonl"));

    await api._runCommand("mode", "investigate");
    const injected = await runTurn(LONG_FLAT_PROMPT);
    expect(injected).toContain('<session_mode source="explicit">investigate</session_mode>');
  });

  it("/mode auto releases the override", async () => {
    await registerPiExtension(api);
    await startSession(join(tempDir, "mode-auto.jsonl"));

    await api._runCommand("mode", "implement");
    await api._runCommand("mode", "auto");

    const injected = await runTurn(QUESTION_PROMPT);
    expect(injected).toContain("<session_mode>investigate</session_mode>");
    expect(injected).not.toContain('source="explicit"');
  });

  it("bare /mode reports the current mode and the usage", async () => {
    await registerPiExtension(api);
    await startSession(join(tempDir, "mode-report.jsonl"));

    await runTurn(QUESTION_PROMPT);
    await api._runCommand("mode", "");
    const report = api._notices[api._notices.length - 1];
    expect(report).toContain("mode: investigate");
    expect(report).toContain("/mode investigate | implement | auto");
  });

  it("an unknown argument changes nothing", async () => {
    await registerPiExtension(api);
    await startSession(join(tempDir, "mode-unknown.jsonl"));

    await api._runCommand("mode", "implement");
    await api._runCommand("mode", "banana");
    expect(api._notices[api._notices.length - 1]).toContain('unknown argument "banana"');

    const injected = await runTurn(QUESTION_PROMPT);
    expect(injected).toContain('<session_mode source="explicit">implement</session_mode>');
  });

  it("text after the mode is kept as an instruction", async () => {
    await registerPiExtension(api);
    await startSession(join(tempDir, "mode-trailing.jsonl"));

    await api._runCommand("mode", "implement now fix the auth bug");
    expect(api.sendUserMessage).toHaveBeenCalledWith("now fix the auth bug");

    const injected = await runTurn("why does the integration test fail on a cold cache?");
    expect(injected).toContain('<session_mode source="explicit">implement</session_mode>');
  });

  it("offers the three modes as argument completions", async () => {
    await registerPiExtension(api);
    const complete = api._getCommand("mode").getArgumentCompletions;

    expect(complete("").map((i: any) => i.label)).toEqual(["investigate", "implement", "auto"]);
    expect(complete("inv").map((i: any) => i.label)).toEqual(["investigate"]);
    expect(complete("zzz")).toBe(null);
  });

  it("a pending switch belongs to the session that made it", async () => {
    await registerPiExtension(api);
    await startSession(join(tempDir, "mode-shutdown.jsonl"));

    await api._runCommand("mode", "implement");
    await api._trigger("session_shutdown", {}, { hasUI: true, ui: api._ui });
    expect(api._status.get("ctx-mode")).toBe(undefined);

    // A new session after shutdown must not inherit the old switch.
    await startSession(join(tempDir, "mode-shutdown-2.jsonl"));
    const injected = await runTurn(QUESTION_PROMPT);
    expect(injected).toContain("<session_mode>investigate</session_mode>");
    expect(injected).not.toContain('source="explicit"');
  });
});
