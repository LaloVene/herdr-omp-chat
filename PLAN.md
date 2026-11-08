# omp-chat: an omp chat view for the Herdr app

Status: built 2026-11-07 (see RECIPE.md for what exists). Written 2026-11-07 after a feasibility
check (below). The person chose **btw via the extension (option B)**. Deviations from this plan:
the feed is always read by the Bun helper (20% of sessions exceed 1 MiB); side turns use omp's own
`/btw` parameters (no `tools: false` / `maxTokens`, which some transports reject); chat is per
pane (a mod pane in the terminal pane's place, the terminal parked) instead of a layout stack, so it
splits like any pane; btw is a sidebar block, not a window.

## Goal

A Herdr app layout + mod that shows each omp (oh-my-pi) agent as an easy-to-read chat, in the
spirit of Ovis (https://github.com/devswha/ovis, MIT), with:

1. A readable conversation: user bubbles, markdown replies, folded tool calls, thinking folded.
2. One key / button to switch between the chat and the agent's real terminal, per tab.
3. omp slash commands from the chat box, with autocomplete.
4. Approval cards better than Ovis's (Ovis scrapes the screen; we use omp's own events).
5. A btw side window: side questions about the current session, answered while the agent works,
   streaming, without touching the terminal.

Non-goals: other agents (Claude Code, Codex…), other machines (`on:` remote), phone/web, Windows.
Flockbook (github.com/minchenlee/flockbook) was tried and rejected: its omp support is too thin.

## Before writing code: read these

- `~/.config/herdr-app/AGENTS.md`: the whole mod/layout contract. Key sections: "Layouts",
  "Floating blocks", "Layouts and mods other people made" (install rules), mod rules near the end.
- `~/.config/herdr-app/herdr.d.ts` (414 lines): `exec`, `hc`, `readTextFile` (≤1 MiB),
  `writeTextFile` (only under the app home), `watchFolder`, `terminals()`, `agents()`, `focused()`,
  `openOverlay` (`kind: "window"`, `key`, `keep`), `shared`/`setShared`, `nextCommand`, `run`.
- `~/.config/herdr-app/gpui-kit.d.ts`: `TextView.markdown`, `v_virtual_list`, `Input`, `Editor`.
- omp docs, readable with omp's `read` tool: `omp://extensions.md` (events, `pi.sendUserMessage`,
  `ctx.runEphemeralTurn` at "Ephemeral side turns"), `omp://slash-command-internals.md` §11 (`/btw`),
  `omp://keybindings.md`, `omp://rpc.md` "Side questions" (record shape to mirror).
- `~/.omp/agent/extensions/herdr-omp-agent-state.ts`: an existing extension; a model for style.
  **Do not edit it** (written by Herdr's integration, `HERDR_INTEGRATION_VERSION=10`). Note it is
  inactive under herdr-core: it needs `HERDR_ENV`/`HERDR_PANE_ID`, which the app's terminals don't set.
- Ovis source for the port of logic (not UI): `server/transcript-records.ts`
  (`createOmpTranscriptParser`, ~550 lines), `server/skills/omp.ts` (slash-command list),
  `server/dialogs/omp.ts` (approval screen shapes + key sequences, fixtures in `server/fixtures/`),
  `server/omp-btw.ts`. Keep the MIT notice for anything ported.

## Facts established (2026-11-07, omp 18.18.0, herdr-app 0.1.13, hc 0.1.18)

Verified with a throwaway extension in an omp run under herdr-core (`--approval-mode always-ask`):

- **Pane ↔ session mapping:** every terminal herdr-core starts has `HC_TERMINAL_ID` (e.g. `t1f`) in
  its env; in an extension `ctx.sessionManager.getSessionFile()` gives the absolute session JSONL
  path at `session_start`. `hc get <t>` also gives `foreground.pid` (omp's pid) as a fallback.
  Without the extension, mapping by cwd is ambiguous (three omp panes share lex-backend).
- **Session files:** `~/.omp/agent/sessions/<cwd-slug>/<ISO-ts>_<uuid>.jsonl`, one record per line
  (`id`, `parentId`, `timestamp`). Types: `session` (v3, cwd), `title`, `model_change`,
  `thinking_level_change`, `message` (`role`: `user` | `assistant` | `toolResult` | `fileMention`;
  assistant `content[]`: `text`, `thinking`, `toolCall {id,name,arguments,intent}`), `custom`
  (`tool_execution_start`, …), `custom_message` (`async-result`), `compaction`. Tree-shaped: follow
  `parentId` from the leaf for the shown branch. Images as `blob:sha256:` refs into
  `~/.omp/agent/blobs`. Files can exceed 1 MiB. **Transcripts contain pasted secrets**: never copy
  records anywhere beyond what is rendered.
- **Approval events** (one `echo probe-ok` call, same `toolCallId` throughout):
  `tool_call {toolName, toolCallId, input:{command}}` → `tool_execution_start {args, intent}` →
  `tool_approval_requested {sessionId, toolName, toolCallId, approvalMode}` (no args/reason: join by
  id) → `tool_approval_resolved {toolCallId, approved}` → `tool_execution_end {result}`.
  Extensions **cannot** answer tool approvals (they can answer plan reviews via
  `ctx.resolvePlanReview`). The TUI prompt is a box `Allow tool: bash` / `Command: …` with rows
  `Approve`, `Approve bash for this session`, `Deny`; `↑/↓`, Enter selects, typing denies and steers.
  `hc keys <t> enter` approved it; `resolved` fired.
- **`ask` questions** are structured: `tool_execution_start` with `toolName: "ask"`,
  `args.questions[] {id, question, options, multi}`; answers in the `toolResult`
  `details.results[]`. Answering is still keys on the TUI picker (Ovis `server/dialogs/omp.ts`).
- **`hc send` from inside an hc terminal wraps the text** as `<hc from="t1d">…</hc>`, which breaks
  slash commands (it became a normal prompt). Without `HC_TERMINAL_ID`/`HC_SCOPE` in the env, a
  `/btw …` sent with `hc send` worked. A mod's `exec`/`hc()` env is **unverified**: check first.
- **`/btw` (omp's own)** works while the agent is busy; its record goes to
  `<session dir without .jsonl>/btw-history/entry-<id>.json` as
  `{question, answer, status: running|complete, createdAt, updatedAt, id, leafId}`, and never into
  the transcript. It leaves a popup on the terminal until Esc. **We don't use this path** (see btw).
- Your omp config: `tools.approvalMode: yolo` plus `bash.patterns` with `approval: prompt` for a
  few (`az keyvault *`), so cards appear mainly for those and for `ask`.

## Design

Two parts, one repo (this folder), installed by a script into the Herdr app home.

```
omp process (in a Herdr terminal)            Herdr app
┌──────────────────────────────┐   files    ┌──────────────────────────────┐
│ extension: omp-chat-bridge.ts │──────────▶│ mod: omp-chat (chat, cards,   │
│  writes state + feed          │◀──────────│      btw window) + layout     │
│  reads requests (btw, send)   │  requests │ hc keys / hc send to terminal │
└──────────────────────────────┘            └──────────────────────────────┘
```

### Channel (extension ↔ mod)

Folder per terminal: `<appHome>/data/omp-chat/<HC_TERMINAL_ID>/` (inside the app home so the mod
can `writeTextFile` there and `watchFolder` it). Files, each written atomically (tmp + rename):

- `state.json`: `{v, pid, terminal, sessionFile, sessionId, cwd, model, busy, updatedAt}`.
  Rewritten on `session_start`, `session_switch`, `agent_start`, `agent_end`, `model_change`.
- `pending.json`: open approval/ask cards: `[{toolCallId, kind: "approval"|"ask", toolName,
  input, intent, questions?, since}]`. Add on `tool_approval_requested` (join `tool_call` +
  `tool_execution_start` kept in a small map by id) and `ask` `tool_execution_start`; remove on
  `tool_approval_resolved` / `ask` `tool_execution_end`.
- `btw/<id>.json`: btw records, same shape as omp's (`question, answer, status, createdAt,
  updatedAt, id, parentId?`); `answer` grows while streaming (throttle writes to ~10/s).
- `requests/<uuid>.json` (mod → extension): `{type: "btw", question, followUpOf?}`,
  `{type: "btw_cancel", id}`, `{type: "prompt", text}` (plain messages, see Send). The extension
  watches the folder (`fs.watch`), handles, then deletes each request.

Activate only when `HC_TERMINAL_ID` is set and `ctx.agent.kind === "main"` (skip subagents) and
`OMPCODE` nesting is not set (see the existing extension's `nestedOmpSession`). Clean the folder on
`session_shutdown`. The mod treats a folder whose `pid` is dead as stale.

### Chat feed

Option to decide in step 1 (measure first): either
- (a) the mod reads the JSONL itself: `readTextFile` when < 1 MiB, else a tiny Bun helper
  (`bun` is installed) that prints the tail / a page by byte offset; or
- (b) the extension writes a normalized feed (`feed-<n>.jsonl` chunks) from the session it has in
  memory, so the mod never parses omp's format.

Recommendation: (a) with the helper, porting Ovis's `createOmpTranscriptParser` (skip torn last
line, follow `parentId` from the leaf, handle compaction). Keeps the chat working for sessions
started before the extension existed. Refresh on `watchFolder` of the session dir.

### Send

- Plain message: `requests/` `{type: "prompt"}` → extension `pi.sendUserMessage(text)` (steers while
  busy, starts a turn when idle; no `<hc from>` wrapper, no typing race).
- Slash command (text starting with `/`): `pi.sendUserMessage` does not expand slash commands, so
  use `hc send <t> "<text>"` with `HC_TERMINAL_ID`/`HC_SCOPE` absent (verify step 1; if the mod's
  env has them, run `env -u HC_TERMINAL_ID -u HC_SCOPE hc send …` via `exec`).
- Autocomplete list: omp built-ins (port `server/skills/omp.ts` `BUILTINS`, re-check against
  `omp://slash-command-internals.md` for 18.18) + `~/.omp/agent/config.yml`, skills, commands,
  extensions. Commands that open TUI dialogs (`/model`, `/settings`, bare `/btw`, `/tree`…) switch
  the view to the terminal after sending.

### Approval and ask cards

Rendered above the reply box from `pending.json`. Approval card: tool name, the full command /
arguments (monospace, scrollable), the `intent` line, cwd; buttons **Approve**, **Approve <tool>
for this session**, **Deny**, plus a text field "Deny and tell it…". Ask card: the questions with
options, multi-select, own answer.

Answering = keys, guarded: before sending, `hc read <t> --lines 40` and confirm the screen shows the
expected prompt for this tool (`Allow tool: <toolName>` and the command text); otherwise send
nothing and show "It changed on screen" + a Terminal button. Key sequences: Approve = `enter`;
Approve for session = `down enter`; Deny = `down down enter`; deny+steer = type the text (check the
exact behaviour on the screen first). Ask: port Ovis's sequences, check against 18.18 screens.
A card closes on `tool_approval_resolved`, also when answered in the terminal. Notify (`notify`) and
`playSound("blocked")` when a card appears while the chat isn't shown.

### btw side window (option B, via the extension)

`openOverlay({mod: "omp-chat", props: {view: "btw", terminal}, kind: "window", key: "omp-chat-btw",
keep: true, width: 420, height: 0.7})`, opened by a button in the chat header and a key.
Contents: topics (newest first) from `btw/*.json`, the selected topic's turns, an input.
Asking writes a `btw` request; the extension runs

```ts
ctx.runEphemeralTurn({ promptText, tools: false, maxTokens: 4096, history, conversationKey,
  onTextDelta, signal })
```

keeping `history` per topic for follow-ups (`conversationKey` = topic id; rotate after cancel or
error), streaming deltas into `btw/<id>.json`. Store a `ctx` reference from `session_start` for use
in the request handler (docs: "Hooks may start a side turn, including from delayed callbacks").
One running side turn per session; cancel via `AbortController` on `btw_cancel`, on session switch
and on shutdown. Trade-off accepted: these topics are not in omp's own `/btw` history (optional
later: also write `btw-history/entry-*.json` in omp's shape; check omp tolerates foreign entries).
Cost note: each question sends the session context to the provider.

### Layout and the chat ⇄ terminal switch

New layout `layouts/omp-chat.json`, based on a clone of `main` (`herdr-app do layout.clone
'{"name":"main","as":"omp-chat"}'`, then edit). The tab area becomes a `stack` with two children:
the chat block (`content: {mod: "omp-chat", props: {view: "chat"}}`) and the tab block
(`content: {tab: "active"}`). Switch with `run("layout.select", {stack, child})`; remember the
choice per tab in `shared("omp-chat.view")`; key `cmd-j` (check it's free in `keys()`), plus a
header toggle. A tab whose focused pane is not omp shows the terminal automatically.

## Steps

Each step ends with `herdr-app check mods/omp-chat`, no `*.error` files, and a look with
`herdr-app shot`. Test in a throwaway omp started like this (stays out of the app's screens):
`hc run --bg --json --cwd /tmp/x -- omp --approval-mode always-ask`; remove it after (`hc kill`,
`hc rm`, and its session folder).

1. **Spikes (no UI):** (a) from a minimal mod, `hc(["send", t, "/btw ping"])` and `exec("env")`:
   does the mod's env carry `HC_TERMINAL_ID`? (b) largest file in `~/.omp/agent/sessions`
   (decides the helper); (c) `runEphemeralTurn` from a delayed request handler with the stored
   `ctx`, streaming into a file while the main turn runs; (d) the screen and keys for
   "Approve for session" and deny+steer.
2. **Extension:** channel folder, `state.json`, `pending.json`, requests (`prompt`, `btw`,
   `btw_cancel`), cleanup. Install by symlink into `~/.omp/agent/extensions/omp-chat-bridge.ts`.
3. **Mod, chat view:** parser + feed, rendering (markdown, code boxes, tool chips, thinking folded),
   follow-to-bottom, older pages on scroll up.
4. **Reply box + send + slash autocomplete.**
5. **Layout + chat ⇄ terminal switch.**
6. **Approval and ask cards.**
7. **btw window.**
8. **Install script + RECIPE.md** (AGENTS.md "To share one" format), `--dry-run`, never overwrite,
   uninstall removes the mod, layout, keys section, extension link and `data/omp-chat/`.

## Done when

- In the omp-chat layout, an omp tab opens as a chat at the newest message and follows new ones.
- One key switches chat ⇄ terminal for that tab; the terminal is the live one.
- `/` in the reply box lists omp commands; sending `/compact` runs it in omp (not as a prompt).
- With `--approval-mode always-ask`, a bash call shows a card with the full command and intent;
  each button gives the matching result in omp; answering in the terminal closes the card.
- An `ask` question shows as a card and its answer reaches omp.
- The btw window answers a question while the main agent is working, streaming, with no popup in
  the terminal, and a follow-up keeps the topic's context.
- Uninstall leaves `~/.config/herdr-app` and `~/.omp/agent/extensions` as before.

## Rules for whoever builds it

- Develop here (`~/Documents/herdr-omp-chat`); install into the app home with the script, never edit
  shipped Herdr mods/layouts (they are restored on every start; clone instead).
- The extension runs inside every omp session: no network, no heavy work on the hot path, fail
  silent (never break omp), all writes atomic.
- Don't add hooks to `~/.claude` or global config; the person removed Shepherdr partly for that.
- Ask before installing anything outside `~/.config/herdr-app` and `~/.omp/agent/extensions`.
