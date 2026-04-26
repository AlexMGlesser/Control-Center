import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { serverConfig } from "./config.js";
import apiRouter from "./routes/api.js";
import { stopLmStudioProbe } from "./services/lmStudioService.js";
import { attachVoiceWebSocket, closeVoiceWebSocket } from "./services/voiceService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientDir = path.join(__dirname, "..", "client");
const calendarAppDir = path.join(__dirname, "..", "..", "calendar-app");
const newsAppDir = path.join(__dirname, "..", "..", "news-app");
const workAppDir = path.join(__dirname, "..", "..", "work-app");
const projectAppDir = path.join(__dirname, "..", "..", "project-app");
const musicAppDir = path.join(__dirname, "..", "..", "music-app");
const drawingAppDir = path.join(__dirname, "..", "..", "drawing-app");
const movieAppDir = path.join(__dirname, "..", "..", "movie-app");
const serverManagerAppDir = path.join(__dirname, "..", "..", "server-manager-app");

const APP_STATIC_DIRS = [
  ["calendar-app", calendarAppDir],
  ["news-app", newsAppDir],
  ["work-app", workAppDir],
  ["project-app", projectAppDir],
  ["music-app", musicAppDir],
  ["drawing-app", drawingAppDir],
  ["movie-app", movieAppDir],
  ["server-manager-app", serverManagerAppDir]
];

function createServerApp() {
  const app = express();

  app.use(express.json());
  app.use("/api", apiRouter);
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
  const app = createServerApp();

  return new Promise((resolve, reject) => {
    const server = app
      .listen(serverConfig.port, serverConfig.host, () => {
        console.log(`Control Center running at http://localhost:${serverConfig.port}`);
        attachVoiceWebSocket(server);
        resolve(server);
      })
      .on("error", (error) => {
        reject(error);
      });
  });
}

export function stopServer(server) {
  closeVoiceWebSocket();
  stopLmStudioProbe();

  return new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }

    server.close(() => resolve());
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