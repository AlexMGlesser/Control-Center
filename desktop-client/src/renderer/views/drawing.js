import { api, el, esc, shortDate, toast } from "../lib.js";
import { frame, note } from "./frame.js";

// Drawing: view-only. 2D drawings show their picture; 3D scenes only open on the PC.

export async function render(host, ctx) {
  let drawings = [];
  let open = null;
  const images = new Map(); // id -> data URL
  const view = frame(host, { title: "Drawing", onBack: () => (open ? ((open = null), draw()) : ctx.closeApp()) });

  async function image(drawing) {
    if (drawing.mode !== "2d") return null;
    const key = `${drawing.id}:${drawing.updatedAt}`;
    if (!images.has(key)) {
      const file = await api(`/api/apps/drawing-app/files/${drawing.id}`).catch(() => null);
      images.set(key, file?.file?.content?.imageDataUrl || null);
    }
    return images.get(key);
  }

  function draw() {
    if (open) {
      view.setTitle(open.name);
      view.content.innerHTML = note("Loading…");
      image(open).then((src) => {
        if (!open) return;
        view.content.innerHTML = src ? `<div class="viewer" style="background:#fff;min-height:100%"><img src="${src}" alt="${esc(open.name)}" /></div>` : note("Couldn't load this drawing.");
      });
      return;
    }
    view.setTitle("Drawing");
    if (!drawings.length) {
      view.content.innerHTML = note("No drawings yet. Make one in the Drawing app on the PC.");
      return;
    }
    const grid = el(`<div class="media-grid"></div>`);
    for (const drawing of drawings) {
      const is2d = drawing.mode === "2d";
      const card = el(`
        <button class="media-card" ${is2d ? "" : "disabled style='cursor:default'"}>
          <div class="media-thumb chamfer" style="background:${is2d ? "#fff" : "var(--panel)"};aspect-ratio:4/3">${is2d ? "" : `<span class="muted small" style="text-align:center">3D scene<br/>Open it on the PC</span>`}</div>
          <div class="title ellipsis">${esc(drawing.name)}</div>
          <div class="muted small">${esc(shortDate(drawing.updatedAt))}</div>
        </button>`);
      if (is2d) {
        card.addEventListener("click", () => {
          open = drawing;
          draw();
        });
        image(drawing).then((src) => {
          if (src) card.querySelector(".media-thumb").replaceWith(el(`<img class="media-thumb chamfer" style="background:#fff;aspect-ratio:4/3;object-fit:contain" src="${src}" alt="" />`));
        });
      }
      grid.append(card);
    }
    view.content.replaceChildren(grid);
  }

  try {
    drawings = (await api("/api/apps/drawing-app/files")).files || [];
  } catch (error) {
    toast(error.message, { tone: "error" });
  }
  draw();
}
