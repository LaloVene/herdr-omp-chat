// The sidebar's Usage panel, under Agents: each provider account's rate-limit windows from omp's
// own `omp usage --json` (what /usage shows), the session (5 hour) and weekly windows foremost.
// Accounts with nothing used are left out, as are limits nobody has touched.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, theme } from "herdr";
import { narrow, labeled } from "./omp-chat-shared.js";

const REFRESH_MS = 5 * 60 * 1000;
const PROVIDER_NAMES = { anthropic: "Anthropic", openai: "OpenAI", "openai-codex": "Codex", "github-copilot": "Copilot", "google-antigravity": "Antigravity", google: "Google" };
const WINDOW_NAMES = { "5h": "Session", "7d": "Week", weekly: "Week", daily: "Day", monthly: "Month" };
const WINDOW_ORDER = ["5h", "daily", "7d", "weekly", "monthly"];
// Windows WINDOW_ORDER doesn't know go last.
const rank = (l) => {
  const i = WINDOW_ORDER.indexOf(l.window?.id);
  return i < 0 ? WINDOW_ORDER.length : i;
};

function until(ms) {
  const m = Math.max(0, Math.round((ms - Date.now()) / 60000));
  if (m < 60) return `${m}m`;
  if (m < 48 * 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${Math.round(m / 1440)}d`;
}

/** Accounts with something used, each with the limits worth showing, in window order. */
function accounts(report) {
  const out = [];
  for (const r of report?.reports ?? []) {
    const seen = new Set();
    const limits = (r.limits ?? []).filter((l) => {
      const shared = l.scope?.sharedGroup;
      if (shared && seen.has(shared)) return false;
      if (shared) seen.add(shared);
      return true;
    });
    const used = (l) => l.amount?.usedFraction ?? (l.amount?.limit ? l.amount.used / l.amount.limit : 0);
    if (!limits.some((l) => used(l) > 0)) continue;
    const shown = limits
      .filter((l) => used(l) > 0 || l.window?.id === "5h")
      .sort((a, b) => rank(a) - rank(b));
    const sameWindow = (l) => shown.filter((o) => o.window?.id === l.window?.id).length > 1;
    const who = r.metadata?.email ?? r.metadata?.accountId ?? "";
    out.push({
      name: PROVIDER_NAMES[r.provider] ?? r.provider,
      who,
      limits: shown.map((l) => ({
        // Limit ids name the provider, not the account.
        id: `${r.provider}:${who}:${l.id}`,
        label: sameWindow(l) ? l.label : WINDOW_NAMES[l.window?.id] ?? l.window?.label ?? l.label,
        short: l.window?.id === "weekly" ? "7d" : l.window?.id === "monthly" ? "mo" : l.window?.id ?? String(l.label ?? "?").slice(0, 3),
        fraction: Math.min(1, Math.max(0, used(l))),
        amount: l.amount?.unit === "percent" || !l.amount?.limit ? null : `${Math.max(0, l.amount.limit - (l.amount.used ?? 0))}/${l.amount.limit} left`,
        resetsAt: l.window?.resetsAt ?? null,
        status: l.status,
      })),
    });
  }
  return out;
}

export class Stats {
  init(cx) {
    this.report = null;
    this.error = null;
    this.loading = false;
    this.at = null;
    this.refresh(cx);
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
  }

  close() {}

  refresh(cx) {
    if (this.loading) return;
    this.loading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await exec("omp", ["usage", "--json"]);
        if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop() || "omp usage failed");
        this.report = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
        this.error = null;
        this.at = Date.now();
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      this.loading = false;
      cx.notify();
    });
  }

  render() {
    const t = theme();
    const root = v_flex().id("omp-stats").size_full().min_h(0).text_size(12).text_color(t.foreground);
    const list = accounts(this.report);
    // Bars and numbers show what is left; the color still warns as use grows.
    const color = (f, status) => (status === "exhausted" || f >= 0.9 ? t.blocked : f >= 0.7 ? t.working : t.accent);
    const left = (f) => Math.round((1 - f) * 100);
    // The rail (as omp-chat's sidebar lists): every limit's window ("Session", or "5h" unlabeled),
    // what's left, and a thin bar.
    if (narrow()) {
      const named = labeled();
      const limits = list.flatMap((a) => a.limits.map((l) => ({ ...l, who: a.name })));
      if (!limits.length) return root.items_center().justify_center().text_size(11).text_color(t.dim).child(this.report ? "–" : "…");
      return root.justify_end().px(named ? 9 : 6).pb(10).gap(8).text_size(named ? 11 : 10)
        .children(limits.map((l) => v_flex().id(`rail-${l.id}`).gap(3).tooltip(`${l.who} ${l.label}: ${left(l.fraction)}% left`)
          .child(h_flex().gap(4).justify_between()
            .child(div().min_w(0).truncate().text_color(named ? t.muted : t.dim).child(named ? l.label : l.short))
            .child(div().flex_none().text_color(t.foreground).child(`${left(l.fraction)}%`)))
          .child(div().w_full().h(3).rounded(2).bg(t.border)
            .child(div().h_full().rounded(2).w(`${Math.max(4, left(l.fraction))}%`).bg(color(l.fraction, l.status))))));
    }
    const header = h_flex().px(16).h(41).pt(14).pb(5).flex_none().items_center().justify_between()
      .child(div().text_size(11.5).font_medium().text_color(t.dim).child("Usage"))
      .child(h_flex().id("stats-refresh").gap(6).items_center().text_size(11).text_color(this.error ? t.blocked : t.dim).cursor_pointer()
        .hover((st) => st.text_color(t.foreground)).tooltip(this.error ? `omp usage: ${this.error}` : "Refresh provider usage")
        .on_click((_e, cx) => this.refresh(cx))
        .when(this.loading, (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(11).text_color(t.dim).spin(900)))
        .when(!this.loading && Boolean(this.at), (el) => el.child(new Date(this.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))));
    const body = v_flex().id("stats-body").flex_1().min_h(0).overflow_y_scroll().px(16).pb(10).gap(12);
    if (!this.report) {
      return root.child(header).child(body.child(div().text_size(11.5).text_color(this.error ? t.blocked : t.dim)
        .child(this.error ? `omp usage: ${this.error}` : "Reading provider usage…")));
    }
    if (!list.length) return root.child(header).child(body.child(div().text_size(11.5).text_color(t.dim).child("Nothing used yet.")));
    return root.child(header).child(body.children(list.map((a) => v_flex().gap(6)
      .child(h_flex().gap(6).items_center()
        .child(div().flex_none().text_size(12).font_medium().child(a.name))
        .child(div().flex_1().truncate().text_size(10.5).text_color(t.dim).child(a.who)))
      .children(a.limits.map((l) => v_flex().id(`limit-${l.id}`).gap(3)
        .tooltip(l.resetsAt ? `Resets ${new Date(l.resetsAt).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}` : l.label)
        .child(h_flex().gap(6).text_size(11)
          .child(div().flex_1().truncate().text_color(t.muted).child(l.label))
          .child(div().flex_none().text_color(t.foreground).child(l.amount ?? `${left(l.fraction)}% left`))
          .when(Boolean(l.resetsAt), (el) => el.child(div().flex_none().text_color(t.dim).child(until(l.resetsAt)))))
        .child(div().w_full().h(4).rounded(2).bg(t.border)
          .child(div().h_full().rounded(2).w(`${Math.max(2, left(l.fraction))}%`).bg(color(l.fraction, l.status)))))))));
  }
}
