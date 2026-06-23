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