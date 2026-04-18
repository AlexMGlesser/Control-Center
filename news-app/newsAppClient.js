const DEFAULT_LOCATION = "Placentia, CA";

export async function fetchNewsBriefing(location = DEFAULT_LOCATION, options = {}) {
  const normalizedLocation = String(location || DEFAULT_LOCATION).trim() || DEFAULT_LOCATION;
  const refresh = options.refresh ? "true" : "false";
  const response = await fetch(
    `/api/apps/news-app/briefing?location=${encodeURIComponent(normalizedLocation)}&refresh=${refresh}`
  );

  const payload = await response.json();
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.message || "News briefing is unavailable.");
  }

  return payload;
}

export function renderNewsAppView(state) {
  const briefing = state.briefing;
  const location = state.location || DEFAULT_LOCATION;
  const loading = Boolean(state.loading);
  const error = String(state.error || "").trim();
  const bridgeStatus = String(state.bridgeStatus || "").trim();

  return `
    <section class="news-app-shell">
      <article class="card stack news-hero-card">
        <div class="news-toolbar">
          <div>
            <h3>Daily Briefing</h3>
            <p class="muted">Weather, top stories, technology updates, and one STEM feature in a single desktop view.</p>
          </div>

          <form id="news-location-form" class="news-toolbar-form">
            <input
              id="news-location-input"
              name="location"
              class="news-input"
              type="text"
              value="${escapeHtml(location)}"
              placeholder="Enter a city"
            />
            <button type="submit" class="action-btn">Load Briefing</button>
            <button type="button" class="action-btn" data-action="news-refresh">Refresh</button>
          </form>
        </div>

        ${bridgeStatus ? `<p class="muted">${escapeHtml(bridgeStatus)}</p>` : ""}
        ${loading ? `<p class="muted">Refreshing news sources for ${escapeHtml(location)}...</p>` : ""}
        ${error ? `<p class="news-error">${escapeHtml(error)}</p>` : ""}
      </article>

      <article class="card stack news-weather-strip">
        <h3>Weather</h3>
        ${renderWeatherStrip(briefing?.weather)}
      </article>

      ${renderNewsGrid(briefing)}
    </section>
  `;
}

function renderNewsGrid(briefing) {
  if (!briefing) {
    return `
      <div class="grid news-grid news-grid--empty">
        <article class="card stack">
          <h3>News App Ready</h3>
          <p class="muted">Load a briefing to populate the desktop news layout.</p>
        </article>
      </div>
    `;
  }

  return `
    <div class="grid news-grid">
      <article class="card stack news-panel news-panel--headlines">
        <h3>Headlines</h3>
        <div class="news-story-list">${renderStoryList(briefing.headlines)}</div>
      </article>

      <article class="card stack news-panel news-panel--more">
        <h3>More Stories</h3>
        <div class="news-story-list">${renderStoryList(briefing.moreStories)}</div>
      </article>

      <article class="card stack news-panel news-panel--tech">
        <h3>Technology</h3>
        <div class="news-story-list">${renderStoryList(briefing.technology)}</div>
      </article>

      <article class="card stack news-panel news-panel--stem">
        <h3>STEM Feature</h3>
        ${renderStemFeature(briefing.stemFeature)}
        <div class="news-digest-box">
          <p class="muted news-digest-label">Chatbot Digest</p>
          <p>${escapeHtml(briefing.chatbotDigest || "No digest available yet.")}</p>
        </div>
      </article>
    </div>
  `;
}

function renderStoryList(stories = []) {
  if (!stories.length) {
    return `<p class="muted">No stories available right now.</p>`;
  }

  return stories
    .map(
      (story) => `
        <article class="news-story-card">
          <a class="news-story-link" href="${escapeAttribute(story.link)}" target="_blank" rel="noreferrer">${escapeHtml(story.title)}</a>
          <p class="muted">${escapeHtml(truncateText(story.summary || "No summary available.", 180))}</p>
          <div class="news-story-meta">
            <span>${escapeHtml(story.source || "Source")}</span>
            <span>${escapeHtml(formatTimestamp(story.publishedAt))}</span>
          </div>
        </article>
      `
    )
    .join("");
}

function renderStemFeature(story) {
  if (!story) {
    return `<p class="muted">No STEM feature available right now.</p>`;
  }

  return `
    <article class="news-story-card news-story-card--feature">
      <a class="news-story-link" href="${escapeAttribute(story.link)}" target="_blank" rel="noreferrer">${escapeHtml(story.title)}</a>
      <p class="muted">${escapeHtml(truncateText(story.summary || "No summary available.", 220))}</p>
      <div class="news-story-meta">
        <span>${escapeHtml(story.source || "Source")}</span>
        <span>${escapeHtml(formatTimestamp(story.publishedAt))}</span>
      </div>
    </article>
  `;
}

function renderWeatherStrip(weather) {
  if (!weather?.ok) {
    return `<p class="muted">${escapeHtml(weather?.message || "Weather is unavailable right now.")}</p>`;
  }

  return `
    <div class="news-weather-current">
      <div>
        <p class="news-weather-location">${escapeHtml(weather.location)}</p>
        <p class="news-weather-primary">${escapeHtml(weather.current.label)} · ${escapeHtml(String(roundNumber(celsiusToFahrenheit(weather.current.temperatureC))))}F</p>
      </div>
      <div class="news-weather-meta">
        <span>Feels like ${escapeHtml(String(roundNumber(celsiusToFahrenheit(weather.current.apparentTemperatureC))))}F</span>
        <span>Wind ${escapeHtml(String(roundNumber(kphToMph(weather.current.windSpeedKph))))} mph</span>
      </div>
    </div>
    <div class="news-weather-forecast">
      ${(weather.forecast || [])
        .map(
          (day) => `
            <article class="news-weather-chip">
              <p>${escapeHtml(day.day)}</p>
              <strong>${escapeHtml(day.label)}</strong>
              <span>${escapeHtml(String(roundNumber(celsiusToFahrenheit(day.maxC))))} / ${escapeHtml(String(roundNumber(celsiusToFahrenheit(day.minC))))}F</span>
              <span>${escapeHtml(String(roundNumber(day.precipitationChance)))}% rain</span>
            </article>
          `
        )
        .join("")}
    </div>
  `;
}

function formatTimestamp(value) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "Recent" : parsed.toLocaleString();
}

function truncateText(text, maxLength) {
  const normalized = String(text || "").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1).trim()}...`;
}

function roundNumber(value) {
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