#!/usr/bin/env bun
// Reads an omp session JSONL and prints the shown branch as chat items (JSON on stdout).
// Usage: bun transcript.ts <session.jsonl> [--limit N] [--leaf ID|none --after ID]
//                          [--palette JSON --app-home DIR]
//        bun transcript.ts --sessions <session dir>      (the sessions /resume would offer)
// Items are numbered over the whole branch; the output holds the last `limit` (all without
// --limit). Record rules follow Ovis's createOmpTranscriptParser (MIT, see NOTICE.md),
// plus following parentId from the leaf so a /tree branch shows only that branch.
// Prints only what the chat renders: tool input/output are cut, images become placeholders.
// With --palette, answers holding mermaid, svg or chartable tables also get `parts` (render.ts);
// one whose drawing fails stays plain markdown.

import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { answerParts, hasParts, type Part } from "./render.ts";

type Row = Record<string, unknown>;
type Item =
  | { k: "user"; id: string; text: string; steer?: boolean }
  | { k: "text"; id: string; text: string; parts?: Part[] }
  | { k: "tool"; id: string; name: string; summary: string; input: string; output: string; error: boolean; done: boolean }
  | { k: "notice"; id: string; text: string }
  | { k: "compact"; id: string; text: string }
  | { k: "error"; id: string; text: string };

const TOOL_TEXT_MAX = 6000;
const record = (value: unknown): Row => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});
const label = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
const cut = (text: string, max = TOOL_TEXT_MAX) => (text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text);

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const block = record(part);
      if (block.type === "text" && typeof block.text === "string") return block.text;
      if (block.type === "image") return "[image]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/** The one-line summary of a tool call: its intent, else the field that says what it does. */
function toolSummary(name: string, input: Row): string {
  if (name === "task") {
    const items = Array.isArray(input.tasks) ? input.tasks.map(record) : [input];
    const titles = items.map((item) => label(item.task_summary) ?? label(item.description)).filter(Boolean);
    if (titles.length) return titles.join(" · ");
  }
  const first = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.query ?? input.description;
  return typeof first === "string" ? first : name;
}

/**
 * The entries on the shown branch, oldest first: parentId followed back from the leaf. The leaf is
 * omp's (session-entries.ts resolveSessionLeafId: the last entry's `activeLeafId`, else the newest
 * entry that selects itself), unless `moved` says where /tree or a rewind put it since: that holds
 * while the file's last entry is still `moved.after` (`moved.id` null: before the first entry).
 */
function branch(lines: string[], moved: { id: string | null; after: string } | null): Row[] {
  const byId = new Map<string, Row>();
  const order: Row[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: Row;
    try {
      entry = record(JSON.parse(line));
    } catch {
      continue; // a torn last line while omp is mid-append
    }
    if (typeof entry.id !== "string") continue;
    byId.set(entry.id, entry);
    order.push(entry);
  }
  const selects = (e: Row) => (e.activeLeafId !== undefined ? e.activeLeafId : e.id);
  let leafId: unknown = null;
  const last = order.at(-1);
  if (moved && last?.id === moved.after) leafId = moved.id;
  else if (last) {
    leafId = selects(last);
    if (leafId !== null && !byId.has(leafId as string)) leafId = order.findLast((e) => selects(e) === e.id)?.id ?? null;
  }
  const path: Row[] = [];
  const seen = new Set<string>();
  for (let at = typeof leafId === "string" ? byId.get(leafId) : undefined; at && !seen.has(at.id as string); at = typeof at.parentId === "string" ? byId.get(at.parentId) : undefined) {
    seen.add(at.id as string);
    path.push(at);
  }
  return path.reverse();
}

function items(entries: Row[]): Item[] {
  const out: Item[] = [];
  const tools = new Map<string, Extract<Item, { k: "tool" }>>();
  for (const entry of entries) {
    const id = entry.id as string;
    if (entry.type === "compaction") {
      const summary = label(entry.summary);
      if (summary) out.push({ k: "compact", id, text: summary });
      continue;
    }
    if (entry.type === "custom_message") {
      if (entry.display === false || typeof entry.content !== "string") continue;
      const text = entry.content.trim().replace(/^<system-notice>\s*/, "").replace(/\s*<\/system-notice>$/, "").trim();
      if (text) out.push({ k: "notice", id, text });
      continue;
    }
    if (entry.type !== "message") continue;
    const message = record(entry.message);
    if (message.display === false) continue;
    if (message.role === "user") {
      const text = blockText(message.content);
      if (text.trim()) out.push({ k: "user", id, text, ...(message.steering === true ? { steer: true } : {}) });
      continue;
    }
    if (message.role === "toolResult") {
      const tool = typeof message.toolCallId === "string" ? tools.get(message.toolCallId) : undefined;
      if (tool) {
        tool.output = cut(blockText(message.content));
        tool.error = message.isError === true;
        tool.done = true;
      }
      continue;
    }
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    message.content.forEach((value, index) => {
      const block = record(value);
      const key = `${id}:${index}`;
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        out.push({ k: "text", id: key, text: block.text });
      } else if (block.type === "toolCall" && typeof block.name === "string") {
        const input = record(block.arguments);
        const tool: Extract<Item, { k: "tool" }> = {
          k: "tool",
          id: key,
          name: block.name,
          summary: (label(block.intent) ?? toolSummary(block.name, input)).split("\n")[0]!.slice(0, 160),
          input: cut(typeof input.command === "string" && Object.keys(input).every((k) => k === "command" || k === "i") ? input.command : JSON.stringify(input, null, 2)),
          output: "",
          error: false,
          done: false,
        };
        out.push(tool);
        if (typeof block.id === "string") tools.set(block.id, tool);
      }
    });
    if (message.stopReason === "error" && typeof message.errorMessage === "string" && message.errorMessage) {
      out.push({ k: "error", id: `${id}:error`, text: message.errorMessage });
    }
  }
  return out;
}

/** The session files in `dir`, newest first, each with omp's title (else its first message). */
function sessions(dir: string) {
  const out: { path: string; title: string; mtime: number }[] = [];
  let names: string[] = [];
  try { names = readdirSync(dir).filter((n) => n.endsWith(".jsonl")); } catch {}
  for (const name of names) {
    const path = join(dir, name);
    try {
      const stat = statSync(path);
      if (!stat.isFile()) continue;
      const buffer = Buffer.alloc(Math.min(stat.size, 65536));
      const fd = openSync(path, "r");
      try { readSync(fd, buffer, 0, buffer.length, 0); } finally { closeSync(fd); }
      let title = "";
      for (const line of buffer.toString("utf8").split("\n")) {
        let entry: Row;
        try { entry = record(JSON.parse(line)); } catch { continue; }
        if (entry.type === "title" && label(entry.title)) { title = label(entry.title)!; break; }
        const message = record(entry.message);
        if (entry.type === "message" && message.role === "user") { title = blockText(message.content).replace(/\s+/g, " ").trim().slice(0, 120); break; }
      }
      out.push({ path, title: title || "(empty)", mtime: stat.mtimeMs });
    } catch {}
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, 200);
}

const args = process.argv.slice(2);
const option = (name: string) => {
  const at = args.indexOf(name);
  const value = at >= 0 ? Number(args[at + 1]) : NaN;
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
};
const argument = (name: string) => {
  const at = args.indexOf(name);
  return at >= 0 && at + 1 < args.length ? args[at + 1]! : null;
};

/**
 * Model, reasoning effort and context use as of the branch's last answer, for omps whose bridge
 * predates live status: the answer's own usage (or, when a compaction came after it, the
 * compaction's `tokensAfter`), its effort, and the model's window from omp's model cache
 * (~/.omp/agent/models.db).
 */
function status(entries: Row[]) {
  let compacted: number | null = null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.type === "compaction" && compacted === null && typeof entry.tokensAfter === "number") compacted = entry.tokensAfter;
    const message = record(entry.message);
    if (entry.type !== "message" || message.role !== "assistant" || !record(message.usage).totalTokens) continue;
    const effort = record(record(message.requestControls).effort).topLevel;
    return {
      model: typeof message.model === "string" ? message.model : null,
      effort: typeof effort === "string" ? effort : null,
      tokens: compacted ?? Number(record(message.usage).totalTokens),
      window: contextWindow(message.provider, message.model),
    };
  }
  return null;
}

function contextWindow(provider: unknown, model: unknown): number | null {
  if (typeof provider !== "string" || typeof model !== "string") return null;
  // A second account of a provider ("anthropic-2") serves the base provider's models.
  const base = provider.replace(/-\d+$/, "");
  try {
    const db = new Database(join(homedir(), ".omp/agent/models.db"), { readonly: true });
    try {
      const rows = db.query("select models from model_cache where provider_id in (?, ?) or provider_id like ? or provider_id like ? order by provider_id = ? desc")
        .all(provider, base, `${provider}:%`, `${base}:%`, provider) as { models: string }[];
      for (const row of rows) {
        const found = (JSON.parse(row.models) as Row[]).find((m) => m.id === model);
        if (typeof found?.contextWindow === "number") return found.contextWindow;
      }
    } finally {
      db.close();
    }
  } catch {}
  return null;
}

if (args[0] === "--sessions") {
  process.stdout.write(JSON.stringify(sessions(args[1] ?? "")));
} else {
  const file = args[0];
  const limit = option("--limit");
  // --leaf <id> | --leaf none, with --after <last entry id>: where /tree or a rewind moved the leaf.
  const after = argument("--after");
  const leaf = argument("--leaf");
  const moved = after && leaf ? { id: leaf === "none" ? null : leaf, after } : null;
  let text = "";
  try {
    text = file ? readFileSync(file, "utf8") : "";
  } catch {
    // not written yet: omp creates the file with the first message
  }
  const entries = branch(text.split("\n"), moved);
  const all = items(entries);
  const start = limit === null ? 0 : Math.max(0, all.length - limit);
  const page = all.slice(start);
  const palette = argument("--palette");
  const appHome = argument("--app-home");
  if (palette && appHome) {
    const colors = JSON.parse(palette) as Record<string, string>;
    for (const item of page) {
      if (item.k !== "text" || !hasParts(item.text)) continue;
      try {
        const parts = await answerParts(item.text, colors, appHome);
        if (parts) item.parts = parts;
      } catch {}
    }
  }
  process.stdout.write(JSON.stringify({ total: all.length, start, items: page, status: status(entries) }));
}
