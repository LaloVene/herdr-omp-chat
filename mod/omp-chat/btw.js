// The btw sidebar: side questions about the shown tab's omp session, answered by the bridge with
// an ephemeral turn (never added to the transcript, nothing shown in the terminal). Topics newest
// first; a selected topic takes follow-ups that keep its earlier turns as context.
import { div } from "gpui-kit";
import { v_flex, h_flex, TextView, Textarea } from "gpui-base";
import { theme, focused, run } from "herdr";
import { ROOT, dirOf, readJson, listDir, sendRequest, loadStates, watchRoot, ompTerminalOf } from "./channel.js";
import { blocks } from "./blocks.js";
import { BTW_BLOCK } from "./view.js";
import { SPINNER, ReplyBox, CopyButtons } from "./common.js";
import { GLASS } from "./omp-chat-shared.js";

export class Btw {
  init(cx) {
    this.alive = true;
    this.states = null; // every bridge's state.json by terminal (loadStates), once read
    this.terminal = null;
    this.state = null;
    this.records = new Map(); // the shown omp's topic files: name → record
    this.topics = [];
    this.selected = null;
    this.waitingSince = null;
    this.error = null;
    this.copyButtons = new CopyButtons();
    // A text area, so a question wraps and grows (up to 6 lines) instead of running off the right.
    this.box = new ReplyBox({ placeholder: "Ask on the side…", maxRows: 6, onSubmit: (_e, cx) => this.ask(cx) });
    this.handle = cx.focus_handle();
    // The bridge rewrites a topic's file every 100ms while its answer streams: only what changed is read again.
    watchRoot(cx, () => this.alive, async (changed, cx) => {
      // A batch holding the root means anything may have changed (watchFolder).
      const all = changed.some((p) => p === ROOT || p === `${ROOT}/`);
      if (all || changed.some((p) => p.endsWith("/state.json"))) this.states = await loadStates();
      const mine = this.terminal && `${dirOf(this.terminal)}/`;
      if (mine && (all || changed.some((p) => p.startsWith(mine)))) await this.load(all ? null : changed);
      cx.notify();
    });
    cx.spawn(async (cx) => { this.states = await loadStates(); cx.notify(); });
  }

  close() {
    this.alive = false;
  }

  /** Follows the shown tab's omp (once the bridges' states are read); a new one starts on its newest topic. */
  track(cx) {
    if (!this.states) return;
    const tab = focused()?.tab;
    const terminal = tab ? ompTerminalOf(tab, this.states) : null;
    if (terminal === this.terminal) return;
    this.terminal = terminal;
    this.state = null;
    this.records = new Map();
    this.topics = [];
    this.selected = null;
    this.loaded = false;
    this.waitingSince = null;
    this.error = null;
    if (terminal) cx.spawn(async (cx) => { await this.load(); cx.notify(); });
  }

  /**
   * Reads the shown omp's topic files: those in `changed` (a watchFolder batch), else all of them,
   * as when the batch names their folder rather than its files.
   */
  async load(changed = null) {
    const terminal = this.terminal;
    const dir = `${dirOf(terminal)}/btw`;
    const all = !changed || changed.some((p) => p === dir || p === `${dir}/`);
    const names = all
      ? (await listDir(dir)).filter((name) => name.endsWith(".json"))
      : changed.filter((p) => p.startsWith(`${dir}/`) && p.endsWith(".json")).map((p) => p.slice(dir.length + 1));
    const read = [];
    for (const name of names) read.push([name, await readJson(`${dir}/${name}`)]);
    if (terminal !== this.terminal) return;
    if (all) this.records.clear();
    for (const [name, record] of read) {
      if (record?.id) this.records.set(name, record);
      else this.records.delete(name);
    }
    this.state = this.states[terminal] ?? null;
    this.topics = [...this.records.values()].filter((r) => r.sessionId === this.state?.sessionId).sort((a, b) => b.createdAt - a.createdAt);
    if (!this.loaded) {
      this.loaded = true;
      this.selected = this.topics[0]?.id ?? null;
    }
    if (this.waitingSince) {
      // The topic asked in: a new one, or the one followed up, whose newest turn is the question.
      const fresh = this.topics.find((r) => (r.followUps?.at(-1) ?? r).createdAt >= this.waitingSince);
      if (fresh) {
        this.selected = fresh.id;
        this.waitingSince = null;
      }
    }
  }

