const appRegistry = [
  {
    id: "project-app",
    name: "Project App",
    description: "Personal projects, coding workflows, and IDE launch integration.",
    status: "online",
    routeKey: "project-app",
    capabilities: ["files", "ide", "agent-summary"]
  },
  {
    id: "work-app",
    name: "Work App",
    description: "Work and school projects with isolated file boundaries.",
    status: "online",
    routeKey: "work-app",
    capabilities: ["files", "ide", "agent-summary"]
  },
  {
    id: "calendar-app",
    name: "Calendar App",
    description: "Monthly schedule workspace with local event reads, adds, removals, and future calendar sync.",
    status: "online",
    routeKey: "calendar-app",
    capabilities: ["calendar-read", "calendar-write", "voice-summary"]
  },
  {
    id: "drawing-app",
    name: "Drawing App",
    description: "2D/3D design workspace with reusable asset pipeline.",
    status: "online",
    routeKey: "drawing-app",
    capabilities: ["2d-canvas", "3d-assets", "shared-assets"]
  },
  {
    id: "news-app",
    name: "News App",
    description: "Weather, headlines, tech updates, and daily STEM content.",
    status: "live",
    routeKey: "news-app",
    capabilities: ["weather", "news", "tech", "daily-stem"]
  },
  {
    id: "music-app",
    name: "Music App",
    description: "Desktop-first playback for local music.",
    status: "online",
    routeKey: "music-app",
    capabilities: ["local-music", "mobile-stream"]
  },
  {
    id: "server-manager-app",
    name: "Server Manager App",
    description: "Remote server inventory, SSH sessions, and control actions.",
    status: "online",
    routeKey: "server-manager-app",
    capabilities: ["ssh", "power", "remote-storage"]
  },
  {
    id: "movie-app",
    name: "Movie App",
    description: "Local movie server hosting, streaming sessions, and desktop playback.",
    status: "online",
    routeKey: "movie-app",
    capabilities: ["movie-library", "streaming", "desktop-playback", "server-control"]
  },
  {
    id: "wikipedia-app",
    name: "Wikipedia App",
    description: "Offline English Wikipedia (GLESSER ARCHIVE librarian): ranked search, article reader, and librarian chat.",
    status: "online",
    routeKey: "wikipedia-app",
    capabilities: ["offline-wikipedia", "search", "article-reader", "librarian-chat"]
  },
  {
    id: "file-system-app",
    name: "File System App",
    description: "Gesture-controlled file explorer and gesture training-data recorder (native Python window, uses the webcam).",
    status: "online",
    version: "0.1",
    routeKey: "file-system-app",
    // Native Tkinter app launched as a managed child process
    // (fileSystemService.js); its route only serves the small control panel.
    launchType: "native-process",
    capabilities: ["hand-tracking", "gesture-file-explorer", "gesture-recorder", "webcam"]
  }
];

export function getAllApps() {
  return appRegistry;
}

export function getAppById(appId) {
  return appRegistry.find((app) => app.id === appId) || null;
}