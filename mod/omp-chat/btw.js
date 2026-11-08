// The btw sidebar: side questions about the shown tab's omp session, answered by the bridge with
// an ephemeral turn (never added to the transcript, nothing shown in the terminal). Topics newest
// first; a selected topic takes follow-ups that keep its earlier turns as context.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, TextView, TextareaState, Textarea } from "gpui-base";
import { theme, focused, run } from "herdr";
import { ROOT, dirOf, readJson, listDir, sendRequest, loadStates, watchRoot, ompTerminalOf } from "./channel.js";
import { blocks } from "./blocks.js";
import { BTW_BLOCK } from "./view.js";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class Btw {
  init(cx) {
    this.alive = true;
    this.states = {};
    this.terminal = null;
    this.state = null;
    this.topics = [];
    this.selected = null;
    this.waitingSince = null;
    this.error = null;
    // A text area, so a question wraps and grows (up to 6 lines) instead of running off the right.
    this.input = TextareaState.new({ placeholder: "Ask on the side…" });
    this.input.set_auto_grow(1, 6);
    this.text = "";
    this.input.on("change", () => {
      this.before = this.text;
      this.text = this.input.value();
    });
    // As the chat's reply box: Enter asks, Shift+Enter is a new line. The text area may already
    // have put a line break in for the Enter; it is taken out (asking) or kept (Shift).
    this.input.on("submit", (e, cx) => {
      const lines = (s) => (s ?? "").split("\n").length;
      const inserted = this.before !== undefined && this.text.length === this.before.length + 1 && lines(this.text) === lines(this.before) + 1;
      if (e.shift) {
        if (!inserted) this.input.replace("\n");
        return;
      }
      this.ask(cx, inserted ? this.before : this.text);
    });
    this.handle = cx.focus_handle();
    watchRoot(cx, () => this.alive, async (changed, cx) => {
      this.states = await loadStates();
      if (this.terminal && changed.some((p) => p === ROOT || p.startsWith(`${dirOf(this.terminal)}/`))) await this.load();
      cx.notify();
    });
    cx.spawn(async (cx) => { this.states = await loadStates(); cx.notify(); });
  }

  close() {
    this.alive = false;
  }

  /** Follows the shown tab's omp; a new one starts on its newest topic. */
  track(cx) {
    const tab = focused()?.tab;
    const terminal = tab ? ompTerminalOf(tab, this.states) : null;
    if (terminal === this.terminal) return;
    this.terminal = terminal;
    this.state = null;
    this.topics = [];
    this.selected = null;
    this.loaded = false;
    this.waitingSince = null;
    if (terminal) cx.spawn(async (cx) => { await this.load(); cx.notify(); });
  }

  async load() {
    const terminal = this.terminal;
    const dir = dirOf(terminal);
    const state = await readJson(`${dir}/state.json`);
    const topics = [];
    for (const name of await listDir(`${dir}/btw`)) {
      if (!name.endsWith(".json")) continue;
      const record = await readJson(`${dir}/btw/${name}`);
      if (record?.id && record.sessionId === state?.sessionId) topics.push(record);
    }
    if (terminal !== this.terminal) return;
    this.state = state;
    this.topics = topics.sort((a, b) => b.createdAt - a.createdAt);
    if (!this.loaded) {
      this.loaded = true;
      this.selected = this.topics[0]?.id ?? null;
    }
    if (this.waitingSince) {
      const fresh = this.topics.find((r) => r.createdAt >= this.waitingSince);
      if (fresh) {
        this.selected = fresh.id;
        this.waitingSince = null;
      }
    }
  }

  ask(cx, text = this.input.value()) {
    const question = text.trim();
    if (!question || !this.state || this.state.btwRunning) return;
    const followUpOf = this.selected;
    if (!followUpOf) this.waitingSince = Date.now() - 1000;
    this.input.set_value("");
    this.text = "";
    this.before = undefined;
    cx.spawn(async (cx) => {
      try {
        await sendRequest(this.terminal, { type: "btw", question, ...(followUpOf ? { followUpOf } : {}) });
        this.error = null;
      } catch (e) {
        this.error = String(e?.message ?? e);
        this.input.set_value(question);
      }
      cx.notify();
    });
  }

  render(cx) {
    this.track(cx);
    const t = theme();
    const button = (id, label, action, primary) => (h_flex().id(id).h(26).px(10).items_center().rounded(7).flex_none()
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12).cursor_pointer()
      .hover((s) => s.opacity(0.85)).on_click(action).child(label));
    const running = this.state?.btwRunning ?? null;
    const topic = this.topics.find((r) => r.id === this.selected) ?? null;
    const turns = topic ? [topic, ...(topic.followUps ?? [])] : [];

    const title = h_flex().w_full().h(38).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().font_semibold().text_size(13).child("btw"))
      .child(div().text_size(12).text_color(t.dim).truncate().child(this.terminal ? `omp · ${this.terminal}` : ""))
      .child(div().flex_1())
      .child(button("btw-new", "New topic", (_e, cx) => { this.selected = null; this.input.focus(); cx.notify(); }))
      .child(button("btw-close", "✕", () => run("layout.hide", { id: BTW_BLOCK })));

    const root = v_flex().id("btw").size_full().bg(t.background).text_color(t.foreground)
      .track_focus(this.handle).on_key_down((e, cx) => {
        if (e.key === "escape" && !this.input.value()) { run("layout.hide", { id: BTW_BLOCK }); cx.stop_propagation(); }
      })
      .child(title);
    if (!this.state) {
      return root.child(v_flex().flex_1().items_center().justify_center().text_size(13).text_color(t.dim)
        .child(this.terminal ? "Loading…" : "No omp with the chat bridge in this tab."));
    }

    const topicsList = v_flex().id("btw-topics").w_full().max_h(150).flex_none().overflow_y_scroll().p(6).gap(2).border_b(1).border_color(t.border)
      .when(!this.topics.length, (el) => el.child(div().p(6).text_size(12).text_color(t.dim).child("No side questions yet. Ask one below; the agent keeps working.")))
      .children(this.topics.map((r) => {
        const last = r.followUps?.length ? r.followUps[r.followUps.length - 1] : r;
        return (h_flex().id(`topic-${r.id}`).px(8).py(5).gap(8).rounded(6).cursor_pointer().text_size(12.5)
          .when(r.id === this.selected, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.selected = r.id; this.input.focus(); cx.notify(); })
          .child(div().flex_1().truncate().child(r.question))
          .when(last.status === "running", (el) => el.child(div().text_color(t.working).child("⠋").frames(SPINNER, 90)))
          .when((r.followUps?.length ?? 0) > 0, (el) => el.child(div().text_size(11).text_color(t.dim).child(`+${r.followUps.length}`))));
      }));

    // A copy icon at the right edge, as in the chat: under each block of a finished answer (code,
    // table, equation: blocks.js), and under the answer for all of it.
    const copyButton = (key, text) => h_flex().w_full().justify_end().child(h_flex().id(`btw-copy-${key}`).size(24).mr(-6)
      .items_center().justify_center().rounded(6).cursor_pointer()
      .text_color(this.copied === key ? t.done : t.dim).hover((s) => s.bg(t.hover).text_color(this.copied === key ? t.done : t.foreground))
      .on_click((_e, cx) => {
        cx.write_to_clipboard(text);
        this.copied = key;
        cx.timer.after(1500, (cx) => { if (this.copied === key) this.copied = null; cx.notify(); });
        cx.notify();
      })
      .child(svg(`mods/omp-chat/${this.copied === key ? "check" : "copy"}.svg`).size(12)));
    const answer = (turn, key) => {
      if (turn.status !== "complete") return [TextView.markdown(`btw-${key}`, turn.answer).selectable(true).w_full()];
      return blocks(turn.answer).flatMap((part, j) => [
        TextView.markdown(`btw-${key}-${j}`, part.text).selectable(true).w_full(),
        ...(part.copy != null ? [copyButton(`${key}-${j}`, part.copy)] : []),
      ]);
    };
    const conversation = v_flex().id("btw-turns").flex_1().min_h(0).overflow_y_scroll().p(12).gap(12)
      .when(!topic, (el) => el.child(div().text_size(12.5).text_color(t.dim).child("A new topic: ask about this session while the agent works.")))
      .children(turns.map((turn, i) => v_flex().gap(6)
        .child(h_flex().w_full().justify_end().child(div().max_w(360).px(11).py(7).rounded(12).bg(t.selected).text_size(13).child(turn.question)))
        .child(v_flex().w_full().gap(6).text_size(13)
          .when(Boolean(turn.answer), (el) => el.children(answer(turn, `${topic.id}-${i}`)))
          .when(turn.status === "running" && !turn.answer, (el) => el.child(div().text_color(t.working).child("⠋").frames(SPINNER, 90))))
        .when(turn.status === "complete" && Boolean(turn.answer), (el) => el.child(copyButton(`${topic.id}-${i}`, turn.answer)))
        .when(turn.status === "error" || turn.status === "cancelled", (el) => el.child(div().text_size(12).text_color(t.blocked).child(turn.error ?? turn.status)))));

    const composer = v_flex().w_full().flex_none().p(10).gap(6).border_t(1).border_color(t.border)
      .when(Boolean(this.error), (el) => el.child(div().text_size(12).text_color(t.blocked).child(this.error)))
      .child(div().text_size(11).text_color(t.dim).child(topic ? "Follow-up in this topic" : "New topic"))
      .child(h_flex().gap(8).items_end()
        .child(div().flex_1().min_w(0).px(9).py(6).rounded(8).border_1().border_color(t.input).bg(t.background)
          .child(Textarea.new(this.input).w_full().text_size(13).text_color(t.foreground)))
        .child(running
          ? button("btw-cancel", "Cancel", (_e, cx) => { sendRequest(this.terminal, { type: "btw_cancel", id: running }).catch(() => {}); cx.notify(); })
          : button("btw-ask", "Ask", (_e, cx) => this.ask(cx), true)));

    return root.child(topicsList).child(conversation).child(composer);
  }
}
