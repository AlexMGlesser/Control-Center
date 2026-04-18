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
    description: "Calendar read/write interface planned for Google Calendar integration.",
    status: "wip",
    routeKey: "calendar-app",
    capabilities: ["calendar-read", "calendar-write", "voice-summary"]
  },
  {
    id: "drawing-app",
    name: "Drawing App",
    description: "2D/3D design workspace with reusable asset pipeline.",
    status: "wip",
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
    description: "Desktop-first playback for local music and Spotify.",
    status: "wip",
    routeKey: "music-app",
    capabilities: ["local-music", "spotify", "mobile-stream"]
  },
  {
    id: "server-manager-app",
    name: "Server Manager App",
    description: "Remote server inventory, SSH sessions, and control actions.",
    status: "wip",
    routeKey: "server-manager-app",
    capabilities: ["ssh", "power", "remote-storage"]
  },
  {
    id: "movie-app",
    name: "Movie App",
    description: "Local movie server hosting, streaming sessions, and desktop playback.",
    status: "wip",
    routeKey: "movie-app",
    capabilities: ["movie-library", "streaming", "desktop-playback", "server-control"]
  }
];

export function getAllApps() {
  return appRegistry;
}

export function getAppById(appId) {
  return appRegistry.find((app) => app.id === appId) || null;
}