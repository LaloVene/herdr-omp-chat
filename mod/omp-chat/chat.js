// The chat: the omp session of the shown tab as a conversation, its open approval and ask cards,
// and a reply box that sends prompts (through the bridge) and slash commands (typed into omp).
import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex, TextView, InputState, Input, TextareaState, Textarea, Scrollbar, VirtualListScrollHandle, v_virtual_list } from "gpui-base";
import { exec, appHome, focused, panes, terminals, theme, settings, notify, playSound, home, watchFolder, nextCommand, props, run, shared, setShared, readTextFile } from "herdr";
import { ROOT, dirOf, readJson, watchRoot, chatPanes, setChatPanes, sendRequest, send } from "./channel.js";
import { answerApproval, answerAsk, ScreenChanged } from "./answer.js";
import { toTerminal } from "./view.js";

const HELPER = `${appHome()}/mods/omp-chat/transcript.ts`;
const PAGE = 150;
// How long the scrolling must have stopped before the next batch of earlier messages loads.
const OLDER_SETTLE_MS = 400;
// How long a measured row's height must hold before the row leaves the measurer.
const MEASURE_SETTLE_MS = 1500;
// Where the bridge writes the answer omp is streaming, one file per terminal.
const STREAM_DIR = `${appHome()}/data/omp-chat-stream`;
// A finished answer the transcript doesn't hold yet stays this long (the transcript is re-read
// every second while omp works).
const STREAM_GRACE_MS = 5000;
const STREAM_POLL_MS = 150;
// omp's reasoning-effort icons (its Unicode symbol set; its Nerd Font set draws the same circles).
const EFFORT_ICONS = { minimal: "○", low: "◔", medium: "◑", high: "◒", xhigh: "◕", max: "◉" };
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
// Turns of parked omps someone saw "done" in their chat pane: { [terminal]: turn }.
const SEEN_KEY = "omp-chat.seen";
// The feed rows' side padding, and the Copy button's box (a square around its 12px icon; it sticks
// out by its padding so the icon lines up with the answer).
const FEED_PAD = 20;
const COPY_BUTTON = { width: 24, pad: 6 };

// An open list (the / commands, the /resume picker) puts its text box in this key context. The
// text box's own bindings (context "Input": cursor up/down, Tab indents) would take ↑ ↓ Tab
// before any on_key_down; bindings matched at the same depth, and installed later, outrank them.
const LIST_CONTEXT = "OmpChatList";
let listKeysBound = false;
function bindListKeys(cx) {
  if (listKeysBound) return;
  listKeysBound = true;
  const keys = [["up", "omp_chat_list_up"], ["down", "omp_chat_list_down"], ["tab", "omp_chat_list_accept"]];
  cx.bind_keys(keys.flatMap(([keystroke, action]) => [
    { keystroke, action, context: `${LIST_CONTEXT} > Input` },
    { keystroke, action, context: LIST_CONTEXT },
  ]));
}

// Commands that open a screen in omp's terminal (any arguments), and ones that do only when bare.
// After Ovis's server/skills/omp.ts TERMINAL_BOUND (MIT, see NOTICE.md), checked against omp 18.18.
const TERMINAL_BOUND = new Set([
  "settings", "setup", "plan", "plan-review", "vibe", "goal", "guided-goal", "loop", "queue", "collab", "join",
  "leave", "copy", "open", "hotkeys", "extensions", "agents", "git", "hub", "branch", "fork", "tree", "login",
  "logout", "new", "clear", "delete", "resume", "tan", "omfg", "cleanse", "debug", "exit", "restart", "skills",
  "live", "record", "pause", "quit", "seance", "changelog", "context", "tools", "usage", "stats", "session", "dirs",
  "mcp", "plugins", "effort", "move", "local",
]);
const BARE_TERMINAL = new Set(["model", "switch", "btw", "modelpreset", "marketplace"]);

