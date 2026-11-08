// An answer's markdown as parts: figures and math drawn the way omp draws them, and every block
// worth copying on its own (code, tables, diagrams, equations) a part of its own with its source
// as `copy`. ```mermaid as text art (omp's native renderer), ```svg as images with omp's theme
// tokens resolved, a chart under numeric tables (omp's table-chart, local plan as under
// `tui.autoGraph: always`), LaTeX as Unicode (omp's latex-to-unicode inline, its 2D layout for
// display blocks). Drawing uses omp's own modules from the plugin install (~/.omp/plugins);
// without them an answer is plain markdown, still split into blocks.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { blocks, closesFence, fenceOpen } from "./blocks.js";

export type Part = ({ t: "md"; text: string } | { t: "pre"; text: string } | { t: "img"; path: string; w: number; h: number }) & { copy?: string };
type Segment = { kind: "md"; text: string } | { kind: "mermaid"; source: string; raw: string; copy: string } | { kind: "svg" | "math"; source: string; copy: string };

const PI = process.env.OMP_CHAT_PI_ROOT ?? join(homedir(), ".omp/plugins/node_modules/@oh-my-pi");
const FENCE = /^ {0,3}(?:`{3,}|~{3,})/m;
const QUOTE = /^ {0,3}>/m;
const TABLE_ROW = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*\|/m;
// A cheap first look for math; omp's delimiter grammar then decides (`$5 and $10` is not math).
const MATH_OPENER = /\$|\\\(|\\\[/;
// What could turn converted math back into markdown syntax (`|` included: math sits in table cells).
const MD_SPECIAL = /[\\`*_[\]<>|#~]/g;
/** Rendered svgs kept on disk; past this the oldest go. */
const KEEP_FILES = 400;

/** Whether `text` holds anything {@link answerParts} splits out or draws. */
export function hasParts(text: string): boolean {
  return FENCE.test(text) || QUOTE.test(text) || MATH_OPENER.test(text) || (text.includes("|") && TABLE_ROW.test(text));
}

type Omp = {
  renderMermaidAscii: (text: string, options?: Record<string, unknown>) => string;
  prepareSvg: (svg: string, palette: Record<string, string>) => string;
  splitTableCharts: (markdown: string, streaming: boolean) => ({ kind: "markdown"; text: string } | { kind: "chart"; table: unknown })[];
  hasChartTable: (markdown: string) => boolean;
  lookupTableChart: (table: unknown) => string | null | Promise<void>;
  latexToUnicode: (src: string) => string;
  latexToBlock: (src: string) => string[];
  mathSpanAt: (source: string, at: number) => { end: number; body: string } | undefined;
  mathBlockAt: (source: string) => { raw: string; body: string } | undefined;
};

let omp: Omp | null | undefined;

async function loadOmp(): Promise<Omp | null> {
  if (omp !== undefined) return omp;
  try {
    // Dynamic: omp's install path is only known at run time and may be absent.
    const natives = await import(join(PI, "pi-natives/native/index.js"));
    const svg = await import(join(PI, "pi-tui/src/chat/svg-source.ts"));
    const charts = await import(join(PI, "pi-tui/src/chat/table-chart.ts"));
    const unicode = await import(join(PI, "pi-tui/src/latex-to-unicode.ts"));
    const block = await import(join(PI, "pi-tui/src/latex-block.ts"));
    const delimiters = await import(join(PI, "pi-utils/src/math-delimiters.ts"));
    charts.setTableCharts("always");
    omp = {
      renderMermaidAscii: natives.renderMermaidAscii, prepareSvg: svg.prepareSvg, splitTableCharts: charts.splitTableCharts, hasChartTable: charts.hasChartTable, lookupTableChart: charts.lookupTableChart,
      latexToUnicode: unicode.latexToUnicode, latexToBlock: block.latexToBlock, mathSpanAt: delimiters.mathSpanAt, mathBlockAt: delimiters.mathBlockAt,
    };
  } catch {
    omp = null;
  }
  return omp;
}

/** Top-level ```mermaid / ```svg fences lifted out of prose; other fences and unclosed ones stay prose. */
function splitFences(markdown: string): Segment[] {
  const out: Segment[] = [];
  let prose: string[] = [];
  let fence: { marker: string; lang: "mermaid" | "svg" | null; body: string[]; raw: string[] } | null = null;
  const flush = () => {
    if (prose.join("\n").trim()) out.push({ kind: "md", text: prose.join("\n") });
    prose = [];
  };
  for (const line of markdown.split("\n")) {
    if (fence) {
      fence.raw.push(line);
      if (closesFence(line, fence.marker)) {
        const body = fence.body.join("\n");
        if (fence.lang) {
          flush();
          out.push(fence.lang === "mermaid" ? { kind: "mermaid", source: body, raw: fence.raw.join("\n"), copy: body } : { kind: "svg", source: body, copy: body });
        } else prose.push(...fence.raw);
        fence = null;
      } else fence.body.push(line);
      continue;
    }
    const open = fenceOpen(line);
    if (open) {
      const lang = open.info.trim().split(/[ \t]/, 1)[0]!.toLowerCase();
      fence = { marker: open.marker, lang: lang === "mermaid" || lang === "svg" ? lang : null, body: [], raw: [line] };
      continue;
    }
    prose.push(line);
  }
  if (fence) prose.push(...fence.raw);
  flush();
  return out;
}

/** Inline math in `text` as Unicode; code spans stay as written. */
function inlineMath(text: string, o: Omp): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === "`") {
      const run = /^`+/.exec(text.slice(i))![0];
      const close = text.indexOf(run, i + run.length);
      const end = close === -1 ? i + run.length : close + run.length;
      out += text.slice(i, end);
      i = end;
      continue;
    }
    const span = o.mathSpanAt(text, i);
    if (span) {
      out += o.latexToUnicode(span.body).replace(/\s*\n\s*/g, " ").replace(MD_SPECIAL, "\\$&");
      i = span.end;
      continue;
    }
    out += text[i];
    i++;
  }
  return out;
}

/** Prose with its math drawn: display blocks as text-art parts, inline math as Unicode; fenced code stays as written. */
function mathParts(prose: string, o: Omp): Segment[] {
  const out: Segment[] = [];
  let chunk = "";
  const flush = () => {
    if (chunk.trim()) out.push({ kind: "md", text: inlineMath(chunk, o) });
    chunk = "";
  };
  let fence: string | null = null;
  let at = 0;
  while (at < prose.length) {
    const next = prose.indexOf("\n", at);
    const lineEnd = next === -1 ? prose.length : next + 1;
    const line = prose.slice(at, lineEnd);
    const bare = prose.slice(at, next === -1 ? prose.length : next);
    const open = fence ? null : fenceOpen(bare);
    if (fence || open) {
      // Code goes through as written: a fenced block is never math.
      flush();
      out.push({ kind: "md", text: line });
      fence = open ? open.marker : closesFence(bare, fence!) ? null : fence;
    } else {
      const block = o.mathBlockAt(prose.slice(at));
      if (block) {
        flush();
        out.push({ kind: "math", source: o.latexToBlock(block.body).join("\n"), copy: block.body.trim() });
        at += block.raw.length;
        continue;
      }
      chunk += line;
    }
    at = lineEnd;
  }
  flush();
  // Neighbouring prose and code lines back into one markdown run, so a fenced block stays whole.
  const merged: Segment[] = [];
  for (const s of out) {
    const last = merged[merged.length - 1];
    if (s.kind === "md" && last?.kind === "md") last.text += s.text;
    else merged.push(s);
  }
  return merged;
}

/** Writes a themed svg once (named by its content) and returns its path from the app home and its size. */
function svgFile(svg: string, appHome: string): Part {
  const dir = join(appHome, "data/omp-chat-render");
  const name = `${createHash("sha1").update(svg).digest("hex").slice(0, 20)}.svg`;
  const file = join(dir, name);
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    // Other chat panes' helpers share the folder: write whole files only, and expect theirs to come and go.
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, svg);
    renameSync(temp, file);
    const files = readdirSync(dir).filter((f) => f.endsWith(".svg"))
      .map((f) => ({ f, at: statSync(join(dir, f), { throwIfNoEntry: false })?.mtimeMs ?? 0 })).sort((a, b) => a.at - b.at);
    for (const old of files.slice(0, Math.max(0, files.length - KEEP_FILES))) rmSync(join(dir, old.f), { force: true });
  }
  const box = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(svg);
  const width = box ? Number(box[1]) : Number(/\swidth\s*=\s*["']?([\d.]+)/i.exec(svg)?.[1] ?? 600);
  const height = box ? Number(box[2]) : Number(/\sheight\s*=\s*["']?([\d.]+)/i.exec(svg)?.[1] ?? 400);
  return { t: "img", path: `data/omp-chat-render/${name}`, w: width || 600, h: height || 400 };
}

/** An answer's markdown as parts, or null when it is one plain markdown run. */
export async function answerParts(markdown: string, palette: Record<string, string>, appHome: string): Promise<Part[] | null> {
  const o = await loadOmp();
  const parts: Part[] = [];
  let drew = false;
  const segments = !o ? [{ kind: "md", text: markdown } as Segment] : splitFences(markdown).flatMap((s): Segment[] => {
    if (s.kind !== "md") return [s];
    const drawn = mathParts(s.text, o);
    drew ||= drawn.length !== 1 || drawn[0]!.kind !== "md" || drawn[0]!.text !== s.text;
    return drawn;
  });
  for (const segment of segments) {
    if (segment.kind === "mermaid") {
      let art: string | null = null;
      try { art = o!.renderMermaidAscii(segment.source.trim(), { colorMode: "none" }); } catch {}
      parts.push(art ? { t: "pre", text: art, copy: segment.copy } : { t: "md", text: segment.raw, copy: segment.copy });
    } else if (segment.kind === "math") {
      parts.push({ t: "pre", text: segment.source, copy: segment.copy });
    } else if (segment.kind === "svg") {
      parts.push({ ...svgFile(o!.prepareSvg(segment.source, palette), appHome), copy: segment.copy });
    } else if (!o || !o.hasChartTable(segment.text)) {
      parts.push(...blocks(segment.text));
    } else {
      for (const piece of o.splitTableCharts(segment.text, false)) {
        if (piece.kind === "markdown") {
          parts.push(...blocks(piece.text));
          continue;
        }
        const chart = o.lookupTableChart(piece.table);
        if (typeof chart !== "string") continue;
        parts.push(svgFile(o.prepareSvg(chart, palette), appHome));
      }
    }
  }
  return drew || parts.length > 1 || parts.some((p) => p.t !== "md" || p.copy) ? parts : null;
}
