import { strict as assert } from "node:assert";
import { test, beforeEach } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import worker from "../src/index";
import { invalidateSettingsCache } from "../src/gateway/config";

// Write-only mode (default): only the four write tools are listed and callable.
// MCP tool list as the Claude app sees it: ten everyday tools named after the moment they are for,
// usage guidance both in initialize and in wake_up (the Claude app ignores instructions), old names still callable.
(crypto.subtle as any).timingSafeEqual = (a: Uint8Array, b: Uint8Array) => timingSafeEqual(a, b);
let sqlite: DatabaseSync;
let env: any;

const CORE = ["wake_up", "recall", "remember", "keep_moment", "forget", "learn_word", "read_diary", "log_conversation", "list_memories", "notebook"];

beforeEach(() => {
  sqlite?.close(); sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync("migrations").filter((f: string) => f.endsWith(".sql")).sort()) {
    try { sqlite.exec(readFileSync(`migrations/${file}`, "utf8")); }
    catch (error) {
      if (!String(error).includes("fts5")) throw error;
    }
  }
  const db = { prepare(sql: string) {
    const statement = sqlite.prepare(sql); let args: any[] = [];
    const api = { bind(...values: any[]) { args = values; return api; },
      async first() { return statement.get(...args) || null; },
      async all() { return { results: statement.all(...args) }; },
      async run() { const r = statement.run(...args); return { meta: { changes: r.changes } }; }
    }; return api;
  }, async batch(statements: any[]) {
    const results = []; for (const statement of statements) results.push(await statement.run()); return results;
  } };
  invalidateSettingsCache();
  env = { DB: db, CHATBOX_API_KEY: "owner-key",
    AI: { async run() { return { data: [[0.1, 0.2, 0.3]] }; } },
    VECTORIZE: { async upsert() { return {}; }, async deleteByIds() { return {}; }, async query() { return { matches: [] }; } } };
  globalThis.fetch = async (url: any) => { throw new Error(`unexpected upstream call: ${url}`); };
});

function memory(id: string, content: string, extra: { pinned?: number; importance?: number; factKey?: string } = {}) {
  const at = "2026-09-01T00:00:00.000Z";
  sqlite.prepare(`INSERT INTO memories (id, namespace, type, content, importance, confidence, status, pinned, tags, source,
    source_message_ids, vector_id, created_at, updated_at, fact_key, version_status)
    VALUES (?, 'default', 'fact', ?, ?, 0.8, 'active', ?, '[]', 'dream', '[]', ?, ?, ?, ?, 'current')`)
    .run(id, content, extra.importance ?? 0.6, extra.pinned ?? 0, `mem_${id}`, at, at, extra.factKey ?? null);
  sqlite.prepare("INSERT INTO memory_lifecycle (memory_id, namespace, fact_key, seen_count) VALUES (?, 'default', ?, 0)")
    .run(id, extra.factKey ?? null);
}
const row = (table: string, id: string) => sqlite.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as any;

async function rpc(method: string, params: any = {}, query = "") {
  const response = await worker.fetch(new Request(`https://aelios.test/mcp${query}`, { method: "POST",
    headers: { authorization: "Bearer owner-key", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }), env, { waitUntil() {} } as any);
  return (await response.json() as any).result;
}
const call = async (name: string, args: any = {}) => rpc("tools/call", { name, arguments: args });
const listNames = async (query = "") => (await rpc("tools/list", {}, query)).tools.map((tool: any) => tool.name);


test("write-only by default: only the write tools are listed, with no pointers to read tools", async () => {
  assert.deepEqual(await listNames(), ["remember", "keep_moment", "learn_word", "log_conversation"]);
  assert.deepEqual(await listNames("?tools=all"), ["remember", "keep_moment", "learn_word", "log_conversation"]);
  const tools = (await rpc("tools/list")).tools;
  for (const tool of tools) assert.doesNotMatch(tool.description, /recall|wake_up|read_diary|list_memories/);
  const remember = tools.find((t: any) => t.name === "remember");
  assert.equal(remember.inputSchema.properties.replaces, undefined);
  const init = await rpc("initialize");
  assert.match(init.instructions, /write-only/);
  assert.doesNotMatch(init.instructions, /wake_up|recall/);
});

test("write-only: read tools and their old names are refused, writes still land", async () => {
  memory("m1", "a stored fact");
  for (const name of ["wake_up", "recall", "read_diary", "list_memories", "notebook", "forget", "memory_get",
    "memory_export", "memory_recall", "memory_boot", "memory_list", "memory_search", "memory_candidates"]) {
    const result = await call(name, { query: "fact", id: "m1", action: "list" });
    assert.equal(result.isError, true, name);
    assert.match(result.content[0].text, /write-only/, name);
  }
  assert.equal(row("memories", "m1").status, "active");
  const saved = await call("remember", { content: "Pixel likes the confluence." });
  assert.notEqual(saved.isError, true);
  assert.equal((await call("learn_word", { term: "小乱毛", definition: "Pixel" })).structuredContent.data.term, "小乱毛");
  assert.notEqual((await call("keep_moment", { content: "两颗星挨在一起" })).isError, true);
});

test("MCP_WRITE_ONLY=off brings the full tool set back", async () => {
  env.MCP_WRITE_ONLY = "off";
  assert.ok((await listNames()).includes("recall"));
});
