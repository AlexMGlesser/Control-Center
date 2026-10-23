import { execFile } from "child_process";
import { EventEmitter } from "events";
import { Socket } from "net";
import { net } from "electron";
import { health } from "./api.js";
import { currentSession } from "./store.js";

// The one live event stream to the PC, the same rules as the phone
// (mobile architecture 7.1-7.2): a heartbeat watchdog, backoff, a grace
// period before calling it an outage, and a reason when it is one.

export const HEARTBEAT_TIMEOUT_MS = 45_000;
/** A stream that hasn't opened by now is abandoned and retried. */
export const OPEN_TIMEOUT_MS = 20_000;
export const GRACE_MS = 60_000;
const BACKOFF_SECONDS = [1, 2, 5, 10, 30];
const STEADY_RETRY_SECONDS = 60;

export function retryDelayMs(attempt) {
  return (BACKOFF_SECONDS[attempt] ?? STEADY_RETRY_SECONDS) * 1000;
}

export function isOutage(failingSince, now) {
  return now - failingSince >= GRACE_MS;
}

export const CAUSES = {
  OFFLINE: "This computer is offline.",
  TAILSCALE_OFF: "Tailscale is off on this computer.",
  SERVER_STOPPED: "Control Center was shut down on the PC.",
  PC_UNREACHABLE: "Can't reach the PC. It may be asleep or off.",
  CONTROL_CENTER_DOWN: "Control Center isn't running on the PC.",
  UNKNOWN: "Can't connect to the PC."
};

/**
 * Exactly one "lost" alert per outage and one "reconnected" notice when it
 * ends. Pure, so it can be tested.
 */
export class OutageNotifier {
  alerted = false;

  /** Returns { lost: cause } / { reconnected: true } / null. */
  onState(state) {
    if (state.status === "disconnected") {
      if (this.alerted) return null;
      this.alerted = true;
      return { lost: state.cause };
    }
    if (state.status === "connected" && this.alerted) {
      this.alerted = false;
      return { reconnected: true };
    }
    if (state.status === "idle" || state.status === "unauthorized") this.alerted = false;
    return null;
  }
}

function tailscaleRunning() {
  return new Promise((resolve) => {
    execFile("tailscale", ["status", "--json"], { timeout: 4000, windowsHide: true }, (error, stdout) => {
      if (error && !stdout) return resolve(null); // CLI not installed: unknown
      try {
        resolve(JSON.parse(stdout).BackendState === "Running");
      } catch {
        resolve(null);
      }
    });
  });
}

function canConnect(host, port) {
  return new Promise((resolve) => {
    const socket = new Socket();
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(4000, () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, host, () => done(true));
  });
}

export class ConnectionManager extends EventEmitter {
  state = { status: "idle" };
  #running = false;
  #abort = null;
  #wake = null;
  #lastServerStoppingAt = 0;

  start() {
    if (this.#running) return;
    this.#running = true;
    this.#loop();
  }

  stop() {
    this.#running = false;
    this.#abort?.abort();
    this.#wake?.();
    this.#setState({ status: "idle" });
  }

  /** Retry now instead of waiting out the backoff (Retry button, network back). */
  reconnectNow() {
    this.#wake?.();
  }

  #setState(state) {
    this.state = state;
    this.emit("state", state);
  }

