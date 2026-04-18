const DEFAULT_LOCATION = "Placentia, CA";
const CACHE_TTL_MS = 10 * 60 * 1000;

const LOCATION_ALIASES = new Map([
  ["placentia,ca", ["Placentia, California", "Placentia, California, United States"]]
]);

const US_STATE_NAMES = {
  AL: "Alabama",
  AK: "Alaska",
  AZ: "Arizona",
  AR: "Arkansas",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DE: "Delaware",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  KS: "Kansas",
  KY: "Kentucky",
  LA: "Louisiana",
  ME: "Maine",
  MD: "Maryland",
  MA: "Massachusetts",
  MI: "Michigan",
  MN: "Minnesota",
  MS: "Mississippi",
  MO: "Missouri",
  MT: "Montana",
  NE: "Nebraska",
  NV: "Nevada",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NM: "New Mexico",
  NY: "New York",
  NC: "North Carolina",
  ND: "North Dakota",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VT: "Vermont",
  VA: "Virginia",
  WA: "Washington",
  WV: "West Virginia",
  WI: "Wisconsin",
  WY: "Wyoming"
};

const briefingCache = new Map();

const FEED_SOURCES = {
  headlines: {
    label: "BBC World",
    url: "https://feeds.bbci.co.uk/news/world/rss.xml"
  },
  moreStories: {
    label: "BBC Top Stories",
    url: "https://feeds.bbci.co.uk/news/rss.xml"
  },
  technology: {
    label: "TechCrunch",
    url: "https://techcrunch.com/feed/"
  },
  stem: {
    label: "ScienceDaily",
    url: "https://www.sciencedaily.com/rss/top/science.xml"
  }
};

export async function getNewsBriefing(locationQuery = DEFAULT_LOCATION, options = {}) {
  const normalizedLocation = String(locationQuery || DEFAULT_LOCATION).trim() || DEFAULT_LOCATION;
  const cacheKey = normalizedLocation.toLowerCase();
  const forceRefresh = Boolean(options.forceRefresh);

  if (!forceRefresh) {
    const cached = briefingCache.get(cacheKey);
    if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
      return cached.data;
    }
  }

  const [weatherResult, headlinesResult, moreStoriesResult, technologyResult, stemResult] = await Promise.allSettled([
    getWeatherSnapshot(normalizedLocation),
    readFeed(FEED_SOURCES.headlines, 5),
    readFeed(FEED_SOURCES.moreStories, 6),
    readFeed(FEED_SOURCES.technology, 5),
    readFeed(FEED_SOURCES.stem, 1)
  ]);

  const data = {
    ok: true,
    locationQuery: normalizedLocation,
    fetchedAt: new Date().toISOString(),
    weather: settledValue(weatherResult, {
      ok: false,
      message: "Weather is unavailable right now."
    }),
    headlines: settledValue(headlinesResult, []),
    moreStories: settledValue(moreStoriesResult, []),
    technology: settledValue(technologyResult, []),
    stemFeature: settledValue(stemResult, [])[0] || null,
    sourceStatus: buildSourceStatus({
      weatherResult,
      headlinesResult,
      moreStoriesResult,
      technologyResult,
      stemResult
    })
  };

  data.chatbotDigest = buildChatbotDigest(data);

  briefingCache.set(cacheKey, {
    cachedAt: Date.now(),
    data
  });

  return data;
}

async function getWeatherSnapshot(locationQuery) {
  const place = await resolveWeatherLocation(locationQuery);

  if (!place) {
    return {
      ok: false,
      message: `No weather location match found for ${locationQuery}.`
    };
  }

  const weatherUrl =
    `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
    "&current=temperature_2m,apparent_temperature,is_day,weather_code,wind_speed_10m" +
    "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max" +
    "&timezone=auto&forecast_days=3";

  const weatherResponse = await fetchJson(weatherUrl);
  const current = weatherResponse?.current || {};
  const daily = weatherResponse?.daily || {};

  return {
    ok: true,
    location: `${place.name}${place.admin1 ? `, ${place.admin1}` : ""}${place.country ? `, ${place.country}` : ""}`,
    current: {
      temperatureC: current.temperature_2m,
      apparentTemperatureC: current.apparent_temperature,
      windSpeedKph: current.wind_speed_10m,
      label: weatherCodeLabel(current.weather_code),
      isDay: Boolean(current.is_day)
    },
    forecast: [0, 1, 2].map((index) => ({
      day: index === 0 ? "Today" : index === 1 ? "Tomorrow" : `Day ${index + 1}`,
      maxC: daily.temperature_2m_max?.[index],
      minC: daily.temperature_2m_min?.[index],
      precipitationChance: daily.precipitation_probability_max?.[index],
      label: weatherCodeLabel(daily.weather_code?.[index])
    }))
  };
}

async function resolveWeatherLocation(locationQuery) {
  const candidates = buildGeocodeCandidates(locationQuery);

  for (const candidate of candidates) {
    const place = await searchLocation(candidate);
    if (place) {
      return place;
    }
  }

  return null;
}

async function searchLocation({ name, countryCode }) {
  const searchName = String(name || "").trim();
  if (!searchName) {
    return null;
  }

  const countrySuffix = countryCode ? `&countryCode=${encodeURIComponent(countryCode)}` : "";
  const geoUrl =
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(searchName)}` +
    `&count=5&language=en&format=json${countrySuffix}`;
  const geoResponse = await fetchJson(geoUrl);
  return Array.isArray(geoResponse?.results) ? geoResponse.results[0] : null;
}

function buildGeocodeCandidates(locationQuery) {
  const raw = String(locationQuery || "").trim();
  if (!raw) {
    return [{ name: DEFAULT_LOCATION, countryCode: "US" }, { name: DEFAULT_LOCATION }];
  }

  const candidates = [];
  const addCandidate = (name, countryCode) => {
    const trimmedName = String(name || "").trim();
    if (!trimmedName) {
      return;
    }

    const key = `${trimmedName.toLowerCase()}|${String(countryCode || "").toUpperCase()}`;
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    candidates.push({ name: trimmedName, countryCode });
  };
  const seen = new Set();

  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const city = parts[0] || raw;
  const statePart = parts[1] || "";
  const upperState = statePart.toUpperCase();
  const hasUsStateAbbreviation = Boolean(US_STATE_NAMES[upperState]);

  addCandidate(raw);

  if (hasUsStateAbbreviation) {
    addCandidate(raw, "US");
    addCandidate(`${city}, ${US_STATE_NAMES[upperState]}`, "US");
    addCandidate(`${city}, ${US_STATE_NAMES[upperState]}`);
  }

  const aliasKey = normalizeLocationKey(raw);
  const aliases = LOCATION_ALIASES.get(aliasKey) || [];
  aliases.forEach((alias) => {
    addCandidate(alias, "US");
    addCandidate(alias);
  });

  addCandidate(city, "US");
  addCandidate(city);

  return candidates;
}

function normalizeLocationKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .trim();
}

async function readFeed(source, limit) {
  const xml = await fetchText(source.url);
  const items = normalizeFeedItems(xml)
    .slice(0, limit)
    .map((item) => ({
      title: sanitizeSummary(item.title),
      link: String(item.link || "").trim(),
      summary: sanitizeSummary(item.summary || ""),
      publishedAt: String(item.publishedAt || "").trim(),
      source: source.label
    }))
    .filter((item) => item.title && item.link);

  return items;
}

function normalizeFeedItems(xml) {
  if (/<rss|<channel/i.test(xml)) {
    return parseRssItems(xml);
  }

  if (/<feed/i.test(xml)) {
    return parseAtomEntries(xml);
  }

  return [];
}

function parseRssItems(xml) {
  return matchBlocks(xml, "item").map((block) => ({
    title: extractTag(block, "title"),
    link: extractTag(block, "link"),
    summary: extractTag(block, "description") || extractTag(block, "content:encoded"),
    publishedAt: extractTag(block, "pubDate")
  }));
}

function parseAtomEntries(xml) {
  return matchBlocks(xml, "entry").map((block) => ({
    title: extractTag(block, "title"),
    link: extractAtomLink(block),
    summary: extractTag(block, "summary") || extractTag(block, "content"),
    publishedAt: extractTag(block, "updated") || extractTag(block, "published")
  }));
}

function matchBlocks(xml, tagName) {
  const pattern = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "gi");
  const matches = [];
  let match = pattern.exec(xml);

  while (match) {
    matches.push(match[1]);
    match = pattern.exec(xml);
  }

  return matches;
}

function extractTag(block, tagName) {
  const pattern = new RegExp(`<${escapeRegex(tagName)}\\b[^>]*>([\\s\\S]*?)<\\/${escapeRegex(tagName)}>`, "i");
  const match = block.match(pattern);
  return decodeXmlEntities(match ? stripCdata(match[1]).trim() : "");
}

function extractAtomLink(block) {
  const alternateMatch = block.match(/<link\b[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["'][^>]*\/?>/i);
  if (alternateMatch) {
    return decodeXmlEntities(alternateMatch[1]);
  }

  const hrefMatch = block.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
  return decodeXmlEntities(hrefMatch ? hrefMatch[1] : "");
}

function stripCdata(value) {
  return String(value || "").replace(/^<!\[CDATA\[|\]\]>$/g, "");
}

function decodeXmlEntities(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'");
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildChatbotDigest(briefing) {
  const segments = [];

  if (briefing.weather?.ok) {
    segments.push(
      `Weather for ${briefing.weather.location}: ${roundNumber(celsiusToFahrenheit(briefing.weather.current.temperatureC))}F and ${briefing.weather.current.label.toLowerCase()}.`
    );
  }

  if (briefing.headlines[0]) {
    segments.push(`Top headline: ${briefing.headlines[0].title}.`);
  }

  if (briefing.technology[0]) {
    segments.push(`Tech update: ${briefing.technology[0].title}.`);
  }

  if (briefing.stemFeature?.title) {
    segments.push(`STEM feature: ${briefing.stemFeature.title}.`);
  }

  return segments.join(" ");
}

function buildSourceStatus(results) {
  return {
    weather: results.weatherResult.status === "fulfilled",
    headlines: results.headlinesResult.status === "fulfilled",
    moreStories: results.moreStoriesResult.status === "fulfilled",
    technology: results.technologyResult.status === "fulfilled",
    stem: results.stemResult.status === "fulfilled"
  };
}

function settledValue(result, fallback) {
  return result.status === "fulfilled" ? result.value : fallback;
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "ControlCenter-NewsApp/0.1"
    }
  });

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }

  return response.text();
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "ControlCenter-NewsApp/0.1"
    }
  });

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }

  return response.json();
}

function sanitizeSummary(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
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

function weatherCodeLabel(code) {
  const numericCode = Number(code);
  const labels = {
    0: "Clear sky",
    1: "Mainly clear",
    2: "Partly cloudy",
    3: "Overcast",
    45: "Fog",
    48: "Rime fog",
    51: "Light drizzle",
    53: "Drizzle",
    55: "Dense drizzle",
    61: "Light rain",
    63: "Rain",
    65: "Heavy rain",
    71: "Light snow",
    73: "Snow",
    75: "Heavy snow",
    80: "Rain showers",
    81: "Rain showers",
    82: "Heavy showers",
    95: "Thunderstorm",
    96: "Thunderstorm with hail",
    99: "Severe thunderstorm"
  };

  return labels[numericCode] || "Mixed conditions";
}