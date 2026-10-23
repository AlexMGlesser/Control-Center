// Shared helpers for the views: API calls, HTML escaping, dialogs, formatting.

export class ApiError extends Error {
  constructor(status, code, message, data) {
    super(message);
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

/**
 * JSON call to the home PC. Same-origin: the main process adds the token.
 * `allowError` returns the body of a 4xx instead of throwing (the Wikipedia
 * archive answers "not found" as JSON).
 */
export async function api(path, { method = "GET", body, allowError = false } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  } catch (error) {
    throw new ApiError(0, "NETWORK", `Can't reach the PC: ${error.message}`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !(allowError && res.status >= 400 && res.status < 500 && ![401, 403].includes(res.status))) {
    throw new ApiError(res.status, data.code, data.message || `Request failed (${res.status}).`, data);
  }
  return data;
}

export const q = (value) => encodeURIComponent(value);

export function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Builds an element from an HTML string (one root). */
export function el(html) {
  const template = document.createElement("template");
  template.innerHTML = html.trim();
  return template.content.firstElementChild;
}

export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export function shortDate(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString([], { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

export function longDate(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

export function timeLabel(date) {
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** A short-lived note at the bottom of the window. */
export function toast(message, { tone = "", action, onAction, timeout = 4000 } = {}) {
  const host = document.getElementById("toasts");
  const node = el(`<div class="toast ${tone}"><span>${esc(message)}</span>${action ? `<button class="link">${esc(action)}</button>` : ""}</div>`);
  host.append(node);
  const remove = () => node.remove();
  node.querySelector("button")?.addEventListener("click", () => {
    onAction?.();
    remove();
  });
  setTimeout(remove, timeout);
  return remove;
}

/**
 * A modal form. fields: [{ name, label, type?, value?, placeholder?, options? }].
 * Resolves to the values, or null if cancelled.
 */
export function dialog({ title, text = "", ok = "OK", danger = false, fields = [] }) {
  return new Promise((resolve) => {
    const node = el(`
      <div class="modal-backdrop">
        <form class="modal chamfer">
          <h2>${esc(title)}</h2>
          ${text ? `<p class="muted">${esc(text)}</p>` : ""}
          <div class="fields"></div>
          <div class="modal-actions">
            <button type="button" class="btn" data-cancel>Cancel</button>
            <button type="submit" class="btn ${danger ? "danger" : "primary"}">${esc(ok)}</button>
          </div>
        </form>
      </div>`);
    const container = node.querySelector(".fields");
    for (const field of fields) {
      const wrap = el(`<label class="field"><span>${esc(field.label)}</span></label>`);
      let input;
      if (field.type === "select") {
        input = document.createElement("select");
        for (const [value, label] of field.options) input.append(new Option(label, value, false, value === field.value));
      } else {
        input = document.createElement("input");
        input.type = field.type || "text";
        input.value = field.value ?? "";
        input.placeholder = field.placeholder || "";
      }
      input.name = field.name;
      if (field.required) input.required = true;
      wrap.append(input);
      container.append(wrap);
    }
    const close = (value) => {
      node.remove();
      document.removeEventListener("keydown", onKey);
      resolve(value);
    };
    const onKey = (event) => {
      if (event.key === "Escape") close(null);
    };
    document.addEventListener("keydown", onKey);
    node.querySelector("[data-cancel]").addEventListener("click", () => close(null));
    node.addEventListener("mousedown", (event) => {
      if (event.target === node) close(null);
    });
    node.querySelector("form").addEventListener("submit", (event) => {
      event.preventDefault();
      const values = {};
      for (const input of container.querySelectorAll("input, select")) values[input.name] = input.value.trim();
      close(values);
    });
    document.body.append(node);
    (container.querySelector("input, select") || node.querySelector("[type=submit]")).focus();
  });
}

export const confirmDialog = (title, text, ok = "OK", danger = false) =>
  dialog({ title, text, ok, danger }).then((values) => values !== null);
