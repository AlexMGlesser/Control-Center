import { icon } from "../icons.js";
import { api, el, esc, toast } from "../lib.js";
import { frame } from "./frame.js";

// Jarvis chat, shared with the PC and the phone (one history). Messages sent
// from here carry this computer as their origin, so replies come back here.

export async function render(host, ctx) {
  const view = frame(host, { title: "Jarvis", flush: true, actions: `<span data-status-pill>${ctx.statusPill()}</span>` });
  view.content.append(
    el(`<div style="display:contents">
      <div class="chat" id="chat"></div>
      <div id="chip" hidden style="padding:0 20px 8px"></div>
      <form class="composer" id="composer">
        <textarea id="input" rows="1" placeholder="Message Jarvis…"></textarea>
        <button class="btn primary" type="submit" title="Send">${icon("send")}</button>
      </form>
    </div>`)
  );
  const chat = view.content.querySelector("#chat");
  const input = view.content.querySelector("#input");
  const chip = view.content.querySelector("#chip");
  const myId = ctx.state.session?.deviceId;

  let messages = [];
  /** Sent from here, waiting for the reply: [{ turnId, tools: [] }] */
  let pending = [];
  let queuedAhead = 0;

  function bubble(message) {
    const from = message.role === "user" && message.device?.id && message.device.id !== myId ? `From ${message.device.name || "another device"}` : "";
    return `<div class="bubble chamfer ${message.role === "user" ? "user" : "agent"}">${from ? `<span class="from">${esc(from)}</span>` : ""}${esc(message.text)}</div>`;
  }

  function draw() {
    const nearBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 80;
    const thinking = pending
      .map((turn) => {
        const lines = turn.tools.map((tool) => `<div class="small muted">↳ ${esc(tool)}</div>`).join("");
        const ahead = queuedAhead > 0 ? ` (${queuedAhead} ahead in the queue)` : "";
        return `<div class="bubble chamfer agent muted">Thinking…${esc(ahead)}${lines}</div>`;
      })
      .join("");
    chat.innerHTML = (messages.length ? messages.map(bubble).join("") : `<p class="note">Ask Jarvis anything: your schedule, an alarm, music, the news…</p>`) + thinking;
    if (nearBottom) chat.scrollTop = chat.scrollHeight;
  }

  function drawChip() {
    const app = ctx.state.openedByJarvis;
    chip.hidden = !app;
    if (!app) return;
    chip.innerHTML = `<button class="btn small">${esc(app.name)} opened · Show it</button>`;
    chip.querySelector("button").addEventListener("click", () => ctx.openApp(app.id));
  }

  async function refresh() {
    try {
      const result = await api("/api/chat/messages?limit=120");
      messages = result.messages || [];
      draw();
    } catch (error) {
      chat.innerHTML = `<p class="note">${esc(error.message)}</p>`;
    }
  }

  async function refreshQueue() {
    const status = await api("/api/agent/queue/status").catch(() => null);
    queuedAhead = Math.max(0, (status?.queue?.queueLength || 0) - 1);
    draw();
  }

  async function send() {
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    input.style.height = "";
    try {
      const result = await api("/api/chat/messages", { method: "POST", body: { text } });
      if (result.userMessage) messages.push(result.userMessage);
      if (result.turnId) pending.push({ turnId: result.turnId, tools: [] });
      draw();
      chat.scrollTop = chat.scrollHeight;
      refreshQueue();
    } catch (error) {
      input.value = text;
      toast(error.message, { tone: "error" });
    }
  }

  ctx.onEvent((event) => {
    const meta = event.meta || {};
    if (event.type === "chat") {
      pending = pending.filter((turn) => turn.turnId !== meta.turnId);
      refresh();
    } else if (event.type === "chat-queued") {
      refresh();
    } else if (event.type === "thought" && meta.turnId && meta.tool) {
      const turn = pending.find((item) => item.turnId === meta.turnId);
      if (turn) {
        turn.tools.push(meta.tool);
        draw();
      }
    }
  });

  view.content.querySelector("#composer").addEventListener("submit", (event) => {
    event.preventDefault();
    send();
  });
  input.addEventListener("keydown", (event) => {
    // Enter sends; Shift+Enter is a new line.
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  });
  input.addEventListener("input", () => {
    input.style.height = "";
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  });

  const onChip = () => drawChip();
  document.addEventListener("opened-by-jarvis", onChip);
  drawChip();
  await refresh();
  chat.scrollTop = chat.scrollHeight;
  input.focus();
  return () => document.removeEventListener("opened-by-jarvis", onChip);
}
