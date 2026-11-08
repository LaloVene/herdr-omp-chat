// Chat ⇄ terminal, per pane. A pane in chat mode is a mod pane (`omp-chat`, view "chat") in the
// terminal pane's place; the omp terminal itself is parked (it keeps running without a pane) and
// gets its pane back on the way out. `shared("omp-chat.panes")` maps chat pane id → terminal, so
// headers, the btw sidebar and ⌘J know which omp a chat pane belongs to (channel.js).
import { div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { run, panes } from "herdr";
import { chatPanes, setChatPanes } from "./channel.js";

export const BTW_BLOCK = "omp-btw";

/**
 * Replaces the terminal's pane with a chat pane in the same place: splits a chat pane off it,
 * waits for the new pane to show up (up to 3s), records it, then parks the terminal.
 */
export function toChat(pane, terminal, cx) {
  const before = new Set(panes().map((p) => p.pane));
  run("pane.split", { pane, direction: "right", mod: "omp-chat", props: { view: "chat", terminal } });
  const started = Date.now();
  const finish = (cx) => {
    const added = panes().find((p) => !before.has(p.pane) && p.mod === "omp-chat");
    if (!added) {
      if (Date.now() - started < 3000) cx.timer.after(50, finish);
      return;
    }
    setChatPanes({ ...chatPanes(), [added.pane]: terminal });
    run("terminal.park", { terminal });
    run("pane.focus", { pane: added.pane });
  };
  finish(cx);
}

/**
 * Gives the terminal its pane back where the chat pane is, then closes the chat pane. The keep
 * finishes in the background, so the chat pane closes only once the terminal shows (or after 3s).
 * `thenClose`: close the terminal's pane too, which ends omp as closing any terminal pane does.
 */
export function toTerminal(chatPane, terminal, cx, { thenClose = false } = {}) {
  const map = chatPanes();
  delete map[chatPane];
  setChatPanes(map); // first, so the closing chat copy knows its omp lives on
  run("pane.focus", { pane: chatPane });
  run("terminal.keep", { terminal, place: "right" });
  const started = Date.now();
  const finish = (cx) => {
    const back = panes().find((p) => p.terminal === terminal);
    if (!back && Date.now() - started < 3000) return cx.timer.after(100, finish);
    run("pane.close", { pane: chatPane });
    if (back && thenClose) run("pane.close", { pane: back.pane });
    else if (back) run("pane.focus", { pane: back.pane });
  };
  cx.timer.after(100, finish);
}

/** Chat, terminal and btw as small icon buttons for a pane header; `view` is the pane's mode. */
export function viewButtons(t, id, view, state, toggle) {
  const stop = (el) => el.on_mouse_down("left", (_e, cx) => cx.stop_propagation());
  const button = (key, icon, on, color, action) => stop(h_flex().id(`${key}-${id}`).h(22).px(6).flex_none().items_center().justify_center().rounded(5)
    .cursor_pointer().when(on, (el) => el.bg(t.selected)).when(!on, (el) => el.hover((s) => s.bg(t.hover)))
    .on_click((_e, cx) => { cx.stop_propagation(); action(cx); })
    .child(svg(`mods/omp-chat/${icon}.svg`).size(14).text_color(color ?? (on ? t.foreground : t.muted))));
  return h_flex().flex_none().gap(2).items_center()
    .child(button("seg-chat", "chat", view === "chat", null, (cx) => view !== "chat" && toggle(cx)))
    .child(button("seg-term", "terminal", view === "terminal", null, (cx) => view !== "terminal" && toggle(cx)))
    .child(div().w(1).h(14).mx(2).bg(t.border))
    .child(button("seg-btw", "btw", false, state?.btwRunning ? t.working : null, () => run("layout.toggle", { id: BTW_BLOCK })));
}