  ask(cx) {
    const question = this.box.text.trim();
    if (!question || !this.state || this.state.btwRunning) return;
    const terminal = this.terminal;
    const followUpOf = this.selected;
    this.waitingSince = Date.now() - 1000;
    this.box.set("");
    cx.spawn(async (cx) => {
      try {
        await sendRequest(terminal, { type: "btw", question, ...(followUpOf ? { followUpOf } : {}) });
        this.error = null;
      } catch (e) {
        this.error = String(e?.message ?? e);
        this.waitingSince = null;
        this.box.set(question);
      }
      cx.notify();
    });
  }

  cancel(id, cx) {
    const terminal = this.terminal;
    cx.spawn(async (cx) => {
      try {
        await sendRequest(terminal, { type: "btw_cancel", id });
      } catch (e) {
        this.error = String(e?.message ?? e);
        cx.notify();
      }
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
      .child(button("btw-new", "New topic", (_e, cx) => { this.selected = null; this.box.input.focus(); cx.notify(); }))
      .child(button("btw-close", "✕", () => run("layout.hide", { id: BTW_BLOCK })));

    const root = v_flex().id("btw").size_full().bg(t.background + GLASS.pane).text_color(t.foreground)
      .track_focus(this.handle).on_key_down((e, cx) => {
        if (e.key === "escape" && !this.box.text) { run("layout.hide", { id: BTW_BLOCK }); cx.stop_propagation(); }
      })
      .child(title);
    if (!this.state) {
      return root.child(v_flex().flex_1().items_center().justify_center().text_size(13).text_color(t.dim)
        .child(this.terminal || !this.states ? "Loading…" : "No omp with the chat bridge in this tab."));
    }

    const topicsList = v_flex().id("btw-topics").w_full().max_h(150).flex_none().overflow_y_scroll().p(6).gap(2).border_b(1).border_color(t.border)
      .when(!this.topics.length, (el) => el.child(div().p(6).text_size(12).text_color(t.dim).child("No side questions yet. Ask one below; the agent keeps working.")))
      .children(this.topics.map((r) => {
        const last = r.followUps?.length ? r.followUps[r.followUps.length - 1] : r;
        return (h_flex().id(`topic-${r.id}`).px(8).py(5).gap(8).rounded(6).cursor_pointer().text_size(12.5)
          .when(r.id === this.selected, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.selected = r.id; this.box.input.focus(); cx.notify(); })
          .child(div().flex_1().truncate().child(r.question))
          .when(last.status === "running", (el) => el.child(div().text_color(t.working).child("⠋").frames(SPINNER, 90)))
          .when((r.followUps?.length ?? 0) > 0, (el) => el.child(div().text_size(11).text_color(t.dim).child(`+${r.followUps.length}`))));
      }));

    // A copy icon at the right edge, as in the chat: under each block of a finished answer (code,
    // table, equation: blocks.js), and under the answer for all of it.
    const copyButton = (key, text) => h_flex().w_full().justify_end()
      .child(this.copyButtons.button(t, key).id(`btw-copy-${key}`).on_click((_e, cx) => this.copyButtons.copy(key, text, cx)));
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
        .child(div().flex_1().min_w(0).px(9).py(6).rounded(8).border_1().border_color(t.input).bg(t.background + GLASS.inset)
          .child(Textarea.new(this.box.input).w_full().text_size(13).text_color(t.foreground)))
        .child(running
          ? button("btw-cancel", "Cancel", (_e, cx) => this.cancel(running, cx))
          : button("btw-ask", "Ask", (_e, cx) => this.ask(cx), true)));

    return root.child(topicsList).child(conversation).child(composer);
  }
}
