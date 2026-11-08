// The feed's rows: the transcript's items as list rows (feedRows), and how each one draws (drawRow).
import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { SPINNER } from "./common.js";

/** A fenced code block that no backtick run inside `text` can close. */
export function fenced(text, lang = "") {
  const longest = Math.max(2, ...[...String(text).matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${lang}\n${text}\n${fence}`;
}

/**
 * The list's rows: each run of tool calls folds into one "work" row (its calls follow while it's
 * in `open`); a "copy" row closes each finished answer with its text. After the transcript's, the
 * messages `sent` from the chat that it doesn't hold yet, the `live` answer (a text row) omp is
 * writing, and a "working" row while omp is `working` or a sent message waits.
 */
export function feedRows(feed, open, sent, live, working) {
  const rows = [];
  if (feed.start > 0) rows.push({ k: "older", id: "__older" });
  let work = null;
  let answer = [];
  let lastText = null;
  const flushWork = () => {
    if (!work) return;
    rows.push(work);
    if (open.has(work.id)) rows.push(...work.tools);
    work = null;
  };
  const flushAnswer = () => {
    if (answer.length) rows.push({ k: "copy", id: `copy:${lastText}`, text: answer.join("\n\n") });
    answer = [];
  };
  for (const item of feed.items) {
    if (item.k === "tool") {
      work ??= { k: "work", id: `work:${item.id}`, tools: [] };
      work.tools.push(item);
      continue;
    }
    flushWork();
    if (item.k === "user") flushAnswer();
    // An answer split into parts is a row per part, and a block's copy button a row under it, as
    // the answer's: the list's on_item_click names the row (Chat.clickRow).
    if (item.k === "text" && item.parts) {
      item.parts.forEach((part, i) => {
        rows.push({ k: "part", id: `${item.id}#${i}`, part, first: i === 0, last: i === item.parts.length - 1 });
        if (part.copy != null) rows.push({ k: "copy", id: `copy:${item.id}#${i}`, text: part.copy, block: true });
      });
    } else rows.push(item);
    if (item.k === "text") {
      answer.push(item.text);
      lastText = item.id;
    }
  }
  flushWork();
  const active = working || sent.length > 0;
  if (!active) flushAnswer();
  // Sent, and not in the transcript yet: shown at once (omp writes it with its first turn).
  for (const s of sent) rows.push({ k: "user", id: s.id, text: s.text });
  if (live) rows.push(live);
  if (active) rows.push({ k: "working", id: "__working" });
  return rows;
}

/**
 * How `row` draws. `v`, what rows show besides their own data: the theme `t`, `mono` (the
 * terminal's font), the column's `width`, the `open` rows, `olderLoading` (the earlier page is
 * coming), the feed's `copyButtons`, and `waiting` (a card waits for an answer).
 */
export function drawRow(row, v) {
  const { t, width } = v;
  const open = v.open.has(row.id);
  switch (row.k) {
    case "older":
      return h_flex().w_full().justify_center().py(10).text_size(12).text_color(t.dim).child(v.olderLoading ? "Loading earlier messages…" : "Earlier messages ▴");
    case "work": {
      const running = row.tools.some((tool) => !tool.done);
      const failed = row.tools.filter((tool) => tool.error).length;
      const last = row.tools[row.tools.length - 1];
      return h_flex().w_full().my(2).px(9).py(5).gap(8).items_center().rounded(8).text_size(12.5).text_color(t.muted).cursor_pointer()
        .child(div().flex_none().text_color(t.dim).child(open ? "▾" : "▸"))
        .when(running, (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .child(div().flex_none().font_medium().text_color(t.foreground).child(running ? "Working" : "Worked"))
        .child(div().flex_none().child(`${row.tools.length} step${row.tools.length === 1 ? "" : "s"}`))
        .when(failed > 0, (el) => el.child(div().flex_none().text_color(t.blocked).child(`${failed} failed`)))
        .when(!open, (el) => el.child(div().flex_1().truncate().text_color(t.dim).child(`${last.name} · ${last.summary}`)));
    }
    case "copy":
      // Only the button, at the right edge, is the target: Chat.clickRow ignores presses beside it
      // (COPY_BUTTON). Under a block (code, table, diagram, equation) it copies that block; under
      // the answer, all of it.
      return h_flex().w_full().justify_end().pb(row.block ? 3 : 6).child(v.copyButtons.button(t, row.id));
    case "working":
      return h_flex().w_full().px(4).py(8).gap(8).items_center().text_size(12.5).text_color(t.muted)
        .child(div().text_color(t.working).child("⠋").frames(SPINNER, 90))
        .child(v.waiting ? "Waiting for you" : "Working…");
    case "user":
      return h_flex().w_full().justify_end().pt(14).pb(4).child(
        v_flex().max_w(width * 0.82).px(13).py(9).rounded(14).bg(t.selected).text_color(t.foreground).text_size(13.5)
          .when(row.steer, (el) => el.child(div().text_size(10.5).text_color(t.dim).pb(2).child("steer")))
          .child(TextView.markdown(`u-${row.id}`, row.text).selectable(true).w_full()));
    case "text":
      return div().w_full().py(4).text_size(13.5).text_color(t.foreground)
        .child(TextView.markdown(`m-${row.id}`, row.text).selectable(true).w_full());
    case "part": {
      const p = row.part;
      let body;
      if (p.t === "md") body = TextView.markdown(`m-${row.id}`, p.text).selectable(true).w_full();
      else if (p.t === "pre") body = div().w_full().text_size(12).child(TextView.markdown(`mm-${row.id}`, fenced(p.text)).selectable(true).w_full());
      else {
        // A figure at its own size, shrunk to fit the column and at most 560px high.
        let w = Math.min(p.w, width);
        let h = (p.h * w) / p.w;
        if (h > 560) { w = (w * 560) / h; h = 560; }
        body = image(p.path).w(w).h(h);
      }
      return div().w_full().pt(row.first ? 4 : 3).pb(row.last || p.copy != null ? 4 : 3).text_size(13.5).text_color(t.foreground).child(body);
    }
    case "tool": {
      const color = !row.done ? t.working : row.error ? t.blocked : t.done;
      const box = (label, text, id) => v_flex().w_full().gap(3)
        .child(div().text_size(10.5).text_color(t.dim).child(label))
        .child(div().w_full().max_h(320).overflow_hidden().rounded(7).bg(t.background).border_1().border_color(t.border).px(8).text_size(12)
          .child(TextView.markdown(id, fenced(text)).selectable(true).w_full()));
      return v_flex().w_full().py(2).gap(6).cursor_pointer()
        .child(h_flex().w_full().gap(8).items_center().px(9).py(6).rounded(8).bg(t.raised).text_size(12.5)
          .child(div().text_color(color).child(row.done ? (row.error ? "✕" : "●") : "◌"))
          .child(div().flex_none().font_family(v.mono).font_medium().text_color(t.foreground).child(row.name))
          .child(div().flex_1().truncate().text_color(t.muted).child(row.summary))
          .child(div().flex_none().text_color(t.dim).child(open ? "▾" : "▸")))
        .when(open, (el) => el.child(v_flex().w_full().pl(12).gap(6)
          .child(box("Input", row.input, `ti-${row.id}`))
          .when(row.done, (el) => el.child(box(row.error ? "Error" : "Output", row.output || "(no output)", `to-${row.id}`)))));
    }
    case "compact":
      return v_flex().w_full().my(8).px(12).py(8).gap(4).rounded(8).border_1().border_color(t.border).text_size(12).text_color(t.muted).cursor_pointer()
        .child(div().font_medium().child(`Compacted ${open ? "▾" : "▸"}`))
        .when(open, (el) => el.child(TextView.markdown(`c-${row.id}`, row.text).selectable(true).w_full()));
    case "notice":
      return h_flex().w_full().justify_center().py(6).child(
        div().max_w(width * 0.9).px(10).py(5).rounded(8).bg(t.raised).text_size(12).text_color(t.muted).child(row.text.slice(0, 600)));
    case "error":
      return div().w_full().py(4).text_size(12.5).text_color(t.blocked).child(`Error: ${row.text}`);
    default:
      return div();
  }
}
