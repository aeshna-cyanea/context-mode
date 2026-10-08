/**
 * Auto-injection for compaction events.
 *
 * Builds a prioritized, budget-capped injection block from session events.
 * Only fires on source === "compact" (wired in sessionstart.mjs).
 *
 * Priority order:
 *   P1: Role (behavioral_directive) — always first, never truncated
 *   P2: Decisions (rules) — latest 5, overflow reduces to 3
 *   P3: Skills (active_skills) — unique names, latest 10
 *   P4: Session mode — explicit host override (see resolveSessionMode), else
 *       the latest derived intent
 *
 * Hard cap: 500 tokens (~2000 chars at 4 chars/token).
 */

/**
 * Rough token estimate: ~4 chars per token.
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

/**
 * Modes an explicit override may name, and the ceiling on what a host-supplied
 * override can inject into the model's context. Deliberately permissive about
 * the word (hosts own their own mode vocabulary) but strict about shape: no
 * whitespace, no angle brackets, bounded length.
 */
const MODE_PATTERN = /^[a-z][a-z0-9_-]{0,15}$/;

/**
 * Explicit override wins over the punctuation-derived classification; without
 * one the derived intent behaves exactly as before.
 */
function resolveMode(intent, modeOverride) {
  if (typeof modeOverride === "string" && MODE_PATTERN.test(modeOverride)) {
    return { mode: modeOverride, source: "explicit" };
  }
  if (intent && typeof intent.data === "string") {
    const derived = intent.data.trim();
    if (derived) return { mode: derived, source: "derived" };
  }
  return { mode: null, source: "none" };
}

/**
 * Resolve the session mode a host should inject, without building the block.
 *
 * Hosts that surface the mode somewhere other than the injection (a status bar,
 * a prompt line) need the same resolution the block uses, not a second
 * implementation of it. Pass the same events array you would pass to
 * buildAutoInjection, plus the host's explicit override if it has one.
 *
 * @param {Array<{category: string, data: string}>} events
 * @param {string} [modeOverride]
 * @returns {{mode: string|null, source: "explicit"|"derived"|"none"}}
 */
export function resolveSessionMode(events, modeOverride) {
  let intent;
  if (Array.isArray(events)) {
    for (const e of events) {
      if (e && e.category === "intent") intent = e;
    }
  }
  return resolveMode(intent, modeOverride);
}

/**
 * Build auto-injection block from session events.
 * @param {Array<{category: string, data: string}>} events
 * @param {{modeOverride?: string}} [opts] modeOverride — an explicit, host-owned
 *   mode choice (e.g. Pi's `/mode` command). Wins over the derived intent for
 *   this block only; the next call without an override is derived again.
 * @returns {string} XML block or empty string
 */
export function buildAutoInjection(events, opts) {
  const modeOverride = opts?.modeOverride;
  // Single O(N) pass instead of 4× O(N) Array.filter() loops. UserPromptSubmit
  // fires this on every prompt; with N up to 100 events the prior implementation
  // walked the array 4 times per prompt — wasteful on macOS, painful on Windows
  // where V8 cold paths cost more.
  let role;
  const decisionsAll = [];
  const skillsSeen = new Set();
  const skillsOrdered = [];
  let intent;
  for (const e of events) {
    switch (e.category) {
      case "role":
        role = e;
        break;
      case "decision":
        decisionsAll.push(e);
        break;
      case "skill":
        if (!skillsSeen.has(e.data)) {
          skillsSeen.add(e.data);
          skillsOrdered.push(e.data);
        }
        break;
      case "intent":
        intent = e;
        break;
    }
  }

  const parts = [];
  let budget = 500; // hard cap in tokens

  // P1: Role (always first, never truncated from output)
  if (role) {
    const text = `<behavioral_directive>\n${role.data.slice(0, 400)}\n</behavioral_directive>`;
    parts.push(text);
    budget -= estimateTokens(text);
  }

  // P2: Decisions (latest 5)
  const decisions = decisionsAll.slice(-5);
  if (decisions.length > 0) {
    const lines = decisions.map(d => `- ${d.data.slice(0, 100)}`).join("\n");
    const text = `<rules>\nFollow these decisions:\n${lines}\n</rules>`;
    const cost = estimateTokens(text);
    if (cost <= budget) {
      parts.push(text);
      budget -= cost;
    } else {
      // Overflow: reduce to 3 decisions
      const reduced = decisions.slice(-3).map(d => `- ${d.data.slice(0, 100)}`).join("\n");
      const fallback = `<rules>\nFollow these decisions:\n${reduced}\n</rules>`;
      parts.push(fallback);
      budget -= estimateTokens(fallback);
    }
  }

  // P3: Skills (unique names, latest 10)
  if (skillsOrdered.length > 0 && budget > 50) {
    const text = `<active_skills>\nRe-invoke if relevant: ${skillsOrdered.slice(-10).join(", ")}\nTo reload: call the Skill tool with the skill name.\n</active_skills>`;
    parts.push(text);
    budget -= estimateTokens(text);
  }

  // P4: Session mode — explicit override if the host supplied one, else the
  // latest derived intent. An explicit mode is labelled so the model can tell a
  // user's choice from a punctuation guess.
  const sessionMode = resolveMode(intent, modeOverride);
  if (sessionMode.mode && budget > 20) {
    parts.push(
      sessionMode.source === "explicit"
        ? `<session_mode source="explicit">${sessionMode.mode}</session_mode>`
        : `<session_mode>${sessionMode.mode}</session_mode>`,
    );
  }

  if (parts.length === 0) return "";
  return `<session_state source="compaction">\n\n${parts.join("\n\n")}\n\n</session_state>`;
}
