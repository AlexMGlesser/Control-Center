import { fetchNewsBriefing } from "./newsAppClient.js";

const state = {
  location: "Placentia, CA",
  briefing: null,
  loading: false,
  status: ""
};

const locationForm = document.getElementById("location-form");
const locationInput = document.getElementById("location-input");
const refreshBtn = document.getElementById("refresh-btn");
const statusText = document.getElementById("status-text");
const newsGrid = document.getElementById("news-grid");
const weatherContent = document.getElementById("weather-content");

async function loadBriefing({ refresh = false } = {}) {
  state.location = String(locationInput.value || state.location || "Placentia, CA").trim() || "Placentia, CA";
  state.loading = true;
  state.status = `Loading briefing for ${state.location}...`;
  render();

  try {
    state.briefing = await fetchNewsBriefing(state.location, { refresh });
    state.status = refresh ? `Briefing refreshed for ${state.location}.` : `Loaded briefing for ${state.location}.`;
  } catch (error) {
    state.status = error.message;
  } finally {
    state.loading = false;
    render();
  }
}

function render() {
  statusText.textContent = state.status;
  refreshBtn.disabled = state.loading;

  if (!state.briefing) {
    newsGrid.innerHTML = `
      <article class="panel">
        <h2>Ready</h2>
        <p class="muted">Load a briefing to populate News App content.</p>
      </article>
    `;
    weatherContent.innerHTML = `<p class="muted">Weather will appear after briefing load.</p>`;
    return;
  }

  newsGrid.innerHTML = [
    renderPanel("Headlines", state.briefing.headlines),
    renderPanel("More Stories", state.briefing.moreStories),
    renderPanel("Technology", state.briefing.technology),
    renderStemPanel(state.briefing.stemFeature, state.briefing.chatbotDigest)
  ].join("");

  weatherContent.innerHTML = renderWeather(state.briefing.weather);
}

function renderPanel(title, stories = []) {
  return `
    <article class="panel">
      <h2>${escapeHtml(title)}</h2>
      ${stories.length ? stories.map(renderStory).join("") : '<p class="muted">No stories available.</p>'}
    </article>
  `;
}

function renderStemPanel(stemFeature, digest) {
  return `
    <article class="panel">
      <h2>STEM Feature</h2>
      ${stemFeature ? renderStory(stemFeature) : '<p class="muted">No STEM feature available.</p>'}
      <p class="muted"><strong>Digest:</strong> ${escapeHtml(digest || "No digest yet.")}</p>
    </article>
  `;
}

function renderStory(story) {
  return `
    <article class="story">
      <a href="${escapeAttribute(story.link)}" target="_blank" rel="noreferrer">${escapeHtml(story.title)}</a>
      <p>${escapeHtml(trim(story.summary, 180))}</p>
      <p class="muted">${escapeHtml(story.source || "Source")} · ${escapeHtml(formatDate(story.publishedAt))}</p>
    </article>
  `;
}

function renderWeather(weather) {
  if (!weather?.ok) {
    return `<p class="muted">${escapeHtml(weather?.message || "Weather unavailable.")}</p>`;
  }

  const forecastCards = (weather.forecast || [])
    .map(
      (day) => `
        <article class="weather-card">
          <p>${escapeHtml(day.day)}</p>
          <strong>${escapeHtml(day.label)}</strong>
          <span>${escapeHtml(String(round(celsiusToFahrenheit(day.maxC))))} / ${escapeHtml(String(round(celsiusToFahrenheit(day.minC))))}F</span>
          <span>${escapeHtml(String(round(day.precipitationChance)))}% rain</span>
        </article>
      `
    )
    .join("");

  return `
    <p><strong>${escapeHtml(weather.location)}</strong></p>
    <p class="muted">${escapeHtml(weather.current.label)} · ${escapeHtml(String(round(celsiusToFahrenheit(weather.current.temperatureC))))}F</p>
    <p class="muted">Feels like ${escapeHtml(String(round(celsiusToFahrenheit(weather.current.apparentTemperatureC))))}F · Wind ${escapeHtml(String(round(kphToMph(weather.current.windSpeedKph))))} mph</p>
    <div class="weather-cards">${forecastCards}</div>
  `;
}

function formatDate(value) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "Recent" : parsed.toLocaleString();
}

function trim(text, maxLength) {
  const value = String(text || "").trim();
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 1).trim()}...`;
}

function round(value) {
  return Number.isFinite(Number(value)) ? Math.round(Number(value)) : "--";
}

function celsiusToFahrenheit(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return Number.NaN;
  }

  return numericValue * (9 / 5) + 32;
}

function kphToMph(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return Number.NaN;
  }

  return numericValue * 0.621371;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

locationForm.addEventListener("submit", (event) => {
  event.preventDefault();
  loadBriefing({ refresh: true }).catch(() => {
    // Ignore load failures; status text captures errors.
  });
});

refreshBtn.addEventListener("click", () => {
  loadBriefing({ refresh: true }).catch(() => {
    // Ignore load failures; status text captures errors.
  });
});

loadBriefing().catch(() => {
  // Ignore initial load failures; status text captures errors.
});