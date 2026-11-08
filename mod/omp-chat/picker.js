// The chat's /resume: this project's sessions, newest first, over the feed; picking one switches
// omp to it.
import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, VirtualListScrollHandle, v_virtual_list } from "gpui-base";
import { exec } from "herdr";
import { HELPER, LIST_CONTEXT } from "./common.js";
import { SESSION_ICON } from "./omp-chat-shared.js";

export class Picker {
  /** `done(path, cx)`: the picker closed, on the session picked (null: none). */
  constructor(done) {
    this.done = done;
    this.shown = null; // { loading, list, error, sel } while open
    this.search = InputState.new({ placeholder: "Search sessions…" });
    this.search.on("change", (_e, cx) => {
      if (this.shown) this.shown.sel = 0;
      cx.notify();
    });
    this.scroll = VirtualListScrollHandle.new();
  }

  /** Opens on the sessions in `dir`, with `current` (the one omp shows) selected. */
  open(dir, current, cx) {
    const shown = (this.shown = { loading: true, list: [], error: null, sel: 0 });
    this.search.set_value("");
    this.search.focus();
    cx.spawn(async (cx) => {
      try {
        const r = await exec("bun", [HELPER, "--sessions", dir]);
        if (this.shown !== shown) return;
        if (r.code !== 0) throw new Error(r.stderr.trim() || `transcript helper exited ${r.code}`);
        const list = JSON.parse(r.stdout);
        Object.assign(shown, { loading: false, list, sel: Math.max(0, list.findIndex((s) => s.path === current)) });
      } catch (e) {
        if (this.shown === shown) Object.assign(shown, { loading: false, error: String(e?.message ?? e) });
      }
      cx.notify();
    });
    cx.notify();
  }

  close(path, cx) {
    this.shown = null;
    this.done(path, cx);
  }

  /** The sessions the search keeps, in list order. */
  list() {
    const query = this.search.value().trim().toLowerCase();
    return this.shown.list.filter((s) => !query || s.title.toLowerCase().includes(query));
  }

  /**
   * ↑ ↓ Enter Esc: reached as key bindings while the search box has the keyboard, else from the
   * chat's on_key_down. Answers whether it took the key.
   */
  key(key, cx) {
    if (!this.shown) return false; // a key still on its way after the picker closed
    const list = this.list();
    const sel = Math.min(this.shown.sel, Math.max(0, list.length - 1));
    if (key === "escape") this.close(null, cx);
    else if (key === "down" || key === "up") {
      this.shown.sel = list.length ? (sel + (key === "down" ? 1 : list.length - 1)) % list.length : 0;
      this.scroll.scroll_to_item(this.shown.sel);
    } else if (key === "enter" && list[sel]) this.close(list[sel].path, cx);
    else return false;
    cx.notify();
    return true;
  }

  render(t, current) {
    const list = this.list();
    const sel = Math.min(this.shown.sel, Math.max(0, list.length - 1));
    const ago = (ms) => {
      const m = Math.round((Date.now() - ms) / 60000);
      return m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
    };
    const row = (s, i) => {
      const here = s.path === current;
      // omp titles start with an emoji or Nerd Font glyph stuck to the text: drawn in its own column.
      const icon = SESSION_ICON.exec(s.title)?.[0] ?? "";
      return h_flex().w_full().h(34).px(10).gap(10).items_center().rounded(7).text_size(13)
        .when(i === sel, (el) => el.bg(t.hover)).when(here && i !== sel, (el) => el.bg(t.selected))
        .child(div().w(16).flex_none().text_color(t.muted).child(icon))
        .child(div().flex_1().truncate().text_color(t.foreground).child(s.title.slice(icon.length).trim()))
        .child(div().flex_none().text_size(11.5).text_color(t.dim).child(here ? "current" : ago(s.mtime)));
    };
    return v_flex().absolute().inset_0().bg(t.background).p(16).gap(10)
      .child(h_flex().items_center().gap(8)
        .child(div().flex_1().font_semibold().text_size(14).child("Resume a session"))
        .child(div().text_size(11).text_color(t.dim).child("↑↓ ⏎ · Esc"))
        .child(h_flex().id("picker-close").size(24).items_center().justify_center().rounded(6).cursor_pointer()
          .hover((s) => s.bg(t.hover)).text_color(t.muted).on_click((_e, cx) => this.close(null, cx)).child("✕")))
      .child(div().key_context(LIST_CONTEXT)
        .on_action("omp_chat_list_up", (_e, cx) => this.key("up", cx))
        .on_action("omp_chat_list_down", (_e, cx) => this.key("down", cx))
        .child(Input.new(this.search).h(32).px(10).rounded(8).border_1().border_color(t.input).bg(t.background).text_size(13)))
      .when(this.shown.loading, (el) => el.child(div().p(8).text_size(12.5).text_color(t.dim).child("Loading…")))
      .when(Boolean(this.shown.error), (el) => el.child(div().p(8).text_size(12.5).text_color(t.blocked).child(this.shown.error)))
      .child(div().flex_1().min_h(0).relative()
        .child(v_virtual_list("picker-list", list.length, 36, (i) => list[i].path, (range) => {
          const out = [];
          for (let i = range.start; i < range.end; i++) out.push(div().h(36).pb(2).child(row(list[i], i)));
          return out;
        }).track_scroll(this.scroll).size_full().on_item_click((path, cx) => this.close(path, cx)))
        .child(Scrollbar.vertical("picker-list").absolute().inset_0()));
  }
}
