// The chat: the omp session of the shown tab as a conversation, its open approval and ask cards
// (cards.js), and a reply box that sends prompts and slash commands (composer.js). This file
// follows the bridge and the transcript, streams the answer omp is writing, and lays the rows
// (rows.js) out in a measured virtual list.
import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex, TextView, Scrollbar, VirtualListScrollHandle, v_virtual_list } from "gpui-base";
import { exec, appHome, focused, panes, terminals, theme, settings, watchFolder, nextCommand, props, run, shared, setShared, readTextFile } from "herdr";
import { ROOT, dirOf, readJson, watchRoot, chatPanes, setChatPanes, forgetChatPane } from "./channel.js";
import { wait } from "./answer.js";
import { toTerminal } from "./view.js";
import { SEEN_KEY } from "./omp-chat-shared.js";
import { HELPER, COPY_BUTTON, CopyButtons, bindListKeys } from "./common.js";
import { feedRows, drawRow } from "./rows.js";
import { Cards } from "./cards.js";
import { Composer } from "./composer.js";

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
// The feed rows' side padding.
const FEED_PAD = 20;

export class Chat {
  init(cx) {
    this.alive = true;
    bindListKeys(cx);
    // A chat pane shows one omp for its whole life: the terminal its pane stands for.
    this.terminal = props()?.terminal ?? null;
    this.state = null;
    this.feed = { total: 0, start: 0, items: [] };
    this.limit = PAGE;
    this.open = new Set();
    this.follow = true;
    this.gen = 0;
    this.scrollTo = null;
    this.heights = new Map();
    this.lastHeight = new Map();
    this.measuredAt = new Map(); // row key → when its measured height last changed
    this.rows = []; // the rows last drawn, which clicks and the earlier page go by
    this.sent = []; // messages sent from here that the transcript doesn't hold yet
    this.working = false;
    this.stream = null; // { id, blocks, done } the bridge last wrote, and when it was read (`at`)
    this.copyButtons = new CopyButtons();
    this.cards = new Cards(this.terminal, (cx) => this.showTerminal(cx));
    this.composer = new Composer(this);
    this.scroll = VirtualListScrollHandle.new();
    this.handle = cx.focus_handle();
    // Every second: Herdr's status for the terminal changes without telling the chat, and
    // watchFolder can stay silent while omp appends to the session file (seen on macOS): while omp
    // works or a sent message waits, and once more after, re-read the transcript.
    cx.timer.every(1000, (cx) => {
      if (!this.alive) return;
      const working = this.isWorking();
      this.markSeen();
      const active = working || this.sent.length > 0;
      if (this.state?.sessionFile && (active || this.wasActive)) cx.spawn(async (cx) => { await this.loadFeed(cx); cx.notify(); });
      else if (working !== this.working) cx.notify();
      this.wasActive = active;
    });
    // `focus`: pane.go (or a closed popup) hands this pane the keyboard. ⌘J is the pane header's.
    cx.spawn(async (cx) => {
      while (this.alive) {
        const command = await nextCommand();
        if (command === "focus") this.composer.box.input.focus();
        cx.notify();
      }
    });
    watchRoot(cx, () => this.alive, (changed, cx) => this.rootChanged(changed, cx));
    const own = props()?.pane;
    if (own && this.terminal && chatPanes()[own] !== this.terminal) setChatPanes({ ...chatPanes(), [own]: this.terminal });
    if (this.terminal) cx.spawn(async (cx) => { await this.loadChannel(cx); cx.notify(); });
    if (this.terminal) this.watchStream(cx);
    if (this.myPane() && panes().find((p) => p.pane === this.myPane())?.focused) this.composer.box.input.focus();
  }

  /** This chat pane's id: from the app's props, else the pane map. */
  myPane() {
    return props()?.pane ?? Object.entries(chatPanes()).find(([, t]) => t === this.terminal)?.[0] ?? null;
  }

  /** This pane's tab (null: none), and whether it's the tab on screen. */
  myTab() {
    const id = panes().find((p) => p.pane === this.myPane())?.tab ?? null;
    return { id, shown: id !== null && id === focused()?.tab };
  }

  /** Back to omp's terminal, in this pane's place. */
  showTerminal(cx) {
    const pane = this.myPane();
    if (pane && this.terminal) toTerminal(pane, this.terminal, cx);
  }

