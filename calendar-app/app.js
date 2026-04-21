const state = {
  monthView: null,
  selectedDate: "",
  visibleYear: 0,
  visibleMonth: 0,
  loading: false,
  status: ""
};

const monthGrid = document.getElementById("month-grid");
const monthLabel = document.getElementById("month-label");
const selectedDateLabel = document.getElementById("selected-date-label");
const selectedDayEvents = document.getElementById("selected-day-events");
const heroStats = document.getElementById("hero-stats");
const statusText = document.getElementById("status-text");

async function loadMonth(year, month) {
  state.loading = true;
  state.status = "Loading calendar...";
  render();

  try {
    const response = await fetch(`/api/apps/calendar-app/month?year=${year}&month=${month}`);
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload.message || "Could not load calendar month.");
    }

    state.monthView = payload;
    state.visibleYear = payload.year;
    state.visibleMonth = payload.month;
    state.selectedDate = state.selectedDate && payload.days.some((day) => day.date === state.selectedDate)
      ? state.selectedDate
      : payload.selectedDate;
    state.status = `Loaded ${payload.monthLabel}.`;
  } catch (error) {
    state.status = String(error.message || error);
  } finally {
    state.loading = false;
    render();
  }
}

function render() {
  statusText.textContent = state.status;

  if (!state.monthView) {
    monthLabel.textContent = "Loading...";
    heroStats.innerHTML = "";
    monthGrid.innerHTML = '<article class="day-card"><p class="muted">Calendar month is loading.</p></article>';
    selectedDateLabel.textContent = "Loading...";
    selectedDayEvents.innerHTML = '<div class="agenda-empty"><p class="muted">Events will appear after the month loads.</p></div>';
    return;
  }

  monthLabel.textContent = state.monthView.monthLabel;
  heroStats.innerHTML = renderHeroStats();
  monthGrid.innerHTML = state.monthView.days.map(renderDayCard).join("");

  const selectedDay = state.monthView.days.find((day) => day.date === state.selectedDate) || state.monthView.days[0];
  selectedDateLabel.textContent = formatReadableDate(selectedDay?.date);
  selectedDayEvents.innerHTML = renderAgenda(selectedDay);
}

function renderHeroStats() {
  const summary = state.monthView.summary || {};
  const firstEvent = summary.firstEvent ? `${summary.firstEvent.title} · ${formatReadableDate(summary.firstEvent.startDateKey)}` : "No events yet";
  const lastEvent = summary.lastEvent ? `${summary.lastEvent.title} · ${formatReadableDate(summary.lastEvent.startDateKey)}` : "No events yet";

  return [
    statCard("Events this month", String(summary.totalEvents || 0)),
    statCard("Busy days", String(summary.busyDays || 0)),
    statCard("First anchor", firstEvent),
    statCard("Last anchor", lastEvent)
  ].join("");
}

function statCard(label, value) {
  return `
    <article class="stat-card">
      <span class="muted">${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </article>
  `;
}

function renderDayCard(day) {
  const previewEvents = (Array.isArray(day?.events) ? day.events : []).slice(0, 2);
  return `
    <article
      class="day-card ${day.inMonth ? "" : "is-outside"} ${day.isToday ? "is-today" : ""} ${day.date === state.selectedDate ? "is-selected" : ""}"
      data-action="select-day"
      data-date="${escapeAttribute(day.date)}"
    >
      <div class="day-heading">
        <span class="day-number">${day.dayNumber}</span>
        <span class="event-count">${day.eventCount ? `${day.eventCount} event${day.eventCount === 1 ? "" : "s"}` : "Open"}</span>
      </div>
      <div class="day-preview">
        ${previewEvents.length
          ? previewEvents.map((event) => renderMiniEvent(event)).join("")
          : '<span class="muted">No scheduled items.</span>'}
      </div>
    </article>
  `;
}

function renderMiniEvent(event) {
  return `
    <article class="mini-event accent-${escapeAttribute(event.accent || "azure")}">
      <strong>${escapeHtml(event.title)}</strong>
      <span>${escapeHtml(`${event.startLabel} - ${event.endLabel}`)}</span>
    </article>
  `;
}

function renderAgenda(day) {
  if (!day || !Array.isArray(day.events) || !day.events.length) {
    return `
      <div class="agenda-empty">
        <p class="muted">Nothing is scheduled for this day.</p>
      </div>
    `;
  }

  return day.events
    .map(
      (event) => `
        <article class="agenda-card accent-${escapeAttribute(event.accent || "azure")}">
          <div class="agenda-card-header">
            <strong>${escapeHtml(event.title)}</strong>
          </div>
          <span>${escapeHtml(`${event.startLabel} - ${event.endLabel}`)}</span>
          ${event.location ? `<p>${escapeHtml(event.location)}</p>` : ""}
          ${event.notes ? `<p>${escapeHtml(event.notes)}</p>` : ""}
        </article>
      `
    )
    .join("");
}

function formatReadableDate(value) {
  const parsed = new Date(`${value}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) {
    return "Selected day";
  }

  return parsed.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric"
  });
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

document.addEventListener("click", (event) => {
  const selectDay = event.target.closest("[data-action='select-day']");
  if (selectDay?.dataset.date) {
    state.selectedDate = selectDay.dataset.date;
    render();
    return;
  }

  const actionButton = event.target.closest("[data-action]");
  if (!actionButton) {
    return;
  }

  const currentDate = new Date(state.visibleYear, state.visibleMonth - 1, 1);
  if (actionButton.dataset.action === "today") {
    const today = new Date();
    loadMonth(today.getFullYear(), today.getMonth() + 1).catch(() => {
      // Ignore load failures; status text captures the error.
    });
    return;
  }

  if (actionButton.dataset.action === "prev-month") {
    currentDate.setMonth(currentDate.getMonth() - 1);
    loadMonth(currentDate.getFullYear(), currentDate.getMonth() + 1).catch(() => {
      // Ignore load failures; status text captures the error.
    });
    return;
  }

  if (actionButton.dataset.action === "next-month") {
    currentDate.setMonth(currentDate.getMonth() + 1);
    loadMonth(currentDate.getFullYear(), currentDate.getMonth() + 1).catch(() => {
      // Ignore load failures; status text captures the error.
    });
  }
});

const now = new Date();
loadMonth(now.getFullYear(), now.getMonth() + 1).catch(() => {
  // Ignore initial load failures; status text captures the error.
});