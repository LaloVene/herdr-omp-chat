// omp-chat-bridge: publishes this omp session to the Herdr app's omp-chat mod and takes its requests.
// Part of herdr-omp-chat (~/Documents/herdr-omp-chat). Installed as a symlink by its install.sh.
//
// Channel: <appHome>/data/omp-chat/<HC_TERMINAL_ID>/
//   state.json      session file, cwd, model, busy, leaf after /tree or a rewind, omp's version and a tip (rewritten on lifecycle events)
//   pending.json    open approval / ask cards
//   commands.json   slash commands this session knows besides omp's built-ins
//   btw/<id>.json   side-question topics (omp's BtwHistoryRecord shape + sessionId)
//   requests/*.json from the mod: {type:"prompt",text,followUp?} | {type:"abort"} | {type:"btw",question,followUpOf?} | {type:"btw_cancel",id}
// Also registers /omp-chat-rewind <entry id> and /omp-chat-resume <session file>, which the chat
// types for its double Esc and its /resume picker (only command handlers may move or switch sessions).
// Runs inside every omp session: no network, fail silent, every write atomic.
// @ts-nocheck

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VERSION } from "@oh-my-pi/pi-utils";

const TERMINAL = process.env.HC_TERMINAL_ID;
// OMP marks every shell it spawns with OMPCODE=1: a nested omp is not the terminal's own agent.
const NESTED = process.env.OMPCODE === "1";
const APP_HOME = process.env.HERDR_APP_HOME || path.join(os.homedir(), ".config", "herdr-app");
const ROOT = TERMINAL && /^[A-Za-z0-9_-]+$/.test(TERMINAL) ? path.join(APP_HOME, "data", "omp-chat", TERMINAL) : "";
const MAX_FIELD = 32_000;
const BTW_WRITE_MS = 100;
// The answer being written, for the chat to show as it streams. Outside ROOT, so its many writes
// don't wake everything that watches the bridge folder (headers, btw panels).
const STREAM_FILE = ROOT ? path.join(APP_HOME, "data", "omp-chat-stream", `${TERMINAL}.json`) : "";
const STREAM_WRITE_MS = 120;
const REWIND_COMMAND = "omp-chat-rewind";
const RESUME_COMMAND = "omp-chat-resume";

// omp's own /btw wrapper (prompts/system/btw-user.md), so side answers read like /btw's.
const btwPrompt = (question: string) =>
  `<btw>\nEphemeral side question for current interactive session.\nAnswer briefly, directly; use conversation context already provided.\nNEVER use tools.\nNEVER ask follow-up questions.\nQuestion:\n${question}\n</btw>`;

