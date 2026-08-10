import { existsSync, readFileSync } from "fs";
import path from "path";
import { getBundledDocumentPath } from "../appPaths.js";

const CONTEXT_SPECS = [
  {
    label: "Control Center Overview",
    path: getBundledDocumentPath("design-documents", "control-center-overview.md"),
    maxChars: 700
  },
  {
    label: "Control Center Architecture",
    path: getBundledDocumentPath("design-documents", "control-center-architecture.md"),
    maxChars: 700
  },
  { label: "Movie App Design", path: getBundledDocumentPath("design-documents", "movie-app-design.txt"), maxChars: 360 },
  { label: "Movie App PRD", path: getBundledDocumentPath("design-documents", "movie-app-prd.txt"), maxChars: 360 },
  {
    label: "Movie App Architecture",
    path: getBundledDocumentPath("design-documents", "movie-app-architecture.txt"),
    maxChars: 360
  }
];

const MAX_BUNDLE_CHARS = 2200;
const PRIORITY_LABELS = new Set(["Control Center Overview", "Control Center Architecture"]);

export function buildAgentContextBundle(userText = "") {
  const chunks = [];
  const loadedFiles = [];
  let usedChars = 0;
  const rankedSpecs = rankContextSpecs(userText);

  for (const spec of rankedSpecs) {
    if (usedChars >= MAX_BUNDLE_CHARS) {
      break;
    }

    if (!existsSync(spec.path)) {
      continue;
    }

    const raw = readFileSync(spec.path, "utf-8");
    const trimmed = String(raw || "").trim();
    if (!trimmed) {
      continue;
    }

    const remaining = MAX_BUNDLE_CHARS - usedChars;
    const budget = Math.min(spec.maxChars, remaining);
    if (budget < 80) {
      break;
    }

    const limited = trimmed.slice(0, budget);
    const entry = `### ${spec.label}\n${limited}`;
    chunks.push(entry);
    loadedFiles.push({ label: spec.label, path: spec.path, chars: limited.length });
    usedChars += entry.length + 2;
  }

  return {
    text: chunks.join("\n\n"),
    loadedFiles
  };
}

function rankContextSpecs(userText) {
  const prompt = String(userText || "").toLowerCase();
  const tokens = new Set(prompt.match(/[a-z0-9-]+/g) || []);

  return [...CONTEXT_SPECS].sort((left, right) => scoreSpec(right, tokens) - scoreSpec(left, tokens));
}

function scoreSpec(spec, tokens) {
  let score = PRIORITY_LABELS.has(spec.label) ? 100 : 0;
  const haystack = `${spec.label} ${path.basename(spec.path)}`.toLowerCase();

  for (const token of tokens) {
    if (token.length < 3) {
      continue;
    }

    if (haystack.includes(token)) {
      score += 15;
    }

    if (token === "movie" && spec.label.toLowerCase().includes("movie")) {
      score += 30;
    }

    if ((token === "architecture" || token === "system") && spec.label.includes("Architecture")) {
      score += 20;
    }

    if ((token === "settings" || token === "voice" || token === "audio") && spec.label.includes("Overview")) {
      score += 20;
    }
  }

  return score;
}