// What the omp-chat mods share. Herdr won't load a module from another mod's folder, so each mod
// links this file as ./omp-chat-shared.js and install.sh copies the real file into each one.
import { svg, image } from "gpui-kit";
import { layout, panes, terminals, shared } from "herdr";

/** Chat pane id → the omp terminal it parked. */
export const PANES_KEY = "omp-chat.panes";
/** Turns of parked omps someone saw "done" in their chat pane: { [terminal]: turn }. */
export const SEEN_KEY = "omp-chat.seen";

export function findNode(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too. omp-chat
// keeps the full lists down to 120px (Herdr's own mods switch at 160).
export const sidebarWidth = () => findNode(layout(), "sidebar")?.size?.px ?? Infinity;
export const narrow = () => sidebarWidth() < 120;
// Between the bare rail and the full list: rail rows with their names.
export const labeled = () => sidebarWidth() >= 84;

// What a stored space color name looks like on an avatar: one strong color per hue, light and dark alike.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

/** A space's own avatar color (`space.colors`, assigned by the spaces mod). */
export function spaceColor(t, id) {
  const color = (shared("space.colors") ?? {})[id] ?? "ansi6";
  return color.startsWith("#") ? color : (MARK[color] ?? t[color] ?? t.foreground);
}

/** A program's icon from the app's program table: a one-color glyph or a picture. */
export function programIcon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

// omp titles start with an emoji or Nerd Font glyph, which /resume draws as the session's icon.
export const SESSION_ICON = /^(?:\p{Extended_Pictographic}|[\u2190-\u2BFF\uE000-\uF8FF]|[\u{F0000}-\u{10FFFD}])\uFE0F?/u;

/**
 * The omps shown as chat panes, as [{ pane, term, status }]: omp-chat parks their terminals, so
 * agents() and the spaces' own status leave them out. `ps`: panes(), if the caller has it.
 */
export function chatPaneOmps(ps = panes()) {
  const map = shared(PANES_KEY) ?? {};
  if (!Object.keys(map).length) return [];
  const all = terminals();
  const seen = shared(SEEN_KEY) ?? {};
  return ps.flatMap((pane) => {
    const term = map[pane.pane] && !pane.terminal ? all.find((x) => x.address === map[pane.pane]) : null;
    if (!term) return [];
    // Herdr never sees a parked terminal: its "done" counts as seen once its chat pane showed that turn.
    const seenDone = term.status === "done" && (pane.focused || seen[term.address] === term.turn);
    const status = term.status === "error" ? "blocked" : seenDone ? "idle" : (term.status ?? "idle");
    return [{ pane, term, status }];
  });
}