  close() {
    this.alive = false;
    this.gen++;
    // The pane went without passing back to the terminal (its tab closed): end the parked omp
    // with it, as closing the tab would have. On quit the pane still exists, and nothing happens.
    const pane = this.myPane();
    if (this.terminal && pane && !panes().some((p) => p.pane === pane) && forgetChatPane(pane, this.terminal)) {
      run("terminal.kill", { terminal: this.terminal });
    } else if (this.terminal) this.composer.saveDraft();
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
   * The answer omp is writing, until the transcript holds it, as a text row, else null. A finished
   * one shows a few seconds at most, so an answer the transcript never matches doesn't linger.
   */
  liveStream() {
    const s = this.stream;
    const last = s?.blocks.at(-1)?.trim();
    if (!last || !(s.done ? Date.now() - s.at < STREAM_GRACE_MS : this.working)) return null;
    if (this.feed.items.some((i) => i.k === "text" && i.text.trim() === last)) return null;
    return { k: "text", id: `stream:${s.id}`, text: s.blocks.join("\n\n") };
  }

  // --- data ---------------------------------------------------------------------------------

  async rootChanged(changed, cx) {
    if (!this.terminal) return;
    const mine = dirOf(this.terminal);
    if (!changed.some((p) => p === ROOT || p === `${ROOT}/` || p === mine || p.startsWith(`${mine}/`))) return;
    await this.loadChannel(cx);
    cx.notify();
  }

  async loadChannel(cx) {
    const dir = dirOf(this.terminal);
    const [state, pending, commands] = await Promise.all([
      readJson(`${dir}/state.json`),
      readJson(`${dir}/pending.json`),
      readJson(`${dir}/commands.json`),
    ]);
    const fileChanged = state?.sessionFile !== this.state?.sessionFile;
    // The feed follows the session file by itself; state only matters to it when /tree or a rewind moved the leaf.
    const leafChanged = JSON.stringify(state?.leaf ?? null) !== JSON.stringify(this.state?.leaf ?? null);
    this.state = state;
    this.loaded = true;
    this.cards.update(pending, this.myTab());
    if (Array.isArray(commands)) this.composer.commands = commands;
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
    // The session's folder, which /resume lists too.
    const dir = (this.sessionDir = file ? file.slice(0, file.lastIndexOf("/")) : null);
    if (!file) return;
    cx.spawn(async (cx) => {
      await this.loadFeed(cx);
      while (this.alive && gen === this.gen) {
        let changed;
        try {
          changed = await watchFolder(dir);
        } catch {
          // A new session's folder appears with its first message: look again in a second.
          await wait(cx, 1000);
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
        if (file !== this.state?.sessionFile) continue;
        if (r.code !== 0) throw new Error(r.stderr.trim() || `transcript helper exited ${r.code}`);
        const before = this.feed;
        const feed = (this.feed = JSON.parse(r.stdout));
        // Sent messages wait for the transcript (a message of theirs at or past where it ended when
        // they were sent), or two minutes (omp never took it).
        this.sent = this.sent.filter((s) => Date.now() - s.at < 120000
          && !feed.items.some((i, n) => feed.start + n >= s.base && i.k === "user" && i.text.trim() === s.text));
        if (pin) this.pin = pin;
        this.feedError = null;
        const grew = feed.items.at(-1)?.id !== before.items.at(-1)?.id || feed.total !== before.total;
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
    const top = this.rows.find((r) => r.id !== "__older");
    const anchor = top?.tools?.at(-1)?.id ?? top?.id;
    this.limit += PAGE;
    this.follow = false;
    this.loadingOlder = true;
    cx.spawn(async (cx) => {
      await this.loadFeed(cx, anchor);
      this.loadingOlder = false;
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
    if (seen[this.terminal] === term.turn || !this.myTab().shown) return;
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

  // --- view ---------------------------------------------------------------------------------

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
      const row = this.rows.find((r) => r.id === key);
      if (row) this.copyButtons.copy(key, row.text, cx);
      return;
    }
    const row = key.startsWith("work:") ? { k: "work" } : this.feed.items.find((i) => i.id === key);
    if (!row || !["work", "tool", "compact"].includes(row.k)) return;
    if (this.open.has(key)) this.open.delete(key);
    else this.open.add(key);
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
      .track_focus(this.handle)
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
    const rows = (this.rows = feedRows(this.feed, this.open, this.sent, this.liveStream(), this.working));
    const v = {
      t, mono, width: Math.max(200, (this.width ?? 700) - 48), open: this.open,
      olderLoading: this.loadingOlder || this.olderWait, copyButtons: this.copyButtons, waiting: this.cards.list.length > 0,
    };
    const keyOf = (r) => `${r.id}|${this.open.has(r.id) ? 1 : 0}|${(r.text?.length ?? r.part?.text?.length ?? 0) + (r.output?.length ?? 0)}|${r.done ? 1 : 0}|${r.id === "__older" && v.olderLoading ? 1 : 0}|${r.parts?.length ?? 0}|${r.tools?.length ?? 0}|${r.tools?.some((x) => !x.done) ? 1 : 0}`;
    const keys = rows.map(keyOf);
    // Heights are kept for the rows as they are now: a changed row's earlier keys would pile up.
    const live = new Set(keys);
    for (const k of this.heights.keys()) if (!live.has(k)) this.heights.delete(k);
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
      for (let i = range.start; i < range.end; i++) out.push(div().w_full().h(sizes[i]).overflow_hidden().px(FEED_PAD).child(drawRow(rows[i], v)));
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
        .child(drawRow(r, v)))));
    const picker = this.composer.picker;
    return root.on_key_down((e, cx) => { if (this.composer.key(e, cx)) cx.stop_propagation(); })
      .child(div().id("feed-wrap").flex_1().min_h(0).relative()
        .on_mouse_down("left", (e) => { this.pressX = e.local_position ? e.local_position.x / zoom : null; })
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
        .when(Boolean(picker.shown), (el) => el.child(picker.render(t, this.state?.sessionFile))))
      .child(v_flex().w_full().flex_none().px(16).pt(8).pb(12).gap(8).border_t(1).border_color(t.border)
        .children(this.cards.render(t, this.state?.cwd))
        .child(this.composer.render(t, mono)));
  }
}
