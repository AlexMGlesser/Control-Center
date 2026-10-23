import { icon } from "../icons.js";
import { api, el, esc, toast } from "../lib.js";
import { frame, note } from "./frame.js";

// Servers: the Server Manager list from the PC, and Open SSH in this
// computer's own terminal (with this computer's SSH keys).

const address = (server) => {
  const user = server.ssh.username || "(user)";
  const host = server.ssh.host || "(host)";
  return server.ssh.port === 22 ? `${user}@${host}` : `${user}@${host}:${server.ssh.port}`;
};

export async function render(host, ctx) {
  const view = frame(host, { title: "Servers", onBack: ctx.closeApp });

  async function load() {
    let servers = [];
    try {
      servers = (await api("/api/apps/server-manager-app/servers")).servers || [];
    } catch (error) {
      view.content.innerHTML = note(error.message);
      return;
    }
    if (!servers.length) {
      view.content.innerHTML = note("No servers yet. Add them in Server Manager on the PC.");
      return;
    }
    const list = el(`<div class="list"></div>`);
    for (const server of servers) {
      const card = el(`
        <div class="panel chamfer" style="display:flex;align-items:center;gap:14px">
          <span class="glyph">${icon("server")}</span>
          <div style="flex:1;min-width:0">
            <div style="font-weight:600">${esc(server.name)} ${server.environment ? `<span class="muted small">· ${esc(server.environment)}</span>` : ""}</div>
            <div class="muted small ellipsis">${esc(address(server))}</div>
          </div>
          <button class="btn primary small" ${server.ssh.host ? "" : "disabled"}>${icon("terminal")} Open SSH</button>
        </div>`);
      card.querySelector("button").addEventListener("click", async () => {
        try {
          await window.cc.openSsh(server.ssh);
        } catch (error) {
          toast(error.message, { tone: "error" });
        }
      });
      list.append(card);
    }
    list.append(el(`<p class="muted small">SSH uses this computer's own keys or a password. Keys saved on the PC stay there.</p>`));
    view.content.replaceChildren(list);
  }

  ctx.onEvent((event) => {
    if (event.appId === "server-manager-app" && event.type === "data-changed") load();
  });
  await load();
}
