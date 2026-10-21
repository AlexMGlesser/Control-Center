export const serverConfig = {
  port: Number(process.env.PORT || 3100),
  // Localhost only: Electron loads localhost, and remote devices come in
  // through `tailscale serve`, which also connects from localhost. Binding
  // 0.0.0.0 exposed the whole API to the home network.
  host: process.env.HOST || "127.0.0.1"
};

export const systemConfig = {
  name: "Control Center",
  version: "1.0.0",
  mode: "desktop",
  ollama: {
    status: "not_connected",
    model: null
  },
  server: {
    status: "running"
  }
};