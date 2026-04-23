import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { serverConfig } from "./config.js";
import apiRouter from "./routes/api.js";
import { attachVoiceWebSocket } from "./services/voiceService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientDir = path.join(__dirname, "..", "client");
const calendarAppDir = path.join(__dirname, "..", "..", "calendar-app");
const newsAppDir = path.join(__dirname, "..", "..", "news-app");
const workAppDir = path.join(__dirname, "..", "..", "work-app");
const projectAppDir = path.join(__dirname, "..", "..", "project-app");
const musicAppDir = path.join(__dirname, "..", "..", "music-app");
const drawingAppDir = path.join(__dirname, "..", "..", "drawing-app");

function createServerApp() {
  const app = express();

  app.use(express.json());
  app.use("/api", apiRouter);
  app.use("/modules/calendar-app", express.static(calendarAppDir));
  app.use("/calendar-app", express.static(calendarAppDir));
  app.use("/modules/news-app", express.static(newsAppDir));
  app.use("/news-app", express.static(newsAppDir));
  app.use("/modules/work-app", express.static(workAppDir));
  app.use("/work-app", express.static(workAppDir));
  app.use("/modules/project-app", express.static(projectAppDir));
  app.use("/project-app", express.static(projectAppDir));
  app.use("/modules/music-app", express.static(musicAppDir));
  app.use("/music-app", express.static(musicAppDir));
  app.use("/modules/drawing-app", express.static(drawingAppDir));
  app.use("/drawing-app", express.static(drawingAppDir));
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

const isDirectRun = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isDirectRun) {
  startServer().catch((error) => {
    console.error("Failed to start Control Center server:", error.message);
    process.exit(1);
  });
}