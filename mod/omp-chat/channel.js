// The files the omp-chat-bridge extension keeps per terminal, and how this mod reaches them.
import { appHome, panes, readTextFile, writeTextFile, watchFolder, hc, shared, setShared } from "herdr";
import * as fs from "fs/promises";
import { PANES_KEY } from "./omp-chat-shared.js";

export const ROOT = `${appHome()}/data/omp-chat`;
export const dirOf = (terminal) => `${ROOT}/${terminal}`;

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

/** Chat pane id → its omp terminal (`shared(PANES_KEY)`), for chat panes that still exist. */
export function chatPanes() {
  const live = new Set(panes().map((p) => p.pane));
  return Object.fromEntries(Object.entries(shared(PANES_KEY) ?? {}).filter(([pane]) => live.has(pane)));
}

export function setChatPanes(map) {
  setShared(PANES_KEY, map);
}

/** Drops `pane`'s entry if it still stands for `terminal` (even once the pane is gone); whether it did. */
export function forgetChatPane(pane, terminal) {
  const map = { ...(shared(PANES_KEY) ?? {}) };
  if (map[pane] !== terminal) return false;
  delete map[pane];
  setChatPanes(map);
  return true;
}

/** The omp a tab shows: its focused pane's, else its first pane's. A pane's omp is its own terminal running the bridge, or the one a chat pane stands for. */
export function ompTerminalOf(tab, states) {
  const chat = shared(PANES_KEY) ?? {};
  let first = null;
  for (const p of panes()) {
    if (p.tab !== tab) continue;
    const omp = p.terminal ? (states[p.terminal] && !p.program?.shell ? p.terminal : null) : (chat[p.pane] ?? null);
    if (omp && p.focused) return omp;
    first ??= omp;
  }
  return first;
}

export async function sendRequest(terminal, request) {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  await writeTextFile(`${dirOf(terminal)}/requests/${id}.json`, JSON.stringify(request), null);
}

/** Runs `hc`, throwing its error output on failure. */
async function hcOk(args) {
  const r = await hc(args);
  if (r.code !== 0) throw new Error(r.stderr.trim() || r.stdout.trim() || `hc ${args[0]} failed`);
  return r;
}

/** The terminal's screen as plain lines. */
export async function screen(terminal, lines = 60) {
  return (await hcOk(["read", terminal, "--lines", String(lines)])).stdout.split("\n");
}

export async function keys(terminal, list) {
  await hcOk(["keys", terminal, ...list]);
}

/** Pastes text and presses Enter. `force`: even while omp shows a dialog. */
export async function send(terminal, text, force = false) {
  await hcOk(["send", ...(force ? ["--force"] : []), terminal, text]);
}
