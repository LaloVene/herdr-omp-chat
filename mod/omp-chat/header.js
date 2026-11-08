// The panes' header in the omp-chat layout: Herdr's shipped `pane` header (program icon, name,
// folder, agent status; split, zoom and close on hover), plus, on an omp pane and on a chat pane,
// the chat / terminal / btw buttons. Props from the app: { pane, terminal }.
import { div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, terminals, props, run, theme, nextCommand } from "herdr";
import { loadStates, watchRoot, chatPanes } from "./channel.js";
import { toChat, toTerminal, BTW_BLOCK } from "./view.js";
import { programIcon } from "./omp-chat-shared.js";
import { folder } from "./common.js";

/** Chat, terminal and btw as small icon buttons; `view` is the pane's mode. */
function viewButtons(t, id, view, state, toggle) {
  const button = (key, icon, on, color, action) => h_flex().id(`${key}-${id}`).h(22).px(6).flex_none().items_center().justify_center().rounded(5)
    .cursor_pointer().when(on, (el) => el.bg(t.selected)).when(!on, (el) => el.hover((s) => s.bg(t.hover)))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => { cx.stop_propagation(); action(cx); })
    .child(svg(`mods/omp-chat/${icon}.svg`).size(14).text_color(color ?? (on ? t.foreground : t.muted)));
  return h_flex().flex_none().gap(2).items_center()
    .child(button("seg-chat", "chat", view === "chat", null, (cx) => view !== "chat" && toggle(cx)))
    .child(button("seg-term", "terminal", view === "terminal", null, (cx) => view !== "terminal" && toggle(cx)))
    .child(div().w(1).h(14).mx(2).bg(t.border))
    .child(button("seg-btw", "btw", false, state?.btwRunning ? t.working : null, () => run("layout.toggle", { id: BTW_BLOCK })));
}

export class Header {
  init(cx) {
    this.alive = true;
    this.hovered = false;
    this.states = {};
    watchRoot(cx, () => this.alive, async (_changed, cx) => { this.states = await loadStates(); cx.notify(); });
    cx.spawn(async (cx) => { this.states = await loadStates(); cx.notify(); });
    // A chat pane shows its parked omp's status, which changes without redrawing this header.
    cx.timer.every(1000, (cx) => {
      const p = this.me();
      if (p && this.omp(p)?.view === "chat") cx.notify();
    });
    // ⌘J: the focused pane's header switches it between chat and terminal.
    cx.spawn(async (cx) => {
      while (this.alive) {
        const command = await nextCommand();
        const p = this.me();
        const omp = p && this.omp(p);
        if (command === "toggle" && p?.focused && omp) this.toggle(p, omp, cx);
        cx.notify();
      }
    });
  }

  /** The omp this pane shows: its own terminal running the bridge, or the one a chat pane stands for. */
  omp(p) {
    if (p.terminal) return this.states[p.terminal] && !p.program?.shell ? { terminal: p.terminal, view: "terminal" } : null;
    const terminal = chatPanes()[p.pane];
    return terminal ? { terminal, view: "chat" } : null;
  }

  toggle(p, omp, cx) {
    if (omp.view === "terminal") toChat(p.pane, omp.terminal, cx);
    else toTerminal(p.pane, omp.terminal, cx);
  }

  close() {
    this.alive = false;
  }

  me() {
    return panes().find((p) => p.pane === props()?.pane);
  }

  button(t, id, name, action) {
    return div().id(id).p(3).rounded(4).text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { cx.stop_propagation(); action(cx); })
      .child(svg(`mods/pane/${name}.svg`).size(14));
  }

  render() {
    const t = theme();
    const p = this.me();
    if (!p) return div();
    const omp = this.omp(p);
    const chat = omp?.view === "chat";
    const state = omp ? this.states[omp.terminal] : null;
    const name = chat ? "omp" : ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";
    const pic = chat ? svg("mods/omp-chat/chat.svg").size(14).flex_none().text_color(t.dim) : programIcon(p.program, 14, t.dim);
    // A chat pane's omp is parked: its status is Herdr's for that terminal, as in the terminal view.
    const st = chat ? (terminals().find((x) => x.address === omp.terminal)?.status ?? (state?.busy ? "working" : null)) : p.status;
    const pane = p.pane;
    // A chat pane's ✕ ends its omp the way a terminal pane's does: back to the terminal, then close that.
    const close = chat
      ? (cx) => toTerminal(pane, omp.terminal, cx, { thenClose: true })
      : () => run("pane.close", { pane });
    return h_flex().id(`pane-head-${pane}`).size_full().px(10).gap(8).items_center().bg(t.background)
      .border_b(1).border_color(t.border).text_size(12)
      .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .on_click(() => run("pane.focus", { pane }))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_none().truncate().max_w(260).font_medium().text_color(t.foreground).child(name))
      .child(div().flex_1().truncate().text_color(t.dim).child(folder(chat ? state?.cwd : p.cwd)))
      .when(st === "working", (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
      .when(st === "blocked", (el) => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).child("Needs you")))
      .when(st === "done", (el) => el.child(div().size(7).flex_none().rounded(4).bg(t.done)))
      // Shown on hover, like Herdr's own split / zoom / close buttons.
      .when(Boolean(omp) && this.hovered, (el) => el.child(viewButtons(t, pane, omp.view, state, (cx) => this.toggle(p, omp, cx))))
      .when(this.hovered, (el) => el
        .child(this.button(t, `ph-r-${pane}`, "split-right", () => run("pane.split", { direction: "right", pane })))
        .child(this.button(t, `ph-d-${pane}`, "split-down", () => run("pane.split", { direction: "down", pane })))
        .child(this.button(t, `ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", () => run("pane.zoom", { pane })))
        .child(this.button(t, `ph-x-${pane}`, "close", close)));
  }
}