  async #loop() {
    let attempt = 0;
    let failingSince = 0;
    while (this.#running) {
      const session = currentSession();
      if (!session) {
        this.#setState({ status: "idle" });
        this.#running = false;
        return;
      }
      if (!["reconnecting", "disconnected"].includes(this.state.status)) this.#setState({ status: "connecting" });

      const result = await this.#streamOnce(session);
      if (!this.#running) return;
      if (result === "unauthorized") {
        this.#setState({ status: "unauthorized" });
        this.#running = false;
        this.emit("unauthorized");
        return;
      }
      if (result === "was-connected" || failingSince === 0) {
        failingSince = Date.now();
        attempt = 0;
      }
      if (this.state.status !== "disconnected") this.#setState({ status: "reconnecting", failingSince, attempt });

      // Wait out the backoff; declare an outage once the grace period passes.
      const waitUntil = Date.now() + retryDelayMs(attempt);
      attempt += 1;
      let woken = false;
      while (this.#running && !woken && Date.now() < waitUntil) {
        if (this.state.status !== "disconnected" && isOutage(failingSince, Date.now())) {
          this.#setState({ status: "disconnected", since: Date.now(), cause: await this.#diagnose(session) });
        }
        woken = await new Promise((resolve) => {
          const timer = setTimeout(() => resolve(false), Math.min(1000, Math.max(1, waitUntil - Date.now())));
          this.#wake = () => {
            clearTimeout(timer);
            resolve(true);
          };
        });
        this.#wake = null;
      }
    }
  }

  /** Opens the stream and resolves when it ends: "unauthorized", "was-connected" or "failed". */
  async #streamOnce(session) {
    const abort = new AbortController();
    this.#abort = abort;
    let connected = false;
    let lastDataAt = Date.now();
    const startedAt = Date.now();
    // A stream that goes quiet past the heartbeat is dead even if the socket
    // hasn't noticed; one that never opens is given up on too.
    const watchdog = setInterval(() => {
      if (connected && Date.now() - lastDataAt > HEARTBEAT_TIMEOUT_MS) abort.abort();
      if (!connected && Date.now() - startedAt > OPEN_TIMEOUT_MS) abort.abort();
    }, 5000);

    try {
      const res = await net.fetch(`${session.baseUrl}/api/events/stream`, {
        headers: { Authorization: `Bearer ${session.token}`, Accept: "text/event-stream" },
        signal: abort.signal
      });
      if (res.status === 401) return "unauthorized";
      if (!res.ok || !res.body) return "failed";
      connected = true;
      lastDataAt = Date.now();
      this.#setState({ status: "connected", since: Date.now() });

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        lastDataAt = Date.now();
        buffer += decoder.decode(value, { stream: true });
        let split;
        while ((split = buffer.indexOf("\n\n")) >= 0) {
          this.#handleBlock(buffer.slice(0, split));
          buffer = buffer.slice(split + 2);
        }
      }
      return "was-connected";
    } catch {
      return connected ? "was-connected" : "failed";
    } finally {
      clearInterval(watchdog);
      this.#abort = null;
    }
  }

  #handleBlock(block) {
    let type = "message";
    const data = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) type = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (type === "ping" || !data.length) return;
    let message;
    try {
      message = JSON.parse(data.join("\n"));
    } catch {
      return;
    }
    // "snapshot" is recent history; only live events matter here.
    if (message.type !== "event" || !message.event) return;
    if (message.event.type === "server-stopping") this.#lastServerStoppingAt = Date.now();
    this.emit("event", message.event);
  }

  /** Why the PC can't be reached, checked in order (mobile architecture 7.2). */
  async #diagnose(session) {
    if (this.#lastServerStoppingAt && Date.now() - this.#lastServerStoppingAt < GRACE_MS * 2) return CAUSES.SERVER_STOPPED;
    if (!net.isOnline()) return CAUSES.OFFLINE;
    const url = new URL(session.baseUrl);
    const viaTailscale = url.hostname.endsWith(".ts.net") || url.hostname.startsWith("100.");
    if (viaTailscale && (await tailscaleRunning()) === false) return CAUSES.TAILSCALE_OFF;
    const port = Number(url.port) || (url.protocol === "https:" ? 443 : 80);
    if (!(await canConnect(url.hostname, port))) return CAUSES.PC_UNREACHABLE;
    return (await health(session.baseUrl)) ? CAUSES.UNKNOWN : CAUSES.CONTROL_CENTER_DOWN;
  }
}
