import { icon } from "../icons.js";
import { api, dialog, el, esc, timeLabel, toast } from "../lib.js";
import { frame, note } from "./frame.js";

// Calendar: an agenda for the next two weeks and a month grid. Deletes wait
// 5 seconds for Undo before reaching the PC (mobile design: Calendar).

const BASE = "/api/apps/calendar-app";
const dayKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

function dayLabel(date) {
  const today = new Date();
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  if (dayKey(date) === dayKey(today)) return "Today";
  if (dayKey(date) === dayKey(tomorrow)) return "Tomorrow";
  return date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

function duration(event) {
  const minutes = Math.round((Date.parse(event.endAt) - Date.parse(event.startAt)) / 60_000);
  if (!(minutes > 0)) return "";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours === 0 ? `${rest} min` : rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

export async function render(host, ctx) {
  const now = new Date();
  const state = { mode: "agenda", agenda: [], month: null, year: now.getFullYear(), monthIndex: now.getMonth() + 1, selected: dayKey(now), hidden: new Set() };
  const view = frame(host, {
    title: "Calendar",
    onBack: ctx.closeApp,
    actions: `
      <button class="chip active" data-mode="agenda">Agenda</button>
      <button class="chip" data-mode="month">Month</button>
      <button class="btn primary small" id="new">${icon("plus")} New event</button>`
  });
  view.actions.querySelectorAll("[data-mode]").forEach((chip) =>
    chip.addEventListener("click", () => {
      state.mode = chip.dataset.mode;
      view.actions.querySelectorAll("[data-mode]").forEach((other) => other.classList.toggle("active", other === chip));
      draw();
    })
  );
  view.actions.querySelector("#new").addEventListener("click", () => createEvent());

  async function load() {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const end = new Date(start.getTime() + 15 * 24 * 60 * 60 * 1000);
    try {
      const [agenda, month] = await Promise.all([
        api(`${BASE}/events?start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}&limit=500`),
        api(`${BASE}/month?year=${state.year}&month=${state.monthIndex}`)
      ]);
      state.agenda = agenda.events || [];
      state.month = month;
    } catch (error) {
      toast(error.message, { tone: "error" });
    }
    draw();
  }

  function eventRow(event) {
    const row = el(`
      <div class="event chamfer">
        <div><div>${esc(event.startLabel)}</div><div class="muted small">${esc(event.endLabel)}</div></div>
        <div><div>${esc(event.title)}</div><div class="muted small">${esc([duration(event), event.location].filter(Boolean).join(" · "))}</div></div>
        <button class="icon-btn" title="Delete">${icon("x")}</button>
      </div>`);
    row.querySelector("button").addEventListener("click", () => remove(event));
    return row;
  }

  function draw() {
    view.content.replaceChildren();
    if (state.mode === "agenda") {
      const events = state.agenda.filter((event) => !state.hidden.has(event.id));
      if (!events.length) {
        view.content.innerHTML = note("Nothing in the next two weeks.");
        return;
      }
      const groups = new Map();
      for (const event of events) {
        const key = dayKey(new Date(event.startAt));
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(event);
      }
      const list = el(`<div class="list"></div>`);
      for (const [, dayEvents] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        list.append(el(`<div class="section-label">${esc(dayLabel(new Date(dayEvents[0].startAt)))}</div>`));
        for (const event of dayEvents) list.append(eventRow(event));
      }
      view.content.append(list);
      return;
    }

    const month = state.month;
    const header = el(`
      <div style="display:flex;align-items:center;gap:10px;max-width:760px;margin-bottom:10px">
        <button class="icon-btn" data-move="-1">${icon("chevron-left")}</button>
        <h2 style="flex:1;text-align:center;margin:0;font-size:18px">${esc(month?.monthLabel || "")}</h2>
        <button class="icon-btn" data-move="1">${icon("chevron-right")}</button>
      </div>`);
    header.querySelectorAll("[data-move]").forEach((button) =>
      button.addEventListener("click", async () => {
        const index = state.year * 12 + (state.monthIndex - 1) + Number(button.dataset.move);
        state.year = Math.floor(index / 12);
        state.monthIndex = (index % 12) + 1;
        state.month = await api(`${BASE}/month?year=${state.year}&month=${state.monthIndex}`).catch(() => state.month);
        draw();
      })
    );
    const grid = el(`<div class="month">${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => `<div class="muted small" style="text-align:center">${d}</div>`).join("")}</div>`);
    for (const day of month?.days || []) {
      const count = day.events.filter((event) => !state.hidden.has(event.id)).length;
      const cell = el(`
        <button class="day ${day.inMonth ? "" : "out"} ${day.isToday ? "today" : ""} ${day.date === state.selected ? "selected" : ""}">
          <span>${day.dayNumber}</span>
          <span class="dots">${"<i></i>".repeat(Math.min(count, 3))}</span>
        </button>`);
      cell.addEventListener("click", () => {
        state.selected = day.date;
        draw();
      });
      grid.append(cell);
    }
    const selected = (month?.days || []).find((day) => day.date === state.selected);
    const dayEvents = (selected?.events || []).filter((event) => !state.hidden.has(event.id));
    const list = el(`<div class="list" style="margin-top:16px;max-width:760px"></div>`);
    list.append(el(`<div class="section-label">${esc(dayLabel(new Date(`${state.selected}T12:00:00`)))}</div>`));
    if (!dayEvents.length) list.append(el(`<p class="muted">Nothing on this day.</p>`));
    for (const event of dayEvents) list.append(eventRow(event));
    view.content.append(header, grid, list);
  }

  /** Hidden now; deleted on the PC after 5 seconds unless Undo is clicked. */
  function remove(event) {
    state.hidden.add(event.id);
    draw();
    let undone = false;
    toast(`Deleted ${event.title}`, {
      action: "Undo",
      timeout: 5000,
      onAction: () => {
        undone = true;
        state.hidden.delete(event.id);
        draw();
      }
    });
    setTimeout(async () => {
      if (undone) return;
      try {
        await api(`${BASE}/events/${encodeURIComponent(event.id)}`, { method: "DELETE" });
      } catch (error) {
        state.hidden.delete(event.id);
        toast(`Couldn't delete ${event.title}: ${error.message}`, { tone: "error" });
      }
      load();
    }, 5000);
  }

  async function createEvent() {
    const start = new Date(Date.now() + 60 * 60 * 1000);
    start.setMinutes(0, 0, 0);
    const pad = (n) => String(n).padStart(2, "0");
    const values = await dialog({
      title: "New event",
      ok: "Add",
      fields: [
        { name: "title", label: "Title", required: true },
        { name: "date", label: "Date", type: "date", value: dayKey(start), required: true },
        { name: "start", label: "Starts", type: "time", value: `${pad(start.getHours())}:00`, required: true },
        { name: "end", label: "Ends (optional, default 1 hour)", type: "time" }
      ]
    });
    if (!values) return;
    const startsAt = new Date(`${values.date}T${values.start}`);
    let endsAt = values.end ? new Date(`${values.date}T${values.end}`) : null;
    // An end before the start runs past midnight.
    if (endsAt && endsAt <= startsAt) endsAt = new Date(endsAt.getTime() + 24 * 60 * 60 * 1000);
    try {
      await api(`${BASE}/events`, {
        method: "POST",
        body: { title: values.title, startsAt: startsAt.toISOString(), ...(endsAt ? { endsAt: endsAt.toISOString() } : {}) }
      });
      toast(`Added ${values.title} at ${timeLabel(startsAt)}.`);
      load();
    } catch (error) {
      toast(error.message, { tone: "error" });
    }
  }

  ctx.onEvent((event) => {
    if (event.appId === "calendar-app" && event.type === "data-changed") load();
  });
  await load();
}
