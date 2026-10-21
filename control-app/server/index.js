import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { serverConfig } from "./config.js";
import { getBundledAppDirectory } from "./appPaths.js";
import apiRouter, { initializeAgentSystem, shutdownAgentSystem } from "./routes/api.js";
import { attachVoiceWebSocket, closeVoiceWebSocket } from "./services/voiceService.js";
import { publishEvent } from "./services/eventBus.js";
import { apiAuthMiddleware, getLocalSessionSecret, initLocalSession, localLoginHandler } from "./services/authService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientDir = path.join(__dirname, "..", "client");

const APP_STATIC_DIRS = [
  ["calendar-app", getBundledAppDirectory("calendar-app")],
  ["news-app", getBundledAppDirectory("news-app")],
  ["work-app", getBundledAppDirectory("work-app")],
  ["project-app", getBundledAppDirectory("project-app")],
  ["music-app", getBundledAppDirectory("music-app")],
  ["drawing-app", getBundledAppDirectory("drawing-app")],
  ["movie-app", getBundledAppDirectory("movie-app")],
  ["server-manager-app", getBundledAppDirectory("server-manager-app")],
  ["wikipedia-app", getBundledAppDirectory("wikipedia-app")],
  // Only the panel/ subfolder is served — the rest of file-system-app is
  // Python code, the model, and the user's gesture data.
  ["file-system-app", path.join(getBundledAppDirectory("file-system-app"), "panel")]
];

export function createServerApp() {
  const app = express();

  app.use(express.json());
  app.get("/auth/local", localLoginHandler);
  app.use("/api", apiAuthMiddleware, apiRouter);
  // The Wikipedia App's Python server code isn't a static asset — only its
  // wrapper page (index.html/app.js/styles.css) is served from that folder.
  app.use("/wikipedia-app/librarian", (req, res) => res.status(404).end());
  APP_STATIC_DIRS.forEach(([routeKey, appDir]) => {
    app.use(`/${routeKey}`, express.static(appDir));
  });
  app.use(express.static(clientDir));

  app.get("*", (req, res) => {
    res.sendFile(path.join(clientDir, "index.html"));
  });

  return app;
}

export function startServer() {
  initLocalSession();
  const app = createServerApp();

  return new Promise((resolve, reject) => {
    const server = app
      .listen(serverConfig.port, serverConfig.host, () => {
        console.log(`Control Center running at http://localhost:${serverConfig.port}`);
        if (isDirectRun) {
          // Browser (start:web) has no Electron to set the session cookie.
          console.log(
            `Open this link to sign in from this PC's browser: http://localhost:${serverConfig.port}/auth/local?token=${getLocalSessionSecret()}`
          );
        }
        attachVoiceWebSocket(server);
        initializeAgentSystem();
        resolve(server);
      })
      .on("error", (error) => {
        reject(error);
      });
  });
}

export async function stopServer(server) {
  // Tell connected devices this is a deliberate shutdown, not a network
  // problem, before their streams close.
  publishEvent({
    source: "control-center",
    appId: "control-center",
    type: "server-stopping",
    message: "Control Center is shutting down."
  });
  closeVoiceWebSocket();
  await shutdownAgentSystem();

  return new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }

    server.close(() => resolve());
    // close() waits for every open connection to end, and the UI's SSE
    // stream (/api/events/stream) never ends on its own — without this the
    // close callback never fires and shutdown hangs.
    server.closeAllConnections?.();
  });
}

const isDirectRun = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isDirectRun) {
  startServer().catch((error) => {
    console.error("Failed to start Control Center server:", error.message);
    process.exit(1);
  });
}