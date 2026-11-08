// Small pieces the omp-chat views share.
import { svg } from "gpui-kit";
import { h_flex, TextareaState } from "gpui-base";
import { appHome, home } from "herdr";

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
// Reads omp's session files for the chat: its feed, the /resume list.
export const HELPER = `${appHome()}/mods/omp-chat/transcript.ts`;

/** A path with the home folder shown as `~`. */
export function folder(path) {
  if (!path) return "";
  const h = home();
  return path === h ? "~" : path.startsWith(h + "/") ? "~" + path.slice(h.length) : path;
}

// An open list (the / commands, the /resume picker) puts its text box in this key context. The
// text box's own bindings (context "Input": cursor up/down, Tab indents) would take ↑ ↓ Tab
// before any on_key_down; bindings matched at the same depth, and installed later, outrank them.
export const LIST_CONTEXT = "OmpChatList";
let listKeysBound = false;
export function bindListKeys(cx) {
  if (listKeysBound) return;
  listKeysBound = true;
  const keys = [["up", "omp_chat_list_up"], ["down", "omp_chat_list_down"], ["tab", "omp_chat_list_accept"]];
  cx.bind_keys(keys.flatMap(([keystroke, action]) => [
    { keystroke, action, context: `${LIST_CONTEXT} > Input` },
    { keystroke, action, context: LIST_CONTEXT },
  ]));
}

/**
 * A growing text area where Enter submits and Shift+Enter starts a new line; `text` follows its
 * value. The text area may already have put a line break in for the Enter: Shift keeps it, and
 * submitting takes it out of the box first, so it never stays behind whether or not
 * `onSubmit(e, cx)` takes the text.
 */
export class ReplyBox {
  constructor({ placeholder, maxRows, onChange, onSubmit }) {
    this.input = TextareaState.new({ placeholder });
    this.input.set_auto_grow(1, maxRows);
    this.text = "";
    this.onSubmit = onSubmit;
    this.input.on("change", (_e, cx) => {
      this.before = this.text;
      this.text = this.input.value();
      onChange?.(cx);
    });
    this.input.on("submit", (e, cx) => this.enter(e, cx));
  }

  /** An Enter, with the submit event's modifiers: `shift`, `secondary` (Cmd/Ctrl). */
  enter(e, cx) {
    const lines = (s) => s.split("\n").length;
    // Did the last change only add a line break (the text area's own, for this Enter)?
    const inserted = this.before !== undefined && this.text.length === this.before.length + 1 && lines(this.text) === lines(this.before) + 1;
    if (e.shift) {
      if (!inserted) this.input.replace("\n");
      return;
    }
    if (inserted) this.set(this.before);
    this.onSubmit(e, cx);
  }

  set(text) {
    this.input.set_value(text);
    this.text = text;
    this.before = undefined;
  }
}

// The Copy button's box: a square around its 12px icon that sticks out by its padding, so the
// icon lines up with the text it copies.
export const COPY_BUTTON = { width: 24, pad: 6 };

/** A view's Copy buttons: a copy icon, a check on the one that just copied (for 1.5s). */
export class CopyButtons {
  constructor() {
    this.copied = null;
  }

  /** The button `key`, for the right end of its row. */
  button(t, key) {
    const done = this.copied === key;
    return h_flex().size(COPY_BUTTON.width).mr(-COPY_BUTTON.pad).items_center().justify_center().rounded(6).cursor_pointer()
      .text_color(done ? t.done : t.dim).hover((s) => s.bg(t.hover).text_color(done ? t.done : t.foreground))
      .child(svg(`mods/omp-chat/${done ? "check" : "copy"}.svg`).size(12));
  }

  /** Pressing the button `key`: `text` goes on the clipboard. */
  copy(key, text, cx) {
    cx.write_to_clipboard(text);
    this.copied = key;
    cx.timer.after(1500, (cx) => {
      if (this.copied === key) this.copied = null;
      cx.notify();
    });
    cx.notify();
  }
}