/** A fenced code block that no backtick run inside `text` can close. */
function fenced(text, lang = "") {
  const longest = Math.max(2, ...[...String(text).matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${lang}\n${text}\n${fence}`;
}

export class Chat {
  init(cx) {
    this.alive = true;
    bindListKeys(cx);
    this.terminal = null;
    this.state = null;
    this.pending = [];
    this.commands = [];
    this.feed = { total: 0, start: 0, items: [] };
    this.limit = PAGE;
    this.open = new Set();
    this.follow = true;
    this.gen = 0;
    this.scrollTo = null;
    this.heights = new Map();
    this.lastHeight = new Map();
    this.measuredAt = new Map(); // row key → when its measured height last changed
    this.sent = []; // messages sent from here that the transcript doesn't hold yet
    this.working = false;
    this.stream = null; // { id, blocks, done } the bridge last wrote, and when it was read (`at`)
    // Every second: Herdr's status for the terminal changes without telling the chat, and
    // watchFolder can stay silent while omp appends to the session file (seen on macOS): while omp
    // works or a sent message waits, and once more after, re-read the transcript.
    cx.timer.every(1000, (cx) => {
      const working = this.isWorking();
      this.markSeen();
      const active = working || this.sent.length > 0;
      if (this.state?.sessionFile && (active || this.wasActive)) cx.spawn(async (cx) => { await this.loadFeed(cx); cx.notify(); });
      else if (working !== this.working) cx.notify();
      this.wasActive = active;
    });
    this.seenCards = new Set();
    this.cardBusy = null;
    this.cardError = {};
    this.picks = {};
    this.otherInputs = {};
    this.sel = 0;
    this.dismissed = false;
    this.text = "";
    this.sendError = null;
    this.scroll = VirtualListScrollHandle.new();
    this.input = TextareaState.new({ placeholder: "Message omp…" });
    this.input.set_auto_grow(1, 8);
    this.input.on("change", (_e, cx) => {
      this.before = this.text;
      this.text = this.input.value();
      this.sel = 0;
      this.dismissed = false;
      this.sendError = null;
      cx.notify();
    });
    this.input.on("submit", (e, cx) => this.enter(e, cx));
    this.steer = InputState.new({ placeholder: "Deny and tell it…" });
    this.steer.on("submit", (_e, cx) => this.approve(this.pending.find((c) => c.kind === "approval"), "deny", this.steer.value(), cx));
    this.picker = null;
    this.pickerSearch = InputState.new({ placeholder: "Search sessions…" });
    this.pickerSearch.on("change", (_e, cx) => { if (this.picker) this.picker.sel = 0; cx.notify(); });
    this.pickerSearch.on("submit", (_e, cx) => {
      const pick = this.pickerList()[Math.min(this.picker?.sel ?? 0, this.pickerList().length - 1)];
      if (pick) this.resume(pick.path, cx);
    });
    this.pickerScroll = VirtualListScrollHandle.new();
    this.handle = cx.focus_handle();
    // `focus`: pane.go (or a closed popup) hands this pane the keyboard. ⌘J is the pane header's.
    cx.spawn(async (cx) => {
      while (this.alive) {
        const command = await nextCommand();
        if (command === "focus") this.input.focus();
        cx.notify();
      }
    });
    watchRoot(cx, () => this.alive, (changed, cx) => this.rootChanged(changed, cx));
    // A chat pane shows one omp for its whole life: the terminal its pane stands for.
    this.terminal = props()?.terminal ?? null;
    const own = props()?.pane;
    if (own && this.terminal && chatPanes()[own] !== this.terminal) setChatPanes({ ...chatPanes(), [own]: this.terminal });
    if (this.terminal) cx.spawn(async (cx) => { await this.loadChannel(cx); cx.notify(); });
    if (this.terminal) this.watchStream(cx);
    if (this.myPane() && panes().find((p) => p.pane === this.myPane())?.focused) this.input.focus();
  }

  /** This chat pane's id: from the app's props, else the pane map. */
  myPane() {
    return props()?.pane ?? Object.entries(chatPanes()).find(([, t]) => t === this.terminal)?.[0] ?? null;
  }

  /** Back to omp's terminal, in this pane's place. */
  showTerminal(cx) {
    const pane = this.myPane();
    if (pane && this.terminal) toTerminal(pane, this.terminal, cx);
  }

  async close() {
    this.alive = false;
    this.gen++;
    // The pane went without passing back to the terminal (its tab closed): end the parked omp
    // with it, as closing the tab would have. On quit the pane still exists, and nothing happens.
    const pane = this.myPane();
    if (this.terminal && pane && !panes().some((p) => p.pane === pane)) {
      const map = { ...(shared("omp-chat.panes") ?? {}) };
      if (map[pane] === this.terminal) {
        delete map[pane];
        setChatPanes(map);
        run("terminal.kill", { terminal: this.terminal });
      }
    }
  }

  /**
   * Reads the bridge's stream file for this terminal (the answer as omp writes it) every
   * STREAM_POLL_MS while omp works, and not otherwise.
   */
  watchStream(cx) {
    const file = `${STREAM_DIR}/${this.terminal}.json`;
    let last = null;
    let reading = false;
    // `fresh`: written while this chat looked; the file found on opening is an earlier answer.
    const read = async (fresh) => {
      reading = true;
      let text = null;
      try { text = await readTextFile(file); } catch {}
      reading = false;
      if (text === last) return false;
      last = text;
      let s = null;
      try { s = text ? JSON.parse(text) : null; } catch {}
      this.stream = Array.isArray(s?.blocks) ? { id: s.id, blocks: s.blocks, done: s.done === true, at: fresh ? Date.now() : 0 } : null;
      return true;
    };
    cx.spawn(async () => { await read(false); });
    cx.timer.every(STREAM_POLL_MS, (cx) => {
      // A few reads after omp stops, for the final write.
      const after = this.stream?.done === false && Date.now() - this.stream.at < STREAM_GRACE_MS;
      if (reading || !this.alive || !(this.working || after)) return;
      cx.spawn(async (cx) => { if (await read(true)) cx.notify(); });
    });
  }

  /**
   * The answer omp is writing, until the transcript holds it, as markdown, else null. A finished
   * one shows a few seconds at most, so an answer the transcript never matches doesn't linger.
   */
  liveStream() {
    const s = this.stream;
    const last = s?.blocks.at(-1)?.trim();
    if (!last || !(s.done ? Date.now() - s.at < STREAM_GRACE_MS : this.working)) return null;
    if (this.feed.items.some((i) => i.k === "text" && i.text.trim() === last)) return null;
    return s.blocks.join("\n\n");
  }

  // --- data ---------------------------------------------------------------------------------

  async rootChanged(changed, cx) {
    if (!this.terminal) return;
    const mine = `${dirOf(this.terminal)}`;
    const all = changed.some((p) => p === ROOT || p === `${ROOT}/`);
    if (!all && !changed.some((p) => p === mine || p.startsWith(`${mine}/`))) return;
    if (all || changed.some((p) => p === `${mine}/pending.json`)) await this.checkCards();
    await this.loadChannel(cx);
    cx.notify();
  }

  /** Herdr doesn't alert for a parked omp: tell the person about a new card when this pane isn't on screen. */
  async checkCards() {
    const cards = (await readJson(`${dirOf(this.terminal)}/pending.json`)) ?? [];
    const tab = panes().find((p) => p.pane === this.myPane())?.tab;
    const shown = tab && tab === focused()?.tab;
    for (const card of cards) {
      if (this.seenCards.has(card.toolCallId)) continue;
      if (!shown) {
        notify({
          title: card.kind === "ask" ? "omp has a question" : `omp asks to run ${card.toolName}`,
          body: card.kind === "ask" ? String(card.questions?.[0]?.question ?? "") : String(card.input?.command ?? card.intent ?? ""),
          level: "warning",
          ...(tab ? { action: { name: "tab.select", args: { id: tab } } } : {}),
        });
        playSound("blocked");
      }
    }
    this.seenCards = new Set(cards.map((c) => c.toolCallId));
  }

  async loadChannel(cx) {
    const t = this.terminal;
    const [state, pending, commands] = await Promise.all([
      readJson(`${dirOf(t)}/state.json`),
      readJson(`${dirOf(t)}/pending.json`),
      readJson(`${dirOf(t)}/commands.json`),
    ]);
    if (t !== this.terminal) return;
    const fileChanged = state?.sessionFile !== this.state?.sessionFile;
    // The feed follows the session file by itself; state only matters to it when /tree or a rewind moved the leaf.
    const leafChanged = JSON.stringify(state?.leaf ?? null) !== JSON.stringify(this.state?.leaf ?? null);
    this.state = state;
    this.loaded = true;
    this.pending = Array.isArray(pending) ? pending : [];
    this.commands = Array.isArray(commands) ? commands : this.commands;
    for (const card of this.pending) {
      if (card.kind !== "ask" || this.picks[card.toolCallId]) continue;
      const questions = Array.isArray(card.questions) ? card.questions : [];
      this.picks[card.toolCallId] = questions.map(() => []);
      this.otherInputs[card.toolCallId] = questions.map(() => InputState.new({ placeholder: "Or your own answer…" }));
    }
    if (fileChanged) this.watchSession(cx);
    else if (leafChanged) await this.loadFeed(cx);
  }

  /** Follows the session file: re-reads the feed when omp appends to it. */
  watchSession(cx) {
    const gen = ++this.gen;
    this.limit = PAGE;
    this.follow = true;
    this.feed = { total: 0, start: 0, items: [] };
    const file = this.state?.sessionFile;
    if (!file) return;
    const dir = file.slice(0, file.lastIndexOf("/"));
    cx.spawn(async (cx) => {
      await this.loadFeed(cx);
      while (this.alive && gen === this.gen) {
        let changed;
        try {
          changed = await watchFolder(dir);
        } catch {
          // A new session's folder appears with its first message: look again in a second.
          await new Promise((resolve) => cx.timer.after(1000, () => resolve()));
          if (gen === this.gen) await this.loadFeed(cx);
          continue;
        }
        if (gen !== this.gen) return;
        if (changed.some((p) => p === file || p === dir || p === `${dir}/`)) await this.loadFeed(cx);
      }
    });
  }

  /** Reads the transcript; `pin`: an item to hold in place at the top as the new rows land. */
  async loadFeed(cx, pin = null) {
    if (this.loading) {
      this.dirty = true;
      return;
    }
    this.loading = true;
    try {
      do {
        this.dirty = false;
        const file = this.state?.sessionFile;
        if (!file) break;
        const leaf = this.state?.leaf?.after ? ["--leaf", this.state.leaf.id ?? "none", "--after", this.state.leaf.after] : [];
        const r = await exec("bun", [HELPER, file, "--limit", String(this.limit), ...leaf, "--palette", this.paletteKey ?? "{}", "--app-home", appHome()]);
        if (r.code !== 0 || file !== this.state?.sessionFile) continue;
        const before = this.feed;
        this.feed = JSON.parse(r.stdout);
        // Sent messages wait for the transcript, or two minutes (omp never took it).
        this.sent = this.sent.filter((s) => this.sentCount(s.text) <= s.base && Date.now() - s.at < 120000);
        if (pin) this.pin = pin;
        this.feedError = null;
        const grew = this.feed.items.at(-1)?.id !== before.items.at(-1)?.id || this.feed.total !== before.total;
        if (this.follow && grew) this.scrollTo = "bottom";
      } while (this.dirty);
    } catch (e) {
      this.feedError = String(e?.message ?? e);
    } finally {
      this.loading = false;
    }
    cx.notify();
  }

  loadOlder(cx) {
    if (this.feed.start <= 0 || this.loading) return;
    // The anchor is the item ending the top row: a work row's id names its first call, which
    // changes when the earlier page adds calls to the same run; its last call stays.
    const top = this.rows().find((r) => r.id !== "__older");
    const anchor = top?.tools?.at(-1)?.id ?? top?.id;
    this.limit += PAGE;
    this.follow = false;
    cx.spawn(async (cx) => {
      await this.loadFeed(cx, anchor);
      cx.notify();
    });
  }

  /**
   * Reached the top: load the next batch once the scrolling (trackpad momentum too) has stopped,
   * so the rows land, and the top row is pinned, while nothing else moves the list.
   */
  awaitOlder(cx) {
    this.olderWait = true;
    cx.notify();
    const check = (cx) => {
      if (!this.alive) return;
      if (Date.now() - this.lastWheel < OLDER_SETTLE_MS) return cx.timer.after(OLDER_SETTLE_MS, check);
      this.olderWait = false;
      if (this.olderShown) this.loadOlder(cx);
      else cx.notify();
    };
    cx.timer.after(OLDER_SETTLE_MS, check);
  }

  // --- sending ------------------------------------------------------------------------------

  completions() {
    const text = this.text;
    if (this.dismissed || !text.startsWith("/") || /\s/.test(text)) return [];
    const q = text.slice(1).toLowerCase();
    const named = this.commands.filter((c) => c.name.toLowerCase().startsWith(q));
    const inside = this.commands.filter((c) => !c.name.toLowerCase().startsWith(q) && c.name.toLowerCase().includes(q));
    return [...named, ...inside].slice(0, 8);
  }

  accept(command, cx) {
    const value = `/${command.name}${command.args === false ? "" : " "}`;
    this.input.set_value(value);
    this.input.set_selected_range({ start: value.length, end: value.length });
    this.text = value;
    this.dismissed = true;
    cx.notify();
  }

  /** Did the last change only add a newline (the textarea's own Enter)? */
  enterInserted() {
    const lines = (s) => (s ?? "").split("\n").length;
    return this.before !== undefined && this.text.length === this.before.length + 1 && lines(this.text) === lines(this.before) + 1;
  }

  /** Enter sends, Shift+Enter is a new line, Cmd/Ctrl+Enter sends after the running turn (omp's follow-up). */
  enter(e, cx) {
    const inserted = this.enterInserted();
    if (e.shift) {
      if (!inserted) this.input.replace("\n");
      return;
    }
    if (inserted) this.text = this.before;
    this.submit(cx, { followUp: e.secondary === true });
  }

  submit(cx, { followUp = false } = {}) {
    const shown = this.completions();
    const typed = this.text.trim();
    if (shown.length && !shown.some((c) => `/${c.name}` === typed)) return this.accept(shown[Math.min(this.sel, shown.length - 1)], cx);
    if (typed === "/resume" && this.terminal) {
      // omp's /resume opens a picker in its terminal; the chat has its own (openPicker).
      this.input.set_value("");
      this.text = "";
      this.before = undefined;
      return this.openPicker(cx);
    }
    if (!typed || !this.terminal) {
      this.input.set_value(this.text);
      return;
    }
    const terminal = this.terminal;
    this.input.set_value("");
    this.text = "";
    this.before = undefined;
    this.follow = true;
    // A message (not a command) shows at once; loadFeed drops it once the transcript has it.
    const sent = typed.startsWith("/") ? null : { id: `__sent-${Date.now()}`, text: typed, base: this.sentCount(typed), at: Date.now() };
    if (sent) {
      this.sent.push(sent);
      this.scrollTo = "bottom";
      cx.notify();
    }
    cx.spawn(async (cx) => {
      try {
        if (typed.startsWith("/")) {
          await send(terminal, typed);
          const [name, ...rest] = typed.slice(1).split(/\s+/);
          if (TERMINAL_BOUND.has(name) || (!rest.join("") && BARE_TERMINAL.has(name))) this.showTerminal(cx);
        } else {
          await sendRequest(terminal, { type: "prompt", text: typed, ...(followUp ? { followUp: true } : {}) });
        }
        this.scrollTo = "bottom";
      } catch (e) {
        this.sendError = String(e?.message ?? e);
        this.sent = this.sent.filter((s) => s !== sent);
        this.input.set_value(typed);
        this.text = typed;
      }
      cx.notify();
    });
  }

  approve(card, choice, steerText, cx) {
    if (!card || this.cardBusy) return;
    if (choice === "deny" && steerText !== undefined && !steerText.trim()) return;
    this.cardBusy = card.toolCallId;
    delete this.cardError[card.toolCallId];
    cx.spawn(async (cx) => {
      try {
        await answerApproval(this.terminal, card, choice, steerText?.trim() || undefined, cx);
        if (steerText) this.steer.set_value("");
      } catch (e) {
        this.cardError[card.toolCallId] = e instanceof ScreenChanged ? e.message : String(e?.message ?? e);
      }
      this.cardBusy = null;
      cx.notify();
    });
    cx.notify();
  }

  answer(card, cx) {
    if (this.cardBusy) return;
    const answers = (this.picks[card.toolCallId] ?? []).map((picked, i) => ({ picked, other: this.otherInputs[card.toolCallId]?.[i]?.value() || null }));
    const missing = answers.findIndex((a, i) => !a.other && !a.picked.length && !card.questions[i].multi);
    if (missing >= 0) {
      this.cardError[card.toolCallId] = `Pick an answer for “${card.questions[missing].question}”`;
      return cx.notify();
    }
    this.cardBusy = card.toolCallId;
    delete this.cardError[card.toolCallId];
    cx.spawn(async (cx) => {
      try {
        await answerAsk(this.terminal, card, answers, cx);
      } catch (e) {
        this.cardError[card.toolCallId] = e instanceof ScreenChanged ? e.message : String(e?.message ?? e);
      }
      this.cardBusy = null;
      cx.notify();
    });
    cx.notify();
  }

  // --- view ---------------------------------------------------------------------------------

  /**
   * The list's rows: thinking is left out; each run of tool calls folds into one "work" row (its
   * calls follow when opened); a "copy" row closes each finished answer with its text.
   */
  rows() {
    const rows = [];
    if (this.feed.start > 0) rows.push({ k: "older", id: "__older" });
    let work = null;
    let answer = [];
    let lastText = null;
    const flushWork = () => {
      if (!work) return;
      rows.push(work);
      if (this.open.has(work.id)) rows.push(...work.tools);
      work = null;
    };
    const flushAnswer = () => {
      if (answer.length) rows.push({ k: "copy", id: `copy:${lastText}`, text: answer.join("\n\n") });
      answer = [];
    };
    for (const item of this.feed.items) {
      if (item.k === "thinking") continue;
      if (item.k === "tool") {
        work ??= { k: "work", id: `work:${item.id}`, tools: [] };
        work.tools.push(item);
        continue;
      }
      flushWork();
      if (item.k === "user") flushAnswer();
      // An answer split into parts is a row per part, and a block's copy button a row under it, as
      // the answer's: the list's on_item_click names the row (clickRow).
      if (item.k === "text" && item.parts) {
        item.parts.forEach((part, i) => {
          rows.push({ k: "part", id: `${item.id}#${i}`, part, first: i === 0, last: i === item.parts.length - 1 });
          if (part.copy != null) rows.push({ k: "copy", id: `copy:${item.id}#${i}`, text: part.copy, block: true });
        });
      } else rows.push(item);
      if (item.k === "text") {
        answer.push(item.text);
        lastText = item.id;
      }
    }
    flushWork();
    const working = this.working || this.sent.length > 0;
    if (!working) flushAnswer();
    // Sent, and not in the transcript yet: shown at once (omp writes it with its first turn).
    for (const s of this.sent) rows.push({ k: "user", id: s.id, text: s.text });
    // The answer omp is writing, until the transcript holds it.
    const live = this.liveStream();
    if (live) rows.push({ k: "text", id: `stream:${this.stream.id}`, text: live });
    if (working) rows.push({ k: "working", id: "__working" });
    return rows;
  }

  /** How many of the loaded messages from you read `text`. */
  sentCount(text) {
    return this.feed.items.filter((i) => i.k === "user" && i.text.trim() === text).length;
  }

  /**
   * Herdr turns "done" into "idle" once the terminal is on screen, which a parked one never is,
   * and it has no command for it. So the chat records it: while this pane is on screen, the
   * terminal's turn goes into shared `omp-chat.seen`, and the sidebar lists show that turn's
   * "done" as idle.
   */
  markSeen() {
    const all = terminals();
    const term = this.terminal ? all.find((x) => x.address === this.terminal) : null;
    if (term?.status !== "done" || term.turn == null) return;
    const seen = shared(SEEN_KEY) ?? {};
    if (seen[this.terminal] === term.turn) return;
    const tab = panes().find((p) => p.pane === this.myPane())?.tab;
    if (!tab || tab !== focused()?.tab) return;
    const live = Object.fromEntries(Object.entries(seen).filter(([t]) => all.some((x) => x.address === t)));
    setShared(SEEN_KEY, { ...live, [this.terminal]: term.turn });
  }

  /**
   * Whether omp is working: Herdr's status for the terminal (what the terminal view shows), else
   * the bridge's, which an agent end it never hears about can leave stuck.
   */
  isWorking() {
    const status = this.terminal ? terminals().find((x) => x.address === this.terminal)?.status : null;
    if (status === "working" || status === "blocked") return true;
    if (status === "idle" || status === "done") return false;
    return Boolean(this.state?.busy);
  }

  item(row, t, mono) {
    const width = Math.max(200, (this.width ?? 700) - 48);
    const open = this.open.has(row.id);
    switch (row.k) {
      case "older":
        return h_flex().w_full().justify_center().py(10).text_size(12).text_color(t.dim).child(this.loading || this.olderWait ? "Loading earlier messages…" : "Earlier messages ▴");
      case "work": {
        const running = row.tools.some((tool) => !tool.done);
        const failed = row.tools.filter((tool) => tool.error).length;
        const last = row.tools[row.tools.length - 1];
        return h_flex().w_full().my(2).px(9).py(5).gap(8).items_center().rounded(8).text_size(12.5).text_color(t.muted).cursor_pointer()
          .child(div().flex_none().text_color(t.dim).child(open ? "▾" : "▸"))
          .when(running, (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
          .child(div().flex_none().font_medium().text_color(t.foreground).child(running ? "Working" : "Worked"))
          .child(div().flex_none().child(`${row.tools.length} step${row.tools.length === 1 ? "" : "s"}`))
          .when(failed > 0, (el) => el.child(div().flex_none().text_color(t.blocked).child(`${failed} failed`)))
          .when(!open, (el) => el.child(div().flex_1().truncate().text_color(t.dim).child(`${last.name} · ${last.summary}`)));
      }
      case "copy":
        // Only the button, at the right edge, is the target: clickRow ignores presses beside it
        // (COPY_BUTTON). Under a block (code, table, diagram, equation) it copies that block; under
        // the answer, all of it.
        return h_flex().w_full().justify_end().pb(row.block ? 3 : 6).child(h_flex().size(COPY_BUTTON.width).mr(-COPY_BUTTON.pad).items_center().justify_center()
          .rounded(6).text_color(this.copied === row.id ? t.done : t.dim).cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(this.copied === row.id ? t.done : t.foreground))
          .child(svg(`mods/omp-chat/${this.copied === row.id ? "check" : "copy"}.svg`).size(12)));
      case "working":
        return h_flex().w_full().px(4).py(8).gap(8).items_center().text_size(12.5).text_color(t.muted)
          .child(div().text_color(t.working).child("⠋").frames(SPINNER, 90))
          .child(this.pending.length ? "Waiting for you" : "Working…");
      case "user":
        return h_flex().w_full().justify_end().pt(14).pb(4).child(
          v_flex().max_w(width * 0.82).px(13).py(9).rounded(14).bg(t.selected).text_color(t.foreground).text_size(13.5)
            .when(row.steer, (el) => el.child(div().text_size(10.5).text_color(t.dim).pb(2).child("steer")))
            .child(TextView.markdown(`u-${row.id}`, row.text).selectable(true).w_full()));
      case "text":
        return div().w_full().py(4).text_size(13.5).text_color(t.foreground)
          .child(TextView.markdown(`m-${row.id}`, row.text).selectable(true).w_full());
      case "part": {
        const p = row.part;
        let body;
        if (p.t === "md") body = TextView.markdown(`m-${row.id}`, p.text).selectable(true).w_full();
        else if (p.t === "pre") body = div().w_full().text_size(12).child(TextView.markdown(`mm-${row.id}`, fenced(p.text)).selectable(true).w_full());
        else {
          // A figure at its own size, shrunk to fit the column and at most 560px high.
          let w = Math.min(p.w, width);
          let h = (p.h * w) / p.w;
          if (h > 560) { w = (w * 560) / h; h = 560; }
          body = image(p.path).w(w).h(h);
        }
        return div().w_full().pt(row.first ? 4 : 3).pb(row.last || p.copy != null ? 4 : 3).text_size(13.5).text_color(t.foreground).child(body);
      }
      case "tool": {
        const color = !row.done ? t.working : row.error ? t.blocked : t.done;
        const box = (label, text, id) => v_flex().w_full().gap(3)
          .child(div().text_size(10.5).text_color(t.dim).child(label))
          .child(div().w_full().max_h(320).overflow_hidden().rounded(7).bg(t.background).border_1().border_color(t.border).px(8).text_size(12)
            .child(TextView.markdown(id, fenced(text)).selectable(true).w_full()));
        return v_flex().w_full().py(2).gap(6).cursor_pointer()
          .child(h_flex().w_full().gap(8).items_center().px(9).py(6).rounded(8).bg(t.raised).text_size(12.5)
            .child(div().text_color(color).child(row.done ? (row.error ? "✕" : "●") : "◌"))
            .child(div().flex_none().font_family(mono).font_medium().text_color(t.foreground).child(row.name))
            .child(div().flex_1().truncate().text_color(t.muted).child(row.summary))
            .child(div().flex_none().text_color(t.dim).child(open ? "▾" : "▸")))
          .when(open, (el) => el.child(v_flex().w_full().pl(12).gap(6)
            .child(box("Input", row.input, `ti-${row.id}`))
            .when(row.done, (el) => el.child(box(row.error ? "Error" : "Output", row.output || "(no output)", `to-${row.id}`)))));
      }
      case "compact":
        return v_flex().w_full().my(8).px(12).py(8).gap(4).rounded(8).border_1().border_color(t.border).text_size(12).text_color(t.muted).cursor_pointer()
          .child(div().font_medium().child(`Compacted ${open ? "▾" : "▸"}`))
          .when(open, (el) => el.child(TextView.markdown(`c-${row.id}`, row.text).selectable(true).w_full()));
      case "notice":
        return h_flex().w_full().justify_center().py(6).child(
          div().max_w(width * 0.9).px(10).py(5).rounded(8).bg(t.raised).text_size(12).text_color(t.muted).child(row.text.slice(0, 600)));
      case "error":
        return div().w_full().py(4).text_size(12.5).text_color(t.blocked).child(`Error: ${row.text}`);
      default:
        return div();
    }
  }

  /** omp's banner as the terminal shows it on a new session: logo, wordmark, version, a tip. */
  welcome(t, mono) {
    const w = this.state?.welcome;
    // Both svgs use 8×16 cells, a terminal cell's shape: logo.svg keeps omp's gradient, the
    // wordmark is a mask tinted to the theme. The wordmark starts on the logo's second row.
    return v_flex().items_center().gap(22).px(FEED_PAD)
      .child(h_flex().gap(32).items_start()
        .child(image("mods/omp-chat/logo.svg").w(96).h(80))
        .child(v_flex().pt(16)
          .child(svg("mods/omp-chat/wordmark.svg").w(120).h(48).text_color(t.foreground))
          .child(div().h(16).flex().items_center().font_family(mono).text_size(12.5).text_color(t.dim).child(w?.version ? `v${w.version}` : ""))))
      .when(Boolean(w?.tip), (el) => el.child(div().max_w(480).text_size(13).text_color(t.muted)
        .child(TextView.markdown("omp-chat-tip", `**Tip:** ${w.tip}`))));
  }

  clickRow(key, cx) {
    if (key === "__older") return this.loadOlder(cx);
    if (key.startsWith("copy:")) {
      // A row click carries no position: the press recorded on the feed says whether it hit the button.
      const x = this.pressX;
      const right = (this.width ?? 0) - FEED_PAD + COPY_BUTTON.pad;
      if (x != null && (x < right - COPY_BUTTON.width || x > right)) return;
      const row = this.rows().find((r) => r.id === key);
      if (!row) return;
      cx.write_to_clipboard(row.text);
      this.copied = key;
      cx.timer.after(1500, (cx) => {
        if (this.copied === key) this.copied = null;
        cx.notify();
      });
      return cx.notify();
    }
    const row = key.startsWith("work:") ? { k: "work" } : this.feed.items.find((i) => i.id === key);
    if (!row || !["work", "tool", "compact"].includes(row.k)) return;
    if (this.open.has(key)) this.open.delete(key);
    else this.open.add(key);
    cx.notify();
  }

  button(id, label, t, kind, action) {
    const solid = kind === "primary";
    const danger = kind === "danger";
    return h_flex().id(id).h(28).px(11).items_center().rounded(7).flex_none()
      .border_1().border_color(solid ? t.solid : danger ? t.blocked : t.input).bg(solid ? t.solid : t.raised)
      .text_color(solid ? t.solid_foreground : danger ? t.blocked : t.foreground).text_size(12.5).font_medium()
      .cursor_pointer().hover((s) => s.opacity(0.85)).on_click(action).child(label);
  }

  approvalCard(card, t, mono) {
    const busy = this.cardBusy === card.toolCallId;
    const input = card.input ?? {};
    const shell = typeof input.command === "string";
    // A shell call shows its command as is, its other arguments (cwd, timeout) as a line under it.
    const extra = shell ? Object.entries(input).filter(([k]) => k !== "command" && k !== "i").map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join(" · ") : "";
    const body = shell ? input.command : input.truncated ? `${input.text}\n…` : JSON.stringify(input, null, 2);
    return v_flex().w_full().gap(8).p(12).rounded(10).border_1().border_color(t.blocked).bg(t.popover)
      .child(h_flex().gap(8).items_center()
        .child(div().text_color(t.blocked).child("●"))
        .child(div().font_semibold().text_size(13).child(`Allow ${card.toolName}?`))
        .child(div().flex_1())
        .child(div().text_size(11).text_color(t.dim).truncate().child((this.state?.cwd ?? "").replace(home(), "~"))))
      .when(Boolean(card.intent), (el) => el.child(div().text_size(12.5).text_color(t.muted).child(card.intent)))
      .child(div().id(`ap-body-${card.toolCallId}`).w_full().max_h(220).overflow_y_scroll().rounded(7).bg(t.background).border_1().border_color(t.border).px(8).text_size(12)
        .child(TextView.markdown(`ap-${card.toolCallId}`, fenced(body, shell ? "sh" : "json")).selectable(true).w_full()))
      .when(Boolean(extra), (el) => el.child(div().text_size(11.5).text_color(t.dim).truncate().child(extra)))
      .child(h_flex().gap(8).flex_wrap().items_center()
        .child(this.button(`ap-ok-${card.toolCallId}`, "Approve", t, "primary", (_e, cx) => this.approve(card, "approve", undefined, cx)))
        .child(this.button(`ap-ses-${card.toolCallId}`, `Approve ${card.toolName} for this session`, t, "", (_e, cx) => this.approve(card, "session", undefined, cx)))
        .child(this.button(`ap-no-${card.toolCallId}`, "Deny", t, "danger", (_e, cx) => this.approve(card, "deny", undefined, cx)))
        .when(busy, (el) => el.child(div().text_size(12).text_color(t.dim).child("…"))))
      .child(h_flex().gap(8).items_center()
        .child(Input.new(this.steer).flex_1().h(30).px(9).rounded(7).border_1().border_color(t.input).bg(t.background).text_size(12.5))
        .child(this.button(`ap-steer-${card.toolCallId}`, "Deny and send", t, "", (_e, cx) => this.approve(card, "deny", this.steer.value(), cx))))
      .when(Boolean(this.cardError[card.toolCallId]), (el) => el.child(this.cardProblem(card, t)));
  }

  cardProblem(card, t) {
    return h_flex().gap(10).items_center().text_size(12).text_color(t.blocked)
      .child(div().flex_1().child(this.cardError[card.toolCallId]))
      .child(this.button(`card-term-${card.toolCallId}`, "Terminal", t, "", (_e, cx) => this.showTerminal(cx)));
  }

  askCard(card, t) {
    const questions = Array.isArray(card.questions) ? card.questions : [];
    const picks = this.picks[card.toolCallId] ?? [];
    const others = this.otherInputs[card.toolCallId] ?? [];
    return v_flex().w_full().gap(10).p(12).rounded(10).border_1().border_color(t.accent).bg(t.popover)
      .child(h_flex().gap(8).items_center().child(div().text_color(t.accent).child("?"))
        .child(div().font_semibold().text_size(13).child(questions.length > 1 ? `omp asks ${questions.length} questions` : "omp asks")))
      .children(questions.map((q, qi) => v_flex().gap(6)
        .child(div().text_size(13).text_color(t.foreground).child(q.question ?? ""))
        .child(h_flex().gap(6).flex_wrap().children((q.options ?? []).map((o, oi) => {
          const on = (picks[qi] ?? []).includes(oi);
          return h_flex().id(`ask-${card.toolCallId}-${qi}-${oi}`).px(10).py(5).gap(6).rounded(14).cursor_pointer()
            .border_1().border_color(on ? t.accent : t.input).bg(on ? t.selected : t.raised).text_size(12.5)
            .child(q.multi ? (on ? "☑" : "☐") : (on ? "◉" : "○"))
            .child(String(o.label ?? o))
            .on_click((_e, cx) => {
              const now = picks[qi] ?? [];
              picks[qi] = q.multi ? (on ? now.filter((x) => x !== oi) : [...now, oi]) : [oi];
              cx.notify();
            });
        })))
        .when(Boolean(others[qi]), (el) => el.child(Input.new(others[qi]).h(30).px(9).rounded(7).border_1().border_color(t.input).bg(t.background).text_size(12.5)))))
      .child(h_flex().gap(8).items_center()
        .child(this.button(`ask-send-${card.toolCallId}`, "Answer", t, "primary", (_e, cx) => this.answer(card, cx)))
        .when(this.cardBusy === card.toolCallId, (el) => el.child(div().text_size(12).text_color(t.dim).child("…"))))
      .when(Boolean(this.cardError[card.toolCallId]), (el) => el.child(this.cardProblem(card, t)));
  }

  reply(t, mono) {
    const shown = this.completions();
    const sel = Math.min(this.sel, Math.max(0, shown.length - 1));
    return v_flex().w_full().gap(6).relative()
      .when(shown.length > 0, (el) => el.child(v_flex().w_full().p(4).rounded(10).border_1().border_color(t.border).bg(t.popover)
        .children(shown.map((c, i) => h_flex().id(`cmp-${c.name}`).px(8).py(5).gap(10).rounded(6).cursor_pointer()
          .when(i === sel, (el) => el.bg(t.hover)).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.accept(c, cx))
          .child(div().flex_none().font_family(mono).text_size(12.5).text_color(t.foreground).child(`/${c.name}`))
          .child(div().flex_1().truncate().text_size(12).text_color(t.dim).child(c.description ?? ""))))))
      .when(Boolean(this.sendError), (el) => el.child(div().text_size(12).text_color(t.blocked).child(this.sendError)))
      // The status label is the frame's sibling, not its child: a frame paints its border over its
      // own children, so only a later sibling's background can cut the line.
      .child(div().w_full().mt(4).relative()
      .child(h_flex().w_full().gap(8).items_center().px(10).py(4).rounded(12).border_1().border_color(t.input).bg(t.background)
        // While the list is open, ↑ ↓ and Tab belong to it: the "OmpChatList" context lets the
        // bindings from bindListKeys outrank the text area's own (cursor up/down, indent).
        .child(div().flex_1().py(5).key_context(shown.length ? LIST_CONTEXT : "OmpChatReply")
          .on_action("omp_chat_list_up", (_e, cx) => this.listKey("up", cx))
          .on_action("omp_chat_list_down", (_e, cx) => this.listKey("down", cx))
          .on_action("omp_chat_list_accept", (_e, cx) => this.listKey("tab", cx))
          .child(Textarea.new(this.input).w_full().text_size(13.5).text_color(t.foreground)))
        .when(this.working, (el) => el.child(h_flex().id("stop").size(28).flex_none().items_center().justify_center().rounded(8)
          .bg(t.raised).border_1().border_color(t.input).text_color(t.foreground).text_size(11).cursor_pointer()
          .on_click((_e, cx) => this.stop(cx)).child("■")))
        .child(h_flex().id("send").size(28).flex_none().items_center().justify_center().rounded(8).bg(this.text.trim() ? t.solid : t.raised)
          .text_color(this.text.trim() ? t.solid_foreground : t.dim).cursor_pointer().on_click((_e, cx) => this.submit(cx)).child("↑")))
      .when(Boolean(this.state?.model || this.feed.status?.model), (el) => el.child(this.status(t))));
  }

  /**
   * omp's status line, short, set into the reply box's top border at the right as omp's editor
   * does: the reasoning effort as omp's circle icon, the model, and how full the context is as a
   * small bar (the number on hover). Live from the bridge; from the last answer in the
   * transcript when an older bridge doesn't report it.
   */
  status(t) {
    const s = this.state ?? {};
    const last = this.feed.status ?? {};
    const model = s.model?.name ?? s.model?.id ?? last.model;
    const effort = s.thinking ?? last.effort;
    const tokens = s.context?.tokens ?? last.tokens;
    const window = s.context?.window ?? last.window;
    const pct = typeof s.context?.percent === "number" ? s.context.percent : tokens && window ? (tokens / window) * 100 : null;
    const size = (n) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n));
    const fill = pct === null ? t.border : pct >= 85 ? t.blocked : pct >= 60 ? t.working : t.accent;
    const icon = EFFORT_ICONS[effort];
    // The background hides the border under the label, so the line seems to run into it.
    return h_flex().id("chat-status").absolute().top(-8).right(16).h(14).max_w(220).px(6).gap(6).items_center()
      .bg(t.background).text_size(11).text_color(t.muted)
      .tooltip([model, effort && `effort ${effort}`, tokens && `${pct !== null ? `${Math.round(pct)}% · ` : ""}${size(tokens)}${window ? ` of ${size(window)}` : ""} context`].filter(Boolean).join(" · "))
      .when(Boolean(icon), (el) => el.child(div().flex_none().text_size(12).child(icon)))
      .child(div().min_w(0).truncate().child(model ? String(model).replace(/^Claude /, "") : ""))
      .when(pct !== null, (el) => el.child(div().flex_none().w(40).h(4).rounded(2).bg(t.border)
        .child(div().h_full().rounded(2).w(`${Math.max(3, Math.min(100, Math.round(pct)))}%`).bg(fill))))
      .when(pct === null && Boolean(tokens), (el) => el.child(div().flex_none().text_color(t.dim).child(size(tokens))));
  }

  stop(cx) {
    if (!this.terminal) return;
    sendRequest(this.terminal, { type: "abort" }).catch((e) => { this.sendError = String(e?.message ?? e); cx.notify(); });
  }

  /** omp's double Esc on an empty box: rewind past the last message you sent and put it back here. */
  rewind(cx) {
    const last = this.feed.items.findLast((i) => i.k === "user");
    if (!last || !this.terminal) return;
    const terminal = this.terminal;
    cx.spawn(async (cx) => {
      try {
        await send(terminal, `/omp-chat-rewind ${last.id}`);
        this.input.set_value(last.text);
        this.text = last.text;
        this.input.focus();
      } catch (e) {
        this.sendError = String(e?.message ?? e);
      }
      cx.notify();
    });
  }

  /** The chat's /resume: this project's sessions, newest first; picking one switches omp to it. */
  openPicker(cx) {
    const file = this.state?.sessionFile;
    if (!file) return;
    this.picker = { loading: true, list: [], error: null, sel: 0 };
    this.pickerSearch.set_value("");
    this.pickerSearch.focus();
    cx.spawn(async (cx) => {
      try {
        const r = await exec("bun", [HELPER, "--sessions", file.slice(0, file.lastIndexOf("/"))]);
        if (!this.picker) return;
        const list = JSON.parse(r.stdout);
        this.picker = { loading: false, list, error: null, sel: Math.max(0, list.findIndex((s) => s.path === file)) };
      } catch (e) {
        if (this.picker) this.picker = { loading: false, list: [], error: String(e?.message ?? e) };
      }
      cx.notify();
    });
    cx.notify();
  }

  closePicker(cx) {
    this.picker = null;
    this.input.focus();
    cx.notify();
  }

  resume(path, cx) {
    const terminal = this.terminal;
    this.closePicker(cx);
    if (!terminal || path === this.state?.sessionFile) return;
    cx.spawn(async (cx) => {
      try {
        await send(terminal, `/omp-chat-resume ${path}`);
      } catch (e) {
        this.sendError = String(e?.message ?? e);
      }
      cx.notify();
    });
  }

  /** The sessions the search keeps, in list order. */
  pickerList() {
    const query = this.pickerSearch.value().trim().toLowerCase();
    return (this.picker?.list ?? []).filter((s) => !query || s.title.toLowerCase().includes(query));
  }

  pickerPanel(t) {
    const list = this.pickerList();
    const sel = Math.min(this.picker.sel ?? 0, Math.max(0, list.length - 1));
    const ago = (ms) => {
      const m = Math.round((Date.now() - ms) / 60000);
      return m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
    };
    // omp titles start with an emoji or Nerd Font glyph stuck to the text: draw it in its own column.
    const ICON = /^(?:\p{Extended_Pictographic}|[\u2190-\u2BFF\uE000-\uF8FF]|[\u{F0000}-\u{10FFFD}])\uFE0F?/u;
    const row = (s, i) => {
      const current = s.path === this.state?.sessionFile;
      const icon = ICON.exec(s.title)?.[0] ?? "";
      return h_flex().w_full().h(34).px(10).gap(10).items_center().rounded(7).text_size(13)
        .when(i === sel, (el) => el.bg(t.hover)).when(current && i !== sel, (el) => el.bg(t.selected))
        .child(div().w(16).flex_none().text_color(t.muted).child(icon))
        .child(div().flex_1().truncate().text_color(t.foreground).child(s.title.slice(icon.length).trim()))
        .child(div().flex_none().text_size(11.5).text_color(t.dim).child(current ? "current" : ago(s.mtime)));
    };
    return v_flex().absolute().inset_0().bg(t.background).p(16).gap(10)
      .child(h_flex().items_center().gap(8)
        .child(div().flex_1().font_semibold().text_size(14).child("Resume a session"))
        .child(div().text_size(11).text_color(t.dim).child("↑↓ ⏎ · Esc"))
        .child(h_flex().id("picker-close").size(24).items_center().justify_center().rounded(6).cursor_pointer()
          .hover((s) => s.bg(t.hover)).text_color(t.muted).on_click((_e, cx) => this.closePicker(cx)).child("✕")))
      .child(div().key_context(LIST_CONTEXT)
        .on_action("omp_chat_list_up", (_e, cx) => this.listKey("up", cx))
        .on_action("omp_chat_list_down", (_e, cx) => this.listKey("down", cx))
        .child(Input.new(this.pickerSearch).h(32).px(10).rounded(8).border_1().border_color(t.input).bg(t.background).text_size(13)))
      .when(this.picker.loading, (el) => el.child(div().p(8).text_size(12.5).text_color(t.dim).child("Loading…")))
      .when(Boolean(this.picker.error), (el) => el.child(div().p(8).text_size(12.5).text_color(t.blocked).child(this.picker.error)))
      .child(div().flex_1().min_h(0).relative()
        .child(v_virtual_list("picker-list", list.length, 36, (i) => list[i].path, (range) => {
          const out = [];
          for (let i = range.start; i < range.end; i++) out.push(div().h(36).pb(2).child(row(list[i], i)));
          return out;
        }).track_scroll(this.pickerScroll).size_full().on_item_click((path, cx) => this.resume(path, cx)))
        .child(Scrollbar.vertical("picker-list").absolute().inset_0()));
  }

  /**
   * A key for whichever list is open: the /resume picker (↑ ↓ Enter Esc) or the / commands (↑ ↓
   * Tab). Reached as key bindings while the text box has the keyboard, else from on_key_down.
   * Answers whether a list took it.
   */
  listKey(key, cx) {
    if (this.picker) {
      const list = this.pickerList();
      const sel = Math.min(this.picker.sel ?? 0, Math.max(0, list.length - 1));
      if (key === "escape") this.closePicker(cx);
      else if (key === "down" || key === "up") {
        this.picker.sel = list.length ? (sel + (key === "down" ? 1 : list.length - 1)) % list.length : 0;
        this.pickerScroll.scroll_to_item(this.picker.sel);
      } else if (key === "enter" && list[sel]) this.resume(list[sel].path, cx);
      else return false;
      cx.notify();
      return true;
    }
    const shown = this.completions();
    if (!shown.length) return false;
    const sel = Math.min(this.sel, shown.length - 1);
    if (key === "down") this.sel = (sel + 1) % shown.length;
    else if (key === "up") this.sel = (sel + shown.length - 1) % shown.length;
    else if (key === "tab") this.accept(shown[sel], cx);
    else return false;
    cx.notify();
    return true;
  }

  key(e, cx) {
    if (this.picker) {
      if (this.listKey(e.key, cx)) cx.stop_propagation();
      return;
    }
    if (e.keystroke === "ctrl-enter") {
      if (this.enterInserted()) this.text = this.before;
      this.submit(cx, { followUp: true });
    } else if (e.key === "escape") {
      if (this.completions().length) this.dismissed = true;
      else if (this.working) this.stop(cx);
      else if (this.text.trim()) this.lastEsc = 0; // as in omp, Esc never throws a draft away
      else if (Date.now() - (this.lastEsc ?? 0) < 500) {
        this.lastEsc = 0;
        this.rewind(cx);
      } else this.lastEsc = Date.now();
    } else if (this.listKey(e.key, cx)) return cx.stop_propagation();
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  render(cx) {
    const t = theme();
    const mono = settings().font_family ?? "JetBrains Mono";
    // Figures (svg, charts) are drawn in the theme's colors: a theme change re-renders them.
    const palette = JSON.stringify({
      fg: t.foreground, muted: t.muted, border: t.border, surface: t.selected, accent: t.accent,
      success: t.ansi2, warning: t.ansi3, error: t.ansi1,
      c1: t.ansi4, c2: t.ansi3, c3: t.ansi2, c4: t.ansi5, c5: t.ansi1, c6: t.ansi6,
    });
    if (palette !== this.paletteKey) {
      this.paletteKey = palette;
      if (this.state?.sessionFile) cx.spawn(async (cx) => this.loadFeed(cx));
    }
    const zoom = settings().zoom ?? 1;
    this.working = this.isWorking();
    const root = v_flex().id("omp-chat").size_full().min_h(0).bg(t.background).text_color(t.foreground)
      .track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .on_size_change((size, cx) => {
        const width = Math.round(size.width / zoom);
        if (width === this.width) return;
        this.width = width;
        this.heights.clear();
        cx.notify();
      });
    if (!this.terminal) {
      return root.items_center().justify_center().text_size(13).text_color(t.dim).child("This chat pane has no omp.");
    }
    if (!this.state && this.loaded) {
      return root.items_center().justify_center().gap(8).text_size(13).text_color(t.dim)
        .child(`omp in ${this.terminal} isn't running the chat bridge (or has ended).`)
        .child(h_flex().id("chat-gone-close").px(10).py(5).rounded(7).border_1().border_color(t.input).cursor_pointer()
          .hover((s) => s.bg(t.hover)).text_color(t.foreground)
          .on_click(() => { const pane = this.myPane(); if (pane) run("pane.close", { pane }); })
          .child("Close pane"));
    }
    // Rows are markdown of unknown height: each is measured once, off screen, at the list's width,
    // so the virtual list knows every row's height and can be scrolled to the newest one. Until a
    // changed row (or every row, after a resize) is measured again, it keeps its last height:
    // a row at 0 would collapse the list and throw the scroll position.
    const rows = this.rows();
    const keyOf = (r) => `${r.id}|${this.open.has(r.id) ? 1 : 0}|${(r.text?.length ?? r.part?.text?.length ?? 0) + (r.output?.length ?? 0)}|${r.done ? 1 : 0}|${r.id === "__older" && (this.loading || this.olderWait) ? 1 : 0}|${r.parts?.length ?? 0}|${r.tools?.length ?? 0}|${r.tools?.some((x) => !x.done) ? 1 : 0}`;
    const keys = rows.map(keyOf);
    const sizes = keys.map((k, i) => this.heights.get(k) ?? this.lastHeight.get(rows[i].id) ?? 0);
    // All at once, and only at the real width: rows measured a few per frame, or at a guessed
    // width, change height under the reader and the list jumps.
    // A row stays in the measurer until its height has held for MEASURE_SETTLE_MS: a long answer's
    // markdown is laid out after its first frame, so its first height is only its padding.
    const now = Date.now();
    for (const [k, at] of this.measuredAt) if (now - at >= MEASURE_SETTLE_MS) this.measuredAt.delete(k);
    const missing = this.width ? rows.map((r, i) => [r, keys[i]]).filter(([, k]) => !this.heights.has(k) || this.measuredAt.has(k)) : [];
    const signature = `${rows.length}|${sizes.reduce((a, b) => a + b, 0)}`;
    if (signature !== this.signature) {
      this.signature = signature;
      if (this.follow && this.scrollTo === null) this.scrollTo = "bottom";
    }
    if (this.scrollTo !== null && rows.length) {
      if (this.scrollTo === "bottom") this.scroll.scroll_to_bottom();
      else this.scroll.scroll_to_item(this.scrollTo, "top");
      this.scrollTo = null;
    }
    // After "Earlier messages" loaded, the row holding the item that was on top stays there until
    // the rows added above it have their heights.
    if (this.pin) {
      const at = rows.findIndex((r) => r.id === this.pin || r.tools?.some((x) => x.id === this.pin));
      if (at >= 0) this.scroll.scroll_to_item(at, "top");
      if (at < 0 || !keys.slice(0, at).some((k) => !this.heights.has(k))) this.pin = null;
    }
    // The renderer runs twice per frame: first for one row to measure (always from 0), then for
    // the rows on screen. The last call says what is shown, so the top counts only when it is.
    const feed = v_virtual_list("omp-chat-feed", rows.length, sizes, (i) => rows[i].id, (range) => {
      this.olderShown = range.start === 0;
      const out = [];
      for (let i = range.start; i < range.end; i++) out.push(div().w_full().h(sizes[i]).overflow_hidden().px(FEED_PAD).child(this.item(rows[i], t, mono)));
      return out;
    })
      .track_scroll(this.scroll).size_full()
      .on_item_click((key, cx) => this.clickRow(key, cx));
    const measurer = div().id("omp-chat-measure").absolute().left(0).top(0).w(this.width ?? 0).h(0).overflow_hidden()
      .child(v_flex().w(this.width ?? 0).children(missing.map(([r, k]) => div().id(`ms-${k}`).w_full().px(FEED_PAD)
        .on_size_change((size, cx) => {
          const h = Math.ceil(size.height / zoom);
          this.lastHeight.set(r.id, h);
          if (this.heights.get(k) === h) return;
          this.heights.set(k, h);
          this.measuredAt.set(k, Date.now());
          // Drops the row from the measurer once its height has held.
          cx.timer.after(MEASURE_SETTLE_MS, (cx) => cx.notify());
          cx.notify();
        })
        .child(this.item(r, t, mono)))));
    return root
      .child(div().id("feed-wrap").flex_1().min_h(0).relative()
        .on_mouse_down("left", (e) => { this.pressX = e.local_position ? e.local_position.x / (settings().zoom ?? 1) : null; })
        .on_scroll_wheel((e, cx) => {
          this.lastWheel = Date.now();
          if (e.delta.y > 0) {
            if (this.follow) { this.follow = false; cx.notify(); }
            if (this.olderShown && !this.olderWait && this.feed.start > 0) this.awaitOlder(cx);
          }
        })
        .child(measurer)
        .child(feed)
        .child(Scrollbar.vertical("omp-chat-feed").absolute().inset_0())
        .when(!this.feed.items.length && !this.working && !this.sent.length, (el) => el.child(div().absolute().inset_0().flex().items_center().justify_center().text_size(13).text_color(t.dim)
          .child(this.feedError ? `Couldn't read the session: ${this.feedError}` : this.state?.sessionFile || this.state?.welcome ? this.welcome(t, mono) : "Loading…")))
        .when(!this.follow, (el) => el.child(h_flex().id("latest").absolute().bottom(10).right(20).size(26).items_center().justify_center()
          .rounded(13).bg(t.raised).border_1().border_color(t.border).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.follow = true; this.scrollTo = "bottom"; cx.notify(); })
          .child(svg("mods/omp-chat/arrow-down.svg").size(13).text_color(t.muted))))
        .when(Boolean(this.picker), (el) => el.child(this.pickerPanel(t))))
      .child(v_flex().w_full().flex_none().px(16).pt(8).pb(12).gap(8).border_t(1).border_color(t.border)
        .children(this.pending.map((card) => (card.kind === "ask" ? this.askCard(card, t) : this.approvalCard(card, t, mono))))
        .child(this.reply(t, mono)));
  }
}
