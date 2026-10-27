import { icon } from "../icons.js";
import { el, esc } from "../lib.js";

/**
 * The standard view layout: a top bar (back arrow, title, actions) over a
 * content area. Returns the parts so the view can fill them in.
 */
export function frame(host, { title, onBack, actions = "", flush = false }) {
  const node = el(`
    <div style="display:contents">
      <header class="topbar">
        ${onBack ? `<button class="icon-btn" data-back title="Back">${icon("arrow-left")}</button>` : ""}
        <h1></h1>
        <div class="actions" style="display:flex;gap:8px;align-items:center">${actions}</div>
      </header>
      <div class="content ${flush ? "flush" : ""}"></div>
    </div>`);
  const heading = node.querySelector("h1");
  heading.textContent = title;
  if (onBack) node.querySelector("[data-back]").addEventListener("click", onBack);
  host.append(node);
  return {
    content: node.querySelector(".content"),
    actions: node.querySelector(".actions"),
    setTitle: (text) => {
      heading.textContent = text;
    },
    setActions: (html) => {
      node.querySelector(".actions").innerHTML = html;
    }
  };
}

export const note = (text) => `<p class="note">${esc(text)}</p>`;