let tmpSeq = 0;
function writeJson(file: string, value: unknown): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp-${process.pid}-${++tmpSeq}`;
    fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {}
}

function capped(value: unknown): unknown {
  try {
    const text = JSON.stringify(value ?? null);
    if (text.length <= MAX_FIELD) return value;
    return { truncated: true, text: text.slice(0, MAX_FIELD) };
  } catch {
    return null;
  }
}

function isMain(ctx): boolean {
  const kind = ctx?.agent?.kind;
  return ctx?.hasUI === true && (kind === undefined || kind === "main");
}

const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export default function (pi) {
  if (!ROOT || NESTED) return;

  let ctxRef;
  let active = false;
  let busy = false;
  let watcher: fs.FSWatcher | undefined;
  let scanTimer;
  const calls = new Map<string, { input: unknown; intent?: string }>();
  const pending = new Map<string, Record<string, unknown>>();
  const topics = new Map();
  let btwRun: { id: string; abort: AbortController } | undefined;
  // Set when the leaf moves without an append (/tree, a rewind): { id, after: last entry id then }.
  // The chat's reader uses it only while the session's last entry is still `after`.
  let treeLeaf: { id: string | null; after: string | null } | undefined;

  const sessionId = () => {
    try { return ctxRef?.sessionManager?.getSessionId?.() ?? null; } catch { return null; }
  };

  let lastState = "";
  // omp's version and a tip for the chat's empty state (loadWelcome).
  let welcome: { version: string; tip: string | null } | null = null;

  /** Writes state.json; with `ifChanged`, only when something differs from the last write. */
  function writeState(ifChanged = false): void {
    if (!active) return;
    let sessionFile = null;
    try { sessionFile = ctxRef?.sessionManager?.getSessionFile?.() ?? null; } catch {}
    const model = ctxRef?.model;
    let context = null;
    try {
      const usage = ctxRef?.getContextUsage?.();
      if (usage) context = { tokens: usage.tokens ?? null, window: usage.contextWindow ?? null, percent: usage.percent ?? null };
    } catch {}
    let thinking = null;
    try { thinking = pi.getThinkingLevel?.() ?? null; } catch {}
    const state = {
      terminal: TERMINAL,
      sessionFile,
      sessionId: sessionId(),
      cwd: ctxRef?.cwd ?? process.cwd(),
      model: model ? { id: model.id, provider: model.provider, name: model.name ?? model.id } : null,
      thinking,
      context,
      busy,
      btwRunning: btwRun?.id ?? null,
      leaf: treeLeaf ?? null,
      welcome,
    };
    const key = JSON.stringify(state);
    if (ifChanged && key === lastState) return;
    lastState = key;
    writeJson(path.join(ROOT, "state.json"), state);
  }

  function writePending(): void {
    if (active) writeJson(path.join(ROOT, "pending.json"), [...pending.values()]);
  }

  /** Fills `welcome` (the version and a tip, for the chat's empty state) from omp's own welcome banner. */
  async function loadWelcome(): Promise<void> {
    let tip = null;
    try {
      // Dynamic: an internal subpath another omp version may move; a static import failing would
      // stop the whole extension (see writeCommands).
      const { WelcomeComponent } = await import("@oh-my-pi/pi-tui/prompt/welcome");
      // Each banner rolls its own tip; skip the terminal-only nag about nerd fonts.
      for (let i = 0; i < 5 && (!tip || /nerdfont/i.test(tip)); i++) tip = new WelcomeComponent(VERSION).tip ?? null;
      if (tip) {
        tip = tip.replace(/^\[NO-TERN\]\s*/, "").replace(/\s*\[NEW\]\s*$/, "")
          .replace(/\{(?:key|tap):([^}]+)\}/g, "`$1`").replace(/\{keys:([^}]+)\}/g, (_m, keys) => keys.split(",").map((k) => `\`${k}\``).join("/"))
          .replace(/\{action:[^}]*?([^.}]+)\}/g, "the $1 key");
      }
    } catch {}
    welcome = { version: String(VERSION), tip };
    writeState();
  }

  async function writeCommands(): Promise<void> {
    let builtins = [];
    try {
      // omp's own registry, so the list matches the running version. Dynamic: an internal subpath
      // another omp version may move; a static import failing would stop the whole extension.
      const registry = await import("@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry");
      builtins = registry.BUILTIN_SLASH_COMMAND_DEFS.map((c) => ({ name: c.name, description: c.description ?? "", source: "builtin", args: c.allowArgs === true }));
    } catch {}
    try {
      const others = (pi.getCommands?.() ?? []).filter((c) => c.name !== REWIND_COMMAND && c.name !== RESUME_COMMAND)
        .map((c) => ({ name: c.name, description: c.description ?? "", source: c.source, args: true }));
      if (active) writeJson(path.join(ROOT, "commands.json"), [...builtins, ...others]);
    } catch {}
  }

  // --- side questions ---------------------------------------------------------------------

  function saveTopic(record): void {
    topics.set(record.id, record);
    if (active) writeJson(path.join(ROOT, "btw", `${record.id}.json`), record);
  }

  function btwHistory(previous, model) {
    const history = [];
    for (const turn of previous) {
      history.push({ role: "user", content: [{ type: "text", text: btwPrompt(turn.question) }], attribution: "agent", timestamp: turn.createdAt });
      if (!turn.answer) continue;
      history.push({
        role: "assistant",
        content: [{ type: "text", text: turn.answer }],
        api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: turn.updatedAt,
      });
    }
    return history;
  }

  async function askBtw(question: string, followUpOf?: string): Promise<void> {
    const now = Date.now();
    const turn = { question, answer: "", status: "running", createdAt: now, updatedAt: now };
    const previous = followUpOf ? topics.get(followUpOf) : undefined;
    let leafId = null;
    try { leafId = ctxRef?.sessionManager?.getLeafId?.() ?? null; } catch {}
    let record = previous
      ? { ...previous, followUps: [...(previous.followUps ?? []), turn] }
      : { ...turn, id: newId(), leafId, sessionId: sessionId() };
    const fail = (status: string, error: string) => {
      record = patchLatest(record, { status, error, updatedAt: Date.now() });
      saveTopic(record);
    };
    if (followUpOf && !previous) {
      // Answered in the topic the user is looking at; only ids newId() makes may name a file.
      if (/^[a-z0-9]+$/.test(followUpOf)) writeJson(path.join(ROOT, "btw", `${followUpOf}.json`), { ...record, id: followUpOf, status: "error", error: "That topic is gone." });
      return;
    }
    if (btwRun) return fail("error", "Another side question is still running.");
    const model = ctxRef?.model;
    if (!ctxRef?.runEphemeralTurn || !model) return fail("error", !model ? "No active model." : "This omp has no side turns.");

    const priorTurns = previous ? [previous, ...(previous.followUps ?? [])] : [];
    // A cancelled/failed turn may still be unwinding: start a fresh provider lineage after it.
    const epoch = priorTurns.findLastIndex((t) => t.status !== "complete") + 1;
    const abort = new AbortController();
    btwRun = { id: record.id, abort };
    saveTopic(record);
    writeState();

    let answer = "";
    let lastWrite = 0;
    let flushTimer;
    const flush = () => {
      flushTimer = undefined;
      lastWrite = Date.now();
      record = patchLatest(record, { answer, updatedAt: lastWrite });
      saveTopic(record);
    };
    try {
      const result = await ctxRef.runEphemeralTurn({
        promptText: btwPrompt(question),
        history: btwHistory(priorTurns, model),
        conversationKey: `omp-chat-btw:${record.id}:${epoch}`,
        replyMaxBytes: Number.POSITIVE_INFINITY,
        signal: abort.signal,
        onTextDelta: (delta: string) => {
          answer += delta;
          if (flushTimer) return;
          const wait = Math.max(0, BTW_WRITE_MS - (Date.now() - lastWrite));
          flushTimer = setTimeout(() => { try { flush(); } catch {} }, wait);
          flushTimer.unref?.();
        },
      });
      clearTimeout(flushTimer);
      record = patchLatest(record, { answer: result?.replyText ?? answer, status: "complete", updatedAt: Date.now() });
      saveTopic(record);
    } catch (error) {
      clearTimeout(flushTimer);
      record = patchLatest(record, { answer });
      fail(abort.signal.aborted ? "cancelled" : "error", abort.signal.aborted ? "Cancelled." : String(error?.message ?? error));
    } finally {
      if (btwRun?.abort === abort) btwRun = undefined;
      writeState();
    }
  }

  function patchLatest(record, patch) {
    const followUps = record.followUps;
    if (followUps?.length) return { ...record, followUps: [...followUps.slice(0, -1), { ...followUps[followUps.length - 1], ...patch }] };
    return { ...record, ...patch };
  }

  function cancelBtw(id?: string): void {
    if (btwRun && (!id || btwRun.id === id)) btwRun.abort.abort();
  }

  // --- requests from the mod ------------------------------------------------------------

  function handle(request): void {
    if (!request || typeof request !== "object") return;
    if (request.type === "prompt" && typeof request.text === "string" && request.text.trim()) {
      // Ctrl+Enter, as in omp: queued behind the running turn, or a plain prompt when idle.
      if (request.followUp === true && ctxRef?.isIdle?.() === false) pi.sendUserMessage(request.text, { deliverAs: "followUp" });
      else pi.sendUserMessage(request.text);
    } else if (request.type === "abort") {
      ctxRef?.abort?.();
    } else if (request.type === "btw" && typeof request.question === "string" && request.question.trim()) {
      void askBtw(request.question.trim(), typeof request.followUpOf === "string" ? request.followUpOf : undefined).catch(() => {});
    } else if (request.type === "btw_cancel") {
      cancelBtw(typeof request.id === "string" ? request.id : undefined);
    }
  }

  function scan(): void {
    if (!active) return;
    const dir = path.join(ROOT, "requests");
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names.sort()) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(dir, name);
      let request;
      try {
        request = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        // Possibly still being written: retry on the next scan, drop it once it is old.
        try { if (Date.now() - fs.statSync(file).mtimeMs > 5000) fs.unlinkSync(file); } catch {}
        continue;
      }
      try { fs.unlinkSync(file); } catch { continue; } // claimed by someone else
      try { handle(request); } catch {}
    }
  }

  function startWatching(ctx): void {
    stopWatching();
    const dir = path.join(ROOT, "requests");
    try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch {}
    try {
      watcher = fs.watch(dir, () => { try { scan(); } catch {} });
      watcher.on("error", () => {});
    } catch {}
    // fs.watch can miss events; a slow scan backs it up. The same tick catches model, effort and
    // context changes no event reports (/model, Shift+Tab, a compaction), and a busy flag left on
    // by an agent end that said it would continue and then didn't.
    try {
      scanTimer = ctx.setInterval(() => {
        scan();
        if (busy && ctxRef?.isIdle?.() === true) busy = false;
        writeState(true);
      }, 2000);
    } catch {}
    scan();
  }

  function stopWatching(): void {
    try { watcher?.close(); } catch {}
    watcher = undefined;
    try { if (scanTimer) ctxRef?.clearTimer?.(scanTimer); } catch {}
    scanTimer = undefined;
  }

  // --- lifecycle --------------------------------------------------------------------------

  function activate(ctx, fresh: boolean): boolean {
    if (!isMain(ctx)) return false;
    ctxRef = ctx;
    if (!active || fresh) {
      if (!active) {
        // This terminal's folder: whatever an earlier omp here left is stale.
        try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
        try { fs.rmSync(STREAM_FILE, { force: true }); } catch {}
        try { fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 }); } catch {}
      }
      active = true;
      busy = ctx?.isIdle?.() === false;
      writeState();
      writePending();
      void writeCommands();
      if (!welcome) void loadWelcome();
      startWatching(ctx);
    }
    return true;
  }

  pi.on("session_start", (_event, ctx) => { activate(ctx, true); });

  function moveLeaf(ctx): void {
    try {
      const manager = ctx.sessionManager;
      treeLeaf = { id: manager.getLeafId() ?? null, after: manager.getEntries().at(-1)?.id ?? null };
    } catch {
      treeLeaf = undefined;
    }
    writeState();
  }

  pi.on("session_tree", (_event, ctx) => {
    if (isMain(ctx) && active) moveLeaf(ctx);
  });

  // /compact and auto-compaction shrink the context: report it now, not on the next 2s tick.
  pi.on("session_compact", (_event, ctx) => {
    if (isMain(ctx) && active) writeState();
  });

  // The chat's double Esc: rewind past a user message, as omp's rewind selector does. Typed into
  // the terminal by the mod because only command handlers may move the session's leaf.
  pi.registerCommand(REWIND_COMMAND, {
    description: "Rewind past a user message (used by the Herdr omp chat)",
    handler: async (args, ctx) => {
      const id = String(args ?? "").trim();
      const entry = id ? ctx.sessionManager.getEntry(id) : undefined;
      if (entry?.type !== "message" || entry.message?.role !== "user") return;
      // Its session_tree event moves the reported leaf.
      const { cancelled } = await ctx.navigateTree(id, { summarize: false });
      if (cancelled) return;
      // The chat puts the message back in its own reply box; keep omp's editor empty for later sends.
      try { ctx.ui.setEditorText(""); } catch {}
    },
  });

  // The chat's /resume picker: switch this omp to another session file, as /resume does.
  pi.registerCommand(RESUME_COMMAND, {
    description: "Resume a session file (used by the Herdr omp chat)",
    handler: async (args, ctx) => {
      const file = String(args ?? "").trim();
      if (!file.endsWith(".jsonl") || !fs.existsSync(file)) return;
      await ctx.switchSession(file);
      try { ctx.ui.setEditorText(""); } catch {}
    },
  });

  pi.on("session_switch", (_event, ctx) => {
    if (!isMain(ctx)) return;
    cancelBtw();
    pending.clear();
    calls.clear();
    treeLeaf = undefined;
    activate(ctx, true);
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!activate(ctx, false)) return;
    busy = true;
    writeState();
  });

  pi.on("turn_start", (_event, ctx) => {
    if (!isMain(ctx) || !active) return;
    ctxRef = ctx;
    writeState(); // the model may have changed; the session file now exists
  });

  // --- streaming --------------------------------------------------------------------------

  let streamId = "";
  let streamBlocks: string[] = [];
  let streamTimer;
  let lastStreamWrite = 0;

  function writeStream(done = false): void {
    clearTimeout(streamTimer);
    streamTimer = undefined;
    lastStreamWrite = Date.now();
    if (active) writeJson(STREAM_FILE, { id: streamId, blocks: streamBlocks, done });
  }

  pi.on("message_update", (event, ctx) => {
    if (!isMain(ctx) || !active || event?.message?.role !== "assistant") return;
    const content = Array.isArray(event.message.content) ? event.message.content : [];
    const blocks = content.filter((c) => c?.type === "text" && typeof c.text === "string" && c.text).map((c) => c.text);
    if (!blocks.length) return;
    streamId ||= newId();
    streamBlocks = blocks;
    if (streamTimer) return;
    streamTimer = setTimeout(() => { try { writeStream(); } catch {} }, Math.max(0, STREAM_WRITE_MS - (Date.now() - lastStreamWrite)));
    streamTimer.unref?.();
  });

  // Marked done: the chat shows it a few seconds more, until the transcript holds it.
  pi.on("message_end", (event, ctx) => {
    if (!isMain(ctx) || !active || event?.message?.role !== "assistant" || !streamId) return;
    writeStream(true);
    streamId = "";
    streamBlocks = [];
  });

  pi.on("agent_end", (event, ctx) => {
    if (!isMain(ctx) || !active) return;
    if (event?.willContinue === true) return;
    busy = false;
    if (pending.size) { pending.clear(); writePending(); }
    calls.clear();
    writeState();
  });

  pi.on("tool_call", (event, ctx) => {
    if (!isMain(ctx) || !active || !event?.toolCallId) return;
    calls.set(event.toolCallId, { input: event.input });
  });

  pi.on("tool_execution_start", (event, ctx) => {
    if (!isMain(ctx) || !active || !event?.toolCallId) return;
    const known = calls.get(event.toolCallId);
    calls.set(event.toolCallId, { input: known?.input ?? event.args, intent: event.intent });
    if (event.toolName === "ask") {
      const questions = Array.isArray(event.args?.questions) ? event.args.questions : [];
      pending.set(event.toolCallId, {
        toolCallId: event.toolCallId, kind: "ask", toolName: "ask", intent: event.intent ?? null,
        questions: capped(questions), since: Date.now(),
      });
      writePending();
    }
  });

  pi.on("tool_approval_requested", (event, ctx) => {
    if (!isMain(ctx) || !active || !event?.toolCallId) return;
    const known = calls.get(event.toolCallId);
    pending.set(event.toolCallId, {
      toolCallId: event.toolCallId, kind: "approval", toolName: event.toolName,
      input: capped(known?.input ?? null), intent: known?.intent ?? null, reason: event.reason ?? null,
      since: Date.now(),
    });
    writePending();
  });

  pi.on("tool_approval_resolved", (event, ctx) => {
    if (!isMain(ctx) || !active) return;
    if (pending.delete(event?.toolCallId)) writePending();
  });

  pi.on("tool_execution_end", (event, ctx) => {
    if (!isMain(ctx) || !active) return;
    calls.delete(event?.toolCallId);
    if (pending.delete(event?.toolCallId)) writePending();
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (!isMain(ctx) || !active) return;
    active = false;
    cancelBtw();
    clearTimeout(streamTimer);
    stopWatching();
    try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(STREAM_FILE, { force: true }); } catch {}
  });
}
