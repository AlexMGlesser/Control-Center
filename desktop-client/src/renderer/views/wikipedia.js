import { api, el, esc } from "../lib.js";
import { frame, note } from "./frame.js";

// Wikipedia: the offline archive on the PC, through its proxy. Searches can
// take a minute while the PC's drive spins up.

const BASE = "/api/apps/wikipedia-app/proxy";

export async function render(host, ctx) {
  /** Articles opened, newest last; Back pops one. */
  const pages = [];
  let results = [];
  let query = "";
  let busy = 0;

  const view = frame(host, { title: "Wikipedia", onBack: () => back(), flush: true });

  function back() {
    if (pages.length) {
      pages.pop();
      return draw();
    }
    ctx.closeApp();
  }

  /** Runs a request with the "this can take a minute" note after 3 seconds. */
  async function slow(task) {
    const ticket = ++busy;
    const status = view.content.querySelector("#status");
    if (status) status.textContent = "Loading…";
    const timer = setTimeout(() => {
      const current = view.content.querySelector("#status");
      if (current && ticket === busy) current.textContent = "Searching the archive… (this can take up to a minute)";
    }, 3000);
    try {
      return await task();
    } finally {
      clearTimeout(timer);
      if (ticket === busy) busy = 0;
    }
  }

  async function search(text) {
    query = text.trim();
    if (!query) return;
    try {
      const response = await slow(() => api(`${BASE}/search?q=${encodeURIComponent(query)}`, { allowError: true }));
      results = response.results || [];
      draw(response.error || (results.length ? `${response.total_matches} matches` : `No articles match "${query}".`));
    } catch (error) {
      draw(error.message);
    }
  }

  async function open(title, section) {
    try {
      const article = await slow(() =>
        api(`${BASE}/article?title=${encodeURIComponent(title)}${section ? `&section=${encodeURIComponent(section)}` : ""}&max_chars=20000`, { allowError: true })
      );
      if (article.error) return draw(article.error);
      const current = pages[pages.length - 1];
      // Moving between sections of one article replaces the page and keeps its contents list.
      if (current && current.article.title === article.title) pages[pages.length - 1] = { article, section, sections: current.sections };
      else pages.push({ article, section: null, sections: article.sections });
      draw();
    } catch (error) {
      draw(error.message);
    }
  }

  async function random() {
    try {
      const { title } = await slow(() => api(`${BASE}/random`));
      if (title) await open(title);
    } catch (error) {
      draw(error.message);
    }
  }

  function draw(message = "") {
    const page = pages[pages.length - 1];
    view.setTitle(page ? page.article.title : "Wikipedia");
    if (!page) {
      view.setActions(`<button class="btn small" id="random">Random</button>`);
      view.actions.querySelector("#random").addEventListener("click", random);
      view.content.innerHTML = `
        <form class="toolbar" id="search-form">
          <input type="search" id="q" class="grow" placeholder="Search the offline Wikipedia" value="${esc(query)}" style="flex:1" />
          <button class="btn primary" type="submit">Search</button>
        </form>
        <div class="muted small" id="status" style="padding:6px 20px">${esc(message)}</div>
        <div class="scroll"><div class="list" id="results"></div>${results.length || message ? "" : note("Search for any article. Everything comes from the archive on your PC.")}</div>`;
      view.content.querySelector("#search-form").addEventListener("submit", (event) => {
        event.preventDefault();
        search(view.content.querySelector("#q").value);
      });
      const list = view.content.querySelector("#results");
      for (const result of results) {
        const card = el(`<button class="card chamfer"><div style="font-weight:600">${esc(result.title)}</div><div class="muted small">${esc(result.snippet)}</div></button>`);
        card.addEventListener("click", () => open(result.title));
        list.append(card);
      }
      view.content.querySelector("#q").focus();
      return;
    }

    const { article, section, sections } = page;
    view.setActions(
      sections.length > 1
        ? `<select id="contents" title="Contents">${sections.map((name, index) => `<option value="${index}" ${(section || "Introduction") === name || (index === 0 && !section) ? "selected" : ""}>${esc(name)}</option>`).join("")}</select>`
        : ""
    );
    view.actions.querySelector("#contents")?.addEventListener("change", (event) => {
      const index = Number(event.target.value);
      open(article.title, index === 0 ? null : sections[index]);
    });
    const paragraphs = article.text.split(/\n\s*\n|\n/).map((line) => line.trim()).filter(Boolean);
    view.content.innerHTML = `
      <div class="muted small" id="status" style="padding:6px 20px">${esc(message)}</div>
      <div class="scroll" id="article-scroll">
        <article class="article">
          <div class="section-label">${esc(section || "Introduction")}</div>
          ${paragraphs.map((text) => `<p>${esc(text)}</p>`).join("")}
          ${article.truncated ? `<p class="muted small">The rest is in the sections: pick one from the contents menu above.</p>` : ""}
          ${article.links_to?.length ? `<div class="section-label">Linked articles</div><div class="tags" id="links"></div>` : ""}
        </article>
      </div>`;
    const links = view.content.querySelector("#links");
    for (const title of (article.links_to || []).slice(0, 40)) {
      const chip = el(`<button class="chip">${esc(title)}</button>`);
      chip.addEventListener("click", () => open(title));
      links.append(chip);
    }
    view.content.querySelector("#article-scroll").scrollTop = 0;
  }

  draw();
}
