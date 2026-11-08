// The reply box: sends prompts (through the bridge) and slash commands (typed into omp), offers the
// / commands and `@` files as you type, and shows omp's status line in its top border. /resume
// opens the chat's own session picker. A draft outlives the pane (chat ⇄ terminal flips close it).
import { div } from "gpui-kit";
import { v_flex, h_flex, Textarea } from "gpui-base";
import { exec, shared, setShared } from "herdr";
import { send, sendRequest } from "./channel.js";
import { LIST_CONTEXT, ReplyBox } from "./common.js";
import { Picker } from "./picker.js";

// Unsent text per terminal: { [terminal]: text }.
const DRAFTS_KEY = "omp-chat.drafts";
// The `@` file token ending at the caret, as omp's editor finds it: `@path` or `@"path with spaces`.
// omp reads a sent `@path` that names an existing file or folder into the turn.
const MENTION = /(?:^|[\s([{<"'`])(@(?:"[^"]*|[^\s@"]*))$/;
const FILES_TTL_MS = 30000;
const FILES_MAX = 50000;
// The omp folders' files and folders for `@`, shared by every chat pane: { [cwd]: { at, list, loading } }.
const files = new Map();

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
// omp's reasoning-effort icons (its Unicode symbol set; its Nerd Font set draws the same circles).
const EFFORT_ICONS = { minimal: "○", low: "◔", medium: "◑", high: "◒", xhigh: "◕", max: "◉" };

export class Composer {
  /**
   * `chat`: the chat it writes for. It reads the chat's `terminal`, `working`, `state`, `feed` and
   * `sessionDir`, shows a message it sends in `sent` (following the feed to the bottom), and calls
   * `showTerminal(cx)` after a command that opens a screen there.
   */
  constructor(chat) {
    this.chat = chat;
    this.commands = []; // commands.json: the session's / commands
    this.sel = 0;
    this.dismissed = false;
    this.error = null;
    this.lastEsc = 0;
    this.caret = 0; // where typing happened last: the box can't say where its cursor is
    this.box = new ReplyBox({
      placeholder: "Message omp…",
      maxRows: 8,
      onChange: (cx) => {
        this.sel = 0;
        this.dismissed = false;
        this.error = null;
        this.caret = caretAfter(this.box.before, this.box.text);
        if (MENTION.test(this.box.text.slice(0, this.caret))) this.listFiles(cx);
        cx.notify();
      },
      onSubmit: (e, cx) => this.submit(cx, { followUp: e.secondary === true }),
    });
    const draft = (shared(DRAFTS_KEY) ?? {})[chat.terminal];
    if (draft) {
      this.box.set(draft);
      this.caret = draft.length;
      this.box.input.set_selected_range({ start: this.caret, end: this.caret });
    }
    this.picker = new Picker((path, cx) => this.resume(path, cx));
  }

  /** Keeps the unsent text for the next chat pane of this terminal. */
  saveDraft() {
    const { [this.chat.terminal]: _old, ...drafts } = shared(DRAFTS_KEY) ?? {};
    const text = this.box.text;
    setShared(DRAFTS_KEY, text.trim() ? { ...drafts, [this.chat.terminal]: text } : drafts);
  }

  /**
   * The list under the box: / commands while a bare command is typed, else the files for the `@`
   * token at the caret. Each item replaces `start`–`end` with `value`; `exact`: already typed.
   */
  completions() {
    if (this.dismissed) return [];
    const text = this.box.text;
    if (text.startsWith("/") && !/\s/.test(text)) {
      const q = text.slice(1).toLowerCase();
      const named = this.commands.filter((c) => c.name.toLowerCase().startsWith(q));
      const inside = this.commands.filter((c) => !c.name.toLowerCase().startsWith(q) && c.name.toLowerCase().includes(q));
      return [...named, ...inside].slice(0, 8).map((c) => ({
        id: `cmd-${c.name}`, label: `/${c.name}`, detail: c.description ?? "", start: 0, end: text.length,
        value: `/${c.name}${c.args === false ? "" : " "}`, exact: `/${c.name}` === text.trim(),
      }));
    }
    const token = MENTION.exec(text.slice(0, this.caret))?.[1];
    const list = token && files.get(this.chat.state?.cwd)?.list;
    if (!list) return [];
    return rankFiles(list, token.replace(/^@"?/, "").toLowerCase()).slice(0, 8).map((path) => {
      const dir = path.endsWith("/");
      // As omp's editor: quoted when it has a space, a space after a file, a folder stays open.
      const value = path.includes(" ") ? `@"${path}${dir ? "" : '"'}` : `@${path}`;
      return { id: `file-${path}`, label: path, detail: "", start: this.caret - token.length, end: this.caret, value: dir ? value : `${value} ` };
    });
  }

  accept(item, cx) {
    const text = this.box.text;
    this.box.set(text.slice(0, item.start) + item.value + text.slice(item.end));
    this.caret = item.start + item.value.length;
    this.box.input.set_selected_range({ start: this.caret, end: this.caret });
    // A folder keeps its list open on what's inside; anything else closes it.
    this.dismissed = !item.value.endsWith("/");
    if (!this.dismissed) this.listFiles(cx);
    cx.notify();
  }

  /** Lists the omp's folder for `@` (`rg --files`: what git doesn't ignore), at most every 30s. */
  listFiles(cx) {
    const cwd = this.chat.state?.cwd;
    const cached = cwd && files.get(cwd);
    if (!cwd || (cached && (cached.loading || Date.now() - cached.at < FILES_TTL_MS))) return;
    files.set(cwd, { ...cached, loading: true });
    cx.spawn(async (cx) => {
      let list = cached?.list ?? [];
      try {
        const r = await exec("rg", ["--files", "--hidden", "--glob", "!.git"], { cwd });
        if (r.code === 0) list = withFolders(r.stdout.split("\n").filter(Boolean).slice(0, FILES_MAX));
      } catch {
        this.error = "@ files need ripgrep (rg)";
      }
      files.set(cwd, { at: Date.now(), list });
      cx.notify();
    });
  }

  /** Sends what's typed; `followUp`: after the running turn (omp's follow-up, Cmd/Ctrl+Enter). */
  submit(cx, { followUp = false } = {}) {
    const chat = this.chat;
    const shown = this.completions();
    const typed = this.box.text.trim();
    if (shown.length && !shown.some((c) => c.exact)) return this.accept(shown[Math.min(this.sel, shown.length - 1)], cx);
    if (!typed) return;
    this.box.set("");
    if (typed === "/resume") {
      // omp's /resume opens a picker in its terminal; the chat has its own.
      if (chat.state?.sessionFile) this.picker.open(chat.sessionDir, chat.state.sessionFile, cx);
      return;
    }
    chat.follow = true;
    // A message (not a command) shows at once; Chat.loadFeed drops it once the transcript has it.
    const command = typed.startsWith("/");
    const sent = command ? null : { id: `__sent-${Date.now()}`, text: typed, base: chat.feed.total, at: Date.now() };
    if (sent) {
      chat.sent.push(sent);
      chat.scrollTo = "bottom";
      cx.notify();
    }
    cx.spawn(async (cx) => {
      try {
        if (command) {
          await send(chat.terminal, typed);
          const [name, ...rest] = typed.slice(1).split(/\s+/);
          if (TERMINAL_BOUND.has(name) || (!rest.join("") && BARE_TERMINAL.has(name))) chat.showTerminal(cx);
        } else {
          await sendRequest(chat.terminal, { type: "prompt", text: typed, ...(followUp ? { followUp: true } : {}) });
        }
        chat.scrollTo = "bottom";
      } catch (e) {
        this.error = String(e?.message ?? e);
        chat.sent = chat.sent.filter((s) => s !== sent);
        this.box.set(typed);
      }
      cx.notify();
    });
  }

  stop(cx) {
    cx.spawn(async (cx) => {
      try {
        await sendRequest(this.chat.terminal, { type: "abort" });
      } catch (e) {
        this.error = String(e?.message ?? e);
        cx.notify();
      }
    });
  }

  /** omp's double Esc on an empty box: rewind past the last message you sent and put it back here. */
  rewind(cx) {
    const last = this.chat.feed.items.findLast((i) => i.k === "user");
    if (!last) return;
    cx.spawn(async (cx) => {
      try {
        await send(this.chat.terminal, `/omp-chat-rewind ${last.id}`);
        this.box.set(last.text);
        this.box.input.focus();
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      cx.notify();
    });
  }

  /** The picker closed on `path` (null: none): omp switches to that session. */
  resume(path, cx) {
    this.box.input.focus();
    cx.notify();
    const chat = this.chat;
    if (!path || path === chat.state?.sessionFile) return;
    cx.spawn(async (cx) => {
      try {
        await send(chat.terminal, `/omp-chat-resume ${path}`);
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      cx.notify();
    });
  }

  /**
   * ↑ ↓ Tab for the / list: reached as key bindings while the text box has the keyboard, else
   * from key(). Answers whether the list took the key.
   */
  listKey(key, cx) {
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

  /**
   * A key the chat's on_key_down got: the picker's while it's open, else Ctrl+Enter, Esc or the
   * / list's. Answers whether it took the key.
   */
  key(e, cx) {
    if (this.picker.shown) return this.picker.key(e.key, cx);
    if (e.keystroke === "ctrl-enter") this.box.enter({ secondary: true }, cx);
    else if (e.key === "escape") {
      if (this.completions().length) this.dismissed = true;
      else if (this.chat.working) this.stop(cx);
      else if (this.box.text.trim()) this.lastEsc = 0; // as in omp, Esc never throws a draft away
      else if (Date.now() - this.lastEsc < 500) {
        this.lastEsc = 0;
        this.rewind(cx);
      } else this.lastEsc = Date.now();
    } else return this.listKey(e.key, cx);
    cx.notify();
    return true;
  }

  render(t, mono) {
    const chat = this.chat;
    const shown = this.completions();
    const sel = Math.min(this.sel, Math.max(0, shown.length - 1));
    const typed = Boolean(this.box.text.trim());
    return v_flex().w_full().gap(6).relative()
      .when(shown.length > 0, (el) => el.child(v_flex().w_full().p(4).rounded(10).border_1().border_color(t.border).bg(t.popover)
        .children(shown.map((c, i) => h_flex().id(c.id).px(8).py(5).gap(10).rounded(6).cursor_pointer()
          .when(i === sel, (el) => el.bg(t.hover)).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.accept(c, cx))
          .child(div().font_family(mono).text_size(12.5).text_color(t.foreground).truncate().when(Boolean(c.detail), (el) => el.flex_none()).when(!c.detail, (el) => el.flex_1()).child(c.label))
          .when(Boolean(c.detail), (el) => el.child(div().flex_1().truncate().text_size(12).text_color(t.dim).child(c.detail)))))))
      .when(Boolean(this.error), (el) => el.child(div().text_size(12).text_color(t.blocked).child(this.error)))
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
          .child(Textarea.new(this.box.input).w_full().text_size(13.5).text_color(t.foreground)))
        .when(chat.working, (el) => el.child(h_flex().id("stop").size(28).flex_none().items_center().justify_center().rounded(8)
          .bg(t.raised).border_1().border_color(t.input).text_color(t.foreground).text_size(11).cursor_pointer()
          .on_click((_e, cx) => this.stop(cx)).child("■")))
        .child(h_flex().id("send").size(28).flex_none().items_center().justify_center().rounded(8).bg(typed ? t.solid : t.raised)
          .text_color(typed ? t.solid_foreground : t.dim).cursor_pointer().on_click((_e, cx) => this.submit(cx)).child("↑")))
      .when(Boolean(chat.state?.model || chat.feed.status?.model), (el) => el.child(statusLine(t, chat.state ?? {}, chat.feed.status ?? {}))));
  }
}

/**
 * omp's status line, short, set into the reply box's top border at the right as omp's editor
 * does: the reasoning effort as omp's circle icon, the model, and how full the context is as a
 * small bar (the number on hover). Live from the bridge (`s`, state.json); from the last answer
 * in the transcript (`last`) when an older bridge doesn't report it.
 */
function statusLine(t, s, last) {
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

/** Where the caret is after `before` became `after`: the end of the part that changed. */
function caretAfter(before = "", after) {
  let p = 0;
  while (p < before.length && p < after.length && before[p] === after[p]) p++;
  let s = 0;
  while (s < before.length - p && s < after.length - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;
  return after.length - s;
}

/** Files plus every folder they're in (`dir/`), folders first. */
function withFolders(paths) {
  const dirs = new Set();
  for (const p of paths) for (let i = p.indexOf("/"); i > 0; i = p.indexOf("/", i + 1)) dirs.add(p.slice(0, i + 1));
  return [...dirs, ...paths];
}

/**
 * Paths for an `@` query, best first: name starts with it, path starts with it, contains it, has
 * its letters in order. No query: what's directly in the folder, or in the folder typed (`src/`).
 */
function rankFiles(list, q) {
  const name = (p) => p.replace(/\/$/, "").split("/").pop().toLowerCase();
  const children = (base) => list.filter((p) => p.startsWith(base) && !p.slice(base.length, -1).includes("/") && p !== base);
  if (!q || q.endsWith("/")) {
    const shown = children(q);
    if (shown.length || !q) return shown;
  }
  const tier = (p) => {
    const lower = p.toLowerCase();
    if (name(p).startsWith(q)) return 0;
    if (lower.startsWith(q)) return 1;
    if (lower.includes(q)) return 2;
    let i = 0;
    for (const ch of lower) if (ch === q[i]) i++;
    return i === q.length ? 3 : -1;
  };
  return list.map((p) => [p, tier(p)]).filter(([, n]) => n >= 0).sort(([a, x], [b, y]) => x - y || a.length - b.length).map(([p]) => p);
}
