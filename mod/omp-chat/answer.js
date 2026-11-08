// Answers omp's approval and ask dialogs with keys, after checking the screen shows the dialog the
// card is about. Extensions can't answer tool approvals, so keys are the only way; the screen check
// keeps a stale card from typing into whatever replaced the dialog. Shapes checked on omp 18.18
// (key sequences after Ovis's server/dialogs/omp.ts, MIT, see NOTICE.md).
import { screen, keys, send } from "./channel.js";

export class ScreenChanged extends Error {
  constructor(message = "It changed on screen") {
    super(message);
  }
}

const strip = (line) => line.replace(/^\s*│/, "").replace(/│\s*$/, "");
const wait = (cx, ms) => new Promise((resolve) => cx.timer.after(ms, () => resolve()));

/** Rows drawn as `<cursor> <label>` (approval) or `<cursor> <glyph> <label>` (ask), from `from` until a rule. */
function rows(lines, from, withGlyph) {
  const out = [];
  const re = withGlyph ? /^ (\S| ) (\S) (.+?)\s*$/u : /^ (\S| ) (.+?)\s*$/u;
  for (let i = from; i < lines.length; i++) {
    if (/^\s*[├╰]/.test(lines[i])) break;
    const m = re.exec(strip(lines[i]));
    if (m) out.push({ cursor: m[1] !== " ", label: (withGlyph ? m[3] : m[2]).trim(), line: i });
  }
  return out;
}

const moves = (from, to) => Array(Math.abs(to - from)).fill(to > from ? "down" : "up");
const fingerprint = (text) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 24);

// omp ignores keys for a moment after it draws a dialog (a guard against typing into it by accident).
const SETTLE_MS = 1000;
const settle = (card, cx) => wait(cx, Math.max(0, SETTLE_MS - (Date.now() - (card.since ?? 0))));

/** `choice`: "approve" | "session" | "deny"; `steer`: deny and send this text to the agent instead. */
export async function answerApproval(terminal, card, choice, steer, cx) {
  await settle(card, cx);
  const lines = await screen(terminal, 80);
  const top = lines.findLastIndex((l) => l.includes(`Allow tool: ${card.toolName}`));
  if (top < 0) throw new ScreenChanged();
  const shown = lines.slice(top).join(" ").replace(/\s+/g, " ");
  const command = typeof card.input?.command === "string" ? fingerprint(card.input.command) : "";
  if (command && !shown.includes(command)) throw new ScreenChanged();
  if (steer) return send(terminal, steer, true);
  const menu = rows(lines, top + 1, false).filter((r) => /^(Approve|Deny)\b/.test(r.label));
  const cursor = menu.findIndex((r) => r.cursor);
  const target = menu.findIndex((r) =>
    choice === "deny" ? r.label === "Deny" : choice === "session" ? /session/i.test(r.label) : r.label === "Approve" || r.label === "Approve Once");
  if (cursor < 0 || target < 0) throw new ScreenChanged();
  await keys(terminal, [...moves(cursor, target), "enter"]);
}

/** The ask dialog's current question and its option rows, or null when it isn't on screen. */
function askScreen(lines, question) {
  const top = lines.findLastIndex((l) => /^\s*╭─ Ask\b/.test(l));
  if (top < 0) return null;
  const divider = lines.findIndex((l, i) => i > top && /^\s*├/.test(l));
  if (divider < 0) return null;
  const header = lines.slice(top + 1, divider).join(" ").replace(/\s+/g, " ");
  if (question && !header.includes(fingerprint(question))) return null;
  return { header, options: rows(lines, divider + 1, true) };
}

/**
 * `answers[i]`: { picked: number[] (option indexes), other: string | null } for question i, in order.
 * omp moves to the next question on Enter and shows a review (Enter submits) when there are several.
 */
export async function answerAsk(terminal, card, answers, cx) {
  await settle(card, cx);
  const questions = Array.isArray(card.questions) ? card.questions : [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const a = answers[i] ?? { picked: [], other: null };
    const shown = askScreen(await screen(terminal, 80), q.question);
    if (!shown) throw new ScreenChanged();
    const options = shown.options;
    const cursor = Math.max(0, options.findIndex((o) => o.cursor));
    const otherRow = options.findIndex((o) => /^Other \(type your own\)$/i.test(o.label));
    if (a.other && a.other.trim()) {
      if (otherRow < 0) throw new ScreenChanged();
      await keys(terminal, [...moves(cursor, otherRow), "enter"]);
      await wait(cx, 250);
      await send(terminal, a.other.trim(), true);
    } else if (q.multi) {
      const list = [];
      let at = cursor;
      for (const index of [...a.picked].sort((x, y) => x - y)) {
        if (index >= options.length || index === otherRow) throw new ScreenChanged();
        list.push(...moves(at, index), "space");
        at = index;
      }
      await keys(terminal, [...list, "enter"]);
    } else {
      const index = a.picked[0];
      const expected = fingerprint(q.options?.[index]?.label).slice(0, 16);
      if (index === undefined || index >= options.length || !fingerprint(options[index].label).startsWith(expected)) throw new ScreenChanged();
      await keys(terminal, [...moves(cursor, index), "enter"]);
    }
    await wait(cx, 300);
  }
  const lines = await screen(terminal, 40);
  if (lines.some((l) => strip(l).trim() === "Review answers")) await keys(terminal, ["enter"]);
}
