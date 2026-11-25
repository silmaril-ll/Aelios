// Write-only MCP (Pixel's fork): Aelios is a backup we put things into, never read from.
// Connected assistants only see — and can only call — the write tools below. Everything already
// stored stays readable on the /admin page. Switch: MCP_WRITE_ONLY (on by default; false/off to
// get the upstream read + write tool set back).
import type { Env } from "../types";

export function isMcpWriteOnly(env: Env): boolean {
  const raw = (env.MCP_WRITE_ONLY ?? "").trim().toLowerCase();
  return !["off", "false", "0", "no"].includes(raw);
}

// Names after RENAMED_TOOLS mapping (keep_moment → memory_pin, learn_word → glossary_set).
const CALLABLE = new Set(["remember", "memory_pin", "glossary_set", "log_conversation"]);
const LISTED = new Set(["remember", "keep_moment", "learn_word", "log_conversation"]);

export function isWriteOnlyCallable(name: string): boolean {
  return CALLABLE.has(name);
}

export const WRITE_ONLY_REFUSAL =
  "This Aelios is write-only: assistants can save to it but not read from it. The owner reads it on the /admin page.";

export const WRITE_ONLY_GUIDE = [
  "Aelios here is a write-only backup of things worth keeping about the person you are talking with. You can put things in; you cannot read anything back, so never rely on it and never mention its contents.",
  "- When a durable fact, plan, preference or correction comes up: remember. Moments that matter: keep_moment. Nicknames and in-jokes: learn_word.",
  "- log_conversation only when the person asks you to log the conversation. Never log on your own.",
  "- To change or remove something already stored, tell the person to do it on their Aelios admin page."
].join("\n");

// Descriptions rewritten so nothing points the assistant at a read tool.
const DESCRIPTIONS: Record<string, string> = {
  remember:
    "Save something worth keeping as one self-contained sentence that will still make sense months from now: facts " +
    "about the person and the people around them, likes and dislikes, plans and dates, promises, how they want to be " +
    "treated, corrections. Write-only: you will not get stored memories back. Skip small talk. " +
    "Returns { data: { id, created, replaced } }.",
  keep_moment:
    "Keep a moment that matters, in the person's own words: a first time, a promise, a confession, something they said " +
    "that should never be lost. Kept moments are never merged, faded or deleted automatically. Use remember for " +
    "ordinary facts. Each call creates a new entry. Returns { data: moment }.",
  learn_word:
    "Learn a private word: a nickname, pet name, in-joke, made-up word or project name that only makes sense between " +
    "you two. Calling it again with the same term updates its meaning; aliases and examples are replaced by what you " +
    "pass (leaving them out clears them). Returns { data: word }.",
  log_conversation:
    "Only when the person asks you to log this conversation: hand it to tonight's memory pass. Send the person's and " +
    "your messages in order, trimmed of code and pasted documents; pass back the conversation_id from your first call " +
    "if you log again in the same conversation. Returns { data: { conversation_id, saved, skipped, message_ids } }."
};

export function writeOnlyTools(tools: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return tools
    .filter((tool) => LISTED.has(String(tool.name)))
    .map((tool) => {
      const description = DESCRIPTIONS[String(tool.name)];
      const out: Record<string, unknown> = description ? { ...tool, description } : { ...tool };
      // remember's `replaces` needs an id from recall, which is gone.
      if (tool.name === "remember" && isRecordLike(tool.inputSchema)) {
        const schema = tool.inputSchema as { properties?: Record<string, unknown> };
        if (schema.properties) {
          const { replaces: _r, reason: _why, ...rest } = schema.properties;
          out.inputSchema = { ...schema, properties: rest };
        }
      }
      return out;
    });
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
