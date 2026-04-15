export const serverConfig = {
  port: Number(process.env.PORT || 3100),
  host: process.env.HOST || "0.0.0.0"
};

export const systemConfig = {
  name: "Control Center",
  version: "0.1.0",
  mode: "desktop",
  lmStudio: {
    status: "not_connected",
    model: null
  },
  server: {
    status: "running"
  }
};