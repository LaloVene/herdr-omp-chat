import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, run, props, window, shared, setShared, updates } from "herdr";
import { sidebarWidth, narrow } from "./omp-chat-shared.js";

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const rail = narrow();
  if (!rail) setShared("sidebar.width", sidebarWidth());
  run("layout.resize", { id: "sidebar", px: rail ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

export default class OmpChatChrome extends View {
  button(id, label, action) {
    const t = theme();
    return div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(action).child(label);
  }
  render() {
    const t = theme();
    const collapsed = narrow();
    // On the macOS rail the traffic lights fill the brand row, so the sidebar toggle sits in the footer.
    const footerToggle = collapsed && window()?.platform === "macos";
    if (props()?.footer) {
      const ready = div().size(6).rounded_full().bg(t.accent);
      // omp-chat's footer: Settings only (no Add machine).
      return v_flex().size_full().bg(t.chrome).border_t(1).border_color(t.border).px(8).pt(4).pb(8).text_size(13)
        .when(collapsed, el => el.px(0).items_center())
        .child(h_flex().id("settings").h(28).px(8).gap(9).items_center().rounded(8)
          .when(collapsed, el => el.relative().w(32).px(0).justify_center().tooltip("Settings"))
          .text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground)).cursor_pointer()
          .on_click(() => run("app.settings")).child(svg("mods/workspace-chrome/settings.svg").size(14))
          .when(!collapsed, el => el.child("Settings"))
          .when(Boolean(updates().app.ready), el => el.child(collapsed ? ready.absolute().top(5).right(6) : ready)))
        .when(footerToggle, el => el.flex_row().justify_center().gap(4).child(this.button("sidebar-toggle", svg("mods/workspace-chrome/sidebar.svg").size(15), toggleSidebar)));
    }
    return h_flex().size_full().bg(t.chrome).pl(collapsed ? 6 : 14).pr(10).gap(4).items_center().text_size(13.5)
      .when(window()?.platform === "macos" && !window()?.fullscreen && !collapsed, el => el.pl(76))
      .when(!collapsed, el => el.child(h_flex().flex_1().gap(8).items_center().child(image("frame/welcome/herdr.png").size(20).rounded(5)).child(div().font_semibold().text_color(t.foreground).child("Herdr"))))
      .when(!collapsed, el => el.child(this.button("search", svg("mods/workspace-chrome/search.svg").size(15), () => run("mod.open", { name: "picker" }))))
      .when(!footerToggle, el => el.child(this.button("sidebar-toggle", svg("mods/workspace-chrome/sidebar.svg").size(15), toggleSidebar)));
  }
}
