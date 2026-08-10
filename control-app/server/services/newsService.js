import { pathToFileURL } from "url";
import path from "path";
import { getBundledAppDirectory } from "../appPaths.js";

let _mod = null;
async function _load() {
  if (!_mod) {
    const newsAppDir = getBundledAppDirectory("news-app");
    const serviceUrl = pathToFileURL(path.join(newsAppDir, "newsService.js")).href;
    _mod = await import(serviceUrl);
  }
  return _mod;
}

export async function getNewsBriefing(...args) {
  const mod = await _load();
  return mod.getNewsBriefing(...args);
}

/**
 * Formats a news briefing (as returned by getNewsBriefing) into a short
 * spoken-style summary paragraph. Shared by the get_news_summary tool and
 * the alarm system's wake-up briefing.
 */
export function formatNewsSummary(briefing) {
  const lines = [];

  if (briefing.weather?.ok) {
    const w = briefing.weather.current;
    lines.push(`Weather in ${briefing.weather.location}: ${w.temperatureC}°C, ${w.label}.`);
  }

  if (briefing.headlines?.length) {
    lines.push("Top headlines:");
    for (const item of briefing.headlines.slice(0, 3)) {
      lines.push(`- ${item.title}${item.summary ? ` — ${item.summary}` : ""}`);
    }
  }

  if (briefing.technology?.length) {
    lines.push("In tech:");
    for (const item of briefing.technology.slice(0, 2)) {
      lines.push(`- ${item.title}${item.summary ? ` — ${item.summary}` : ""}`);
    }
  }

  if (briefing.stemFeature) {
    lines.push(`Science highlight: ${briefing.stemFeature.title}.`);
  }

  return lines.join("\n");
}