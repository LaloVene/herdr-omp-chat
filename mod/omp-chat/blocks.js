// An answer's markdown cut into prose and blocks worth copying on their own. Plain JS with no
// imports: the Bun helper (render.ts, chat answers) and the mod (btw.js, side answers) share it.

// A table's delimiter row, whole: `|---|:--:|`, `--- | ---`.
const TABLE_DELIMITER = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

/**
 * `markdown` as `{t: "md", text, copy?}` parts: each fenced code block, table, blockquote and
 * own-line `$$` equation lifted into a part of its own, its source as `copy` (a quote's without
 * its `>` marks); the prose between without.
 */
export function blocks(markdown) {
  const out = [];
  let prose = [];
  const flush = () => {
    if (prose.join("\n").trim()) out.push({ t: "md", text: prose.join("\n") });
    prose = [];
  };
  const lift = (from, to, copy) => {
    flush();
    out.push({ t: "md", text: lines.slice(from, to).join("\n"), copy });
  };
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (open && !(open[1][0] === "`" && open[2].includes("`"))) {
      const marker = open[1];
      let end = i + 1;
      while (end < lines.length) {
        const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines[end]);
        if (close && close[1][0] === marker[0] && close[1].length >= marker.length) break;
        end++;
      }
      // Unclosed (an answer still being written): the block runs to the end, as markdown draws it.
      lift(i, end + 1, lines.slice(i + 1, end).join("\n"));
      i = end + 1;
      continue;
    }
    if (/^ {0,3}\$\$[ \t]*$/.test(line)) {
      const end = lines.findIndex((l, j) => j > i && /^ {0,3}\$\$[ \t]*$/.test(l));
      if (end > i + 1) {
        lift(i, end + 1, lines.slice(i + 1, end).join("\n").trim());
        i = end + 1;
        continue;
      }
    }
    if (/^ {0,3}>/.test(line)) {
      let end = i + 1;
      while (end < lines.length && /^ {0,3}>/.test(lines[end])) end++;
      lift(i, end, lines.slice(i, end).map((l) => l.replace(/^ {0,3}> ?/, "")).join("\n"));
      i = end;
      continue;
    }
    if (line.includes("|") && TABLE_DELIMITER.test(lines[i + 1] ?? "") && (lines[i + 1] ?? "").includes("-")) {
      let end = i + 2;
      while (end < lines.length && lines[end].trim() && lines[end].includes("|")) end++;
      lift(i, end, lines.slice(i, end).join("\n"));
      i = end;
      continue;
    }
    prose.push(line);
    i++;
  }
  flush();
  return out;
}
