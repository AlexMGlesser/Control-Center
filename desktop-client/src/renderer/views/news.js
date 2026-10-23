import { icon } from "../icons.js";
import { api, el, esc, timeLabel } from "../lib.js";
import { frame, note } from "./frame.js";

// News: weather and the briefing's stories. Stories open in the browser.

const fahrenheit = (celsius) => (celsius === null || celsius === undefined ? "–" : `${Math.round((celsius * 9) / 5 + 32)}°`);

function story(item) {
  const card = el(`
    <a class="card chamfer" href="${esc(item.link)}" style="text-decoration:none">
      <div style="font-weight:600">${esc(item.title)}</div>
      ${item.summary ? `<div class="muted small" style="margin-top:4px">${esc(item.summary)}</div>` : ""}
      ${item.source ? `<div class="small" style="color:var(--cyan);margin-top:6px">${esc(item.source)}</div>` : ""}
    </a>`);
  card.addEventListener("click", (event) => {
    event.preventDefault();
    if (item.link) window.cc.openExternal(item.link);
  });
  return card;
}

export async function render(host, ctx) {
  const view = frame(host, { title: "News", onBack: ctx.closeApp, actions: `<button class="btn small" id="refresh">${icon("refresh-cw")} Refresh</button>` });

  async function load() {
    view.content.innerHTML = note("Fetching today's briefing…");
    let briefing;
    try {
      briefing = await api("/api/apps/news-app/briefing");
    } catch (error) {
      view.content.innerHTML = note(error.message);
      return;
    }
    const list = el(`<div class="list"></div>`);
    list.append(el(`<p class="muted small">Refreshed ${esc(timeLabel(new Date(briefing.fetchedAt)))}</p>`));

    const weather = briefing.weather;
    if (weather?.ok && weather.current) {
      const current = weather.current;
      list.append(
        el(`
        <div class="panel chamfer">
          <div class="muted small">${esc(weather.location.split(",")[0])}</div>
          <div style="font-size:30px;font-weight:600">${fahrenheit(current.temperatureC)} <span style="font-size:16px;font-weight:400">${esc(current.label)}</span></div>
          <div class="muted small">Feels like ${fahrenheit(current.apparentTemperatureC)} · Wind ${current.windSpeedKph === undefined ? "?" : Math.round(current.windSpeedKph * 0.621371)} mph</div>
          ${weather.forecast
            .map(
              (day) => `
            <div style="display:grid;grid-template-columns:110px 1fr 60px 90px;gap:8px;margin-top:8px">
              <span>${esc(day.day)}</span><span class="muted">${esc(day.label)}</span>
              <span style="color:var(--cyan)">${day.precipitationChance === undefined ? "" : `${Math.round(day.precipitationChance)}%`}</span>
              <span>${fahrenheit(day.maxC)} / ${fahrenheit(day.minC)}</span>
            </div>`
            )
            .join("")}
        </div>`)
      );
    }

    const sections = [
      ["Headlines", briefing.headlines?.slice(0, 6)],
      ["Technology", briefing.technology?.slice(0, 5)],
      ["Science", briefing.stemFeature?.title ? [briefing.stemFeature] : []],
      ["More stories", briefing.moreStories?.slice(0, 6)]
    ];
    for (const [title, items] of sections) {
      if (!items?.length) continue;
      list.append(el(`<div class="section-label">${esc(title)}</div>`));
      for (const item of items) list.append(story(item));
    }
    view.content.replaceChildren(list);
  }

  view.actions.querySelector("#refresh").addEventListener("click", load);
  await load();
}
