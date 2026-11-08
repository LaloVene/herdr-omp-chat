// omp-chat: omp (oh-my-pi) sessions as a chat. One mod, four roles by `props.view`:
// "chat" (the conversation, cards and reply box), "header" (the terminal panes' header with the
// chat / terminal / btw buttons), "btw" (the side-question sidebar) and "stats" (the Usage panel
// under Agents). Needs the omp-chat-bridge extension in omp.
import { View } from "gpui-kit";
import { props } from "herdr";
import { Chat } from "./chat.js";
import { Header } from "./header.js";
import { Btw } from "./btw.js";
import { Stats } from "./stats.js";

const ROLES = { chat: Chat, header: Header, btw: Btw, stats: Stats };

export default class OmpChat extends View {
  init(_props, cx) {
    // A pane header gets { pane, terminal } from the app, with or without the layout's props.
    const p = props() ?? {};
    this.role = new (ROLES[p.view] ?? (p.pane ? Header : Chat))();
    this.role.init(cx);
  }

  render(cx) {
    return this.role.render(cx);
  }

  close() {
    return this.role.close();
  }
}
