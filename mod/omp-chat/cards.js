// omp's open approval and ask cards (the bridge's pending.json): answering them, which answer.js
// does with keys, and how they draw.
import { div } from "gpui-kit";
import { v_flex, h_flex, TextView, InputState, Input } from "gpui-base";
import { notify, playSound } from "herdr";
import { answerApproval, answerAsk } from "./answer.js";
import { folder } from "./common.js";
import { fenced } from "./rows.js";

function button(id, label, t, kind, action) {
  const solid = kind === "primary";
  const danger = kind === "danger";
  return h_flex().id(id).h(28).px(11).items_center().rounded(7).flex_none()
    .border_1().border_color(solid ? t.solid : danger ? t.blocked : t.input).bg(solid ? t.solid : t.raised)
    .text_color(solid ? t.solid_foreground : danger ? t.blocked : t.foreground).text_size(12.5).font_medium()
    .cursor_pointer().hover((s) => s.opacity(0.85)).on_click(action).child(label);
}

export class Cards {
  /** `terminal`: the omp asking; `showTerminal(cx)`: its terminal, for a card the keys couldn't answer. */
  constructor(terminal, showTerminal) {
    this.terminal = terminal;
    this.showTerminal = showTerminal;
    this.list = [];
    this.seen = null; // the cards' ids at the last read; null before the first
    this.busy = null; // the card being answered
    this.errors = {};
    this.picks = {}; // ask card → per question, the picked option indexes
    this.others = {}; // ask card → per question, the box for an own answer
    this.steer = InputState.new({ placeholder: "Deny and tell it…" });
    this.steer.on("submit", (_e, cx) => this.approve(this.list.find((c) => c.kind === "approval"), "deny", this.steer.value(), cx));
  }

  /**
   * Takes pending.json's cards. Herdr doesn't alert for a parked omp, so a card that's new since
   * the last read is told about while `tab`, the chat's ({ id, shown }), isn't on screen.
   */
  update(pending, tab) {
    this.list = Array.isArray(pending) ? pending : [];
    for (const card of this.list) {
      if (card.kind !== "ask" || this.picks[card.toolCallId]) continue;
      const questions = Array.isArray(card.questions) ? card.questions : [];
      this.picks[card.toolCallId] = questions.map(() => []);
      this.others[card.toolCallId] = questions.map(() => InputState.new({ placeholder: "Or your own answer…" }));
    }
    if (this.seen && !tab.shown) {
      for (const card of this.list.filter((c) => !this.seen.has(c.toolCallId))) {
        notify({
          title: card.kind === "ask" ? "omp has a question" : `omp asks to run ${card.toolName}`,
          body: card.kind === "ask" ? String(card.questions?.[0]?.question ?? "") : String(card.input?.command ?? card.intent ?? ""),
          level: "warning",
          ...(tab.id ? { action: { name: "tab.select", args: { id: tab.id } } } : {}),
        });
        playSound("blocked");
      }
    }
    this.seen = new Set(this.list.map((c) => c.toolCallId));
  }

  /** Answers `card` with `fn(cx)`, one card at a time; a failure shows on the card. */
  run(card, fn, cx) {
    this.busy = card.toolCallId;
    delete this.errors[card.toolCallId];
    cx.spawn(async (cx) => {
      try {
        await fn(cx);
      } catch (e) {
        this.errors[card.toolCallId] = String(e?.message ?? e);
      }
      this.busy = null;
      cx.notify();
    });
    cx.notify();
  }

  /** `choice`: "approve" | "session" | "deny"; `steerText`: deny and send this to the agent instead. */
  approve(card, choice, steerText, cx) {
    if (!card || this.busy) return;
    if (choice === "deny" && steerText !== undefined && !steerText.trim()) return;
    this.run(card, async (cx) => {
      await answerApproval(this.terminal, card, choice, steerText?.trim() || undefined, cx);
      if (steerText) this.steer.set_value("");
    }, cx);
  }

  answer(card, cx) {
    if (this.busy) return;
    const answers = (this.picks[card.toolCallId] ?? []).map((picked, i) => ({ picked, other: this.others[card.toolCallId]?.[i]?.value() || null }));
    const missing = answers.findIndex((a, i) => !a.other && !a.picked.length && !card.questions[i].multi);
    if (missing >= 0) {
      this.errors[card.toolCallId] = `Pick an answer for “${card.questions[missing].question}”`;
      return cx.notify();
    }
    this.run(card, (cx) => answerAsk(this.terminal, card, answers, cx), cx);
  }

  /** The open cards as drawn; `cwd`: omp's folder, which an approval shows. */
  render(t, cwd) {
    return this.list.map((card) => (card.kind === "ask" ? this.askCard(card, t) : this.approvalCard(card, t, cwd)));
  }

  approvalCard(card, t, cwd) {
    const busy = this.busy === card.toolCallId;
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
        .child(div().text_size(11).text_color(t.dim).truncate().child(folder(cwd))))
      .when(Boolean(card.intent), (el) => el.child(div().text_size(12.5).text_color(t.muted).child(card.intent)))
      .child(div().id(`ap-body-${card.toolCallId}`).w_full().max_h(220).overflow_y_scroll().rounded(7).bg(t.background).border_1().border_color(t.border).px(8).text_size(12)
        .child(TextView.markdown(`ap-${card.toolCallId}`, fenced(body, shell ? "sh" : "json")).selectable(true).w_full()))
      .when(Boolean(extra), (el) => el.child(div().text_size(11.5).text_color(t.dim).truncate().child(extra)))
      .child(h_flex().gap(8).flex_wrap().items_center()
        .child(button(`ap-ok-${card.toolCallId}`, "Approve", t, "primary", (_e, cx) => this.approve(card, "approve", undefined, cx)))
        .child(button(`ap-ses-${card.toolCallId}`, `Approve ${card.toolName} for this session`, t, "", (_e, cx) => this.approve(card, "session", undefined, cx)))
        .child(button(`ap-no-${card.toolCallId}`, "Deny", t, "danger", (_e, cx) => this.approve(card, "deny", undefined, cx)))
        .when(busy, (el) => el.child(div().text_size(12).text_color(t.dim).child("…"))))
      .child(h_flex().gap(8).items_center()
        .child(Input.new(this.steer).flex_1().h(30).px(9).rounded(7).border_1().border_color(t.input).bg(t.background).text_size(12.5))
        .child(button(`ap-steer-${card.toolCallId}`, "Deny and send", t, "", (_e, cx) => this.approve(card, "deny", this.steer.value(), cx))))
      .when(Boolean(this.errors[card.toolCallId]), (el) => el.child(this.cardProblem(card, t)));
  }

  cardProblem(card, t) {
    return h_flex().gap(10).items_center().text_size(12).text_color(t.blocked)
      .child(div().flex_1().child(this.errors[card.toolCallId]))
      .child(button(`card-term-${card.toolCallId}`, "Terminal", t, "", (_e, cx) => this.showTerminal(cx)));
  }

  askCard(card, t) {
    const questions = Array.isArray(card.questions) ? card.questions : [];
    const picks = this.picks[card.toolCallId] ?? [];
    const others = this.others[card.toolCallId] ?? [];
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
        .child(button(`ask-send-${card.toolCallId}`, "Answer", t, "primary", (_e, cx) => this.answer(card, cx)))
        .when(this.busy === card.toolCallId, (el) => el.child(div().text_size(12).text_color(t.dim).child("…"))))
      .when(Boolean(this.errors[card.toolCallId]), (el) => el.child(this.cardProblem(card, t)));
  }
}
