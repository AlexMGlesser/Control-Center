import { getAppById } from "./appRegistry.js";

export function getOrchestratorStatus() {
  return {
    controlCore: "online",
    appRegistry: "loaded",
    toolGateway: "stub_ready",
    integrationLayer: "stub_ready"
  };
}

export function connectApp(appId) {
  const app = getAppById(appId);

  if (!app) {
    return {
      ok: false,
      code: "APP_NOT_FOUND",
      message: `No registered app found for ${appId}.`
    };
  }

  return {
    ok: true,
    code: "CONNECTOR_STUB",
    message: `${app.name} connector scaffold is available, but full implementation is pending.`,
    appId: app.id
  };
}