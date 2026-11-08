// Chat ⇄ terminal, per pane. A pane in chat mode is a mod pane (`omp-chat`, view "chat") in the
// terminal pane's place; the omp terminal itself is parked (it keeps running without a pane) and
// gets its pane back on the way out. `shared("omp-chat.panes")` maps chat pane id → terminal, so
// headers, the btw sidebar and ⌘J know which omp a chat pane belongs to (channel.js).
import { run, panes } from "herdr";
import { chatPanes, setChatPanes, forgetChatPane } from "./channel.js";

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
 * finishes in the background, so the chat pane closes only once the terminal shows; if it doesn't
 * within 3s, the chat pane stays. `thenClose`: close the terminal's pane too, which ends omp as
 * closing any terminal pane does.
 */
export function toTerminal(chatPane, terminal, cx, { thenClose = false } = {}) {
  run("pane.focus", { pane: chatPane });
  run("terminal.keep", { terminal, place: "right" });
  const started = Date.now();
  const finish = (cx) => {
    const back = panes().find((p) => p.terminal === terminal);
    if (!back) {
      if (Date.now() - started < 3000) cx.timer.after(100, finish);
      return;
    }
    forgetChatPane(chatPane, terminal); // before the close, so the closing chat copy knows its omp lives on
    run("pane.close", { pane: chatPane });
    run(thenClose ? "pane.close" : "pane.focus", { pane: back.pane });
  };
  cx.timer.after(100, finish);
}
