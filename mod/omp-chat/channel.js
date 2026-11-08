// The files the omp-chat-bridge extension keeps per terminal, and how this mod reaches them.
import { appHome, panes, focused, readTextFile, writeTextFile, watchFolder, hc, shared, setShared } from "herdr";
import * as fs from "fs/promises";

export const ROOT = `${appHome()}/data/omp-chat`;
export const dirOf = (terminal) => `${ROOT}/${terminal}`;
const PANES_KEY = "omp-chat.panes";

export async function readJson(path) {
  try {
    const text = await readTextFile(path);
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

export async function listDir(path) {
  try {
    return await fs.readdir(path);
  } catch {
    return [];
  }
}

/** Every terminal with a live bridge folder: { [terminal]: state.json }. */
export async function loadStates() {
  const out = {};
  for (const name of await listDir(ROOT)) {
    const state = await readJson(`${dirOf(name)}/state.json`);
    if (state?.terminal === name) out[name] = state;
  }
  return out;
}

/** Calls `onChange` after anything under the bridge root changes, until `alive()` turns false. */
export function watchRoot(cx, alive, onChange) {
  cx.spawn(async (cx) => {
    try { await fs.mkdir(ROOT, { recursive: true }); } catch {}
    while (alive()) {
      let changed;
      try {
        changed = await watchFolder(ROOT);
      } catch {
        return;
      }
      if (alive()) await onChange(changed, cx);
    }
  });
}

/** Chat pane id → its omp terminal (`shared("omp-chat.panes")`), for chat panes that still exist. */
export function chatPanes() {
  const live = new Set(panes().map((p) => p.pane));
  return Object.fromEntries(Object.entries(shared(PANES_KEY) ?? {}).filter(([pane]) => live.has(pane)));
}

export function setChatPanes(map) {
  setShared(PANES_KEY, map);
}

/** A pane's omp: its own terminal running the bridge, or the terminal a chat pane stands for. */
export function ompOfPane(p, states) {
  if (p.terminal) return states[p.terminal] && !p.program?.shell ? p.terminal : null;
  return chatPanes()[p.pane] ?? null;
}

/** The omp a tab shows: its focused pane's, else its first pane's. */
export function ompTerminalOf(tab, states) {
  const mine = panes().filter((p) => p.tab === tab);
  const pick = mine.find((p) => p.focused && ompOfPane(p, states)) ?? mine.find((p) => ompOfPane(p, states));
  return pick ? ompOfPane(pick, states) : null;
}

export async function sendRequest(terminal, request) {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  await writeTextFile(`${dirOf(terminal)}/requests/${id}.json`, JSON.stringify(request), null);
}

/** The terminal's screen as plain lines. */
export async function screen(terminal, lines = 60) {
  const r = await hc(["read", terminal, "--lines", String(lines)]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || "hc read failed");
  return r.stdout.split("\n");
}

export async function keys(terminal, list) {
  const r = await hc(["keys", terminal, ...list]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || "hc keys failed");
}

/** Pastes text and presses Enter. `force`: even while omp shows a dialog. */
export async function send(terminal, text, force = false) {
  const r = await hc(["send", ...(force ? ["--force"] : []), terminal, text]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || r.stdout.trim() || "hc send failed");
}
