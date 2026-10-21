import { execFile } from "child_process";
import { existsSync } from "fs";
import { serverConfig } from "../config.js";

// Remote devices reach Control Center through Tailscale: `tailscale serve`
// publishes https://<pc>.<tailnet>.ts.net and forwards to this server on
// localhost. This service only reads Tailscale's state (for the pairing QR
// code and the desktop's setup checklist); it never changes it.

const TAILSCALE_CANDIDATES = ["tailscale", "C:\\Program Files\\Tailscale\\tailscale.exe"];
const COMMAND_TIMEOUT_MS = 5000;
const CACHE_MS = 10_000;

let cached = null; // { at, value }

function runTailscale(args) {
  return new Promise((resolve) => {
    const tryCandidate = (index) => {
      if (index >= TAILSCALE_CANDIDATES.length) {
        resolve({ ok: false, notFound: true });
        return;
      }
      const command = TAILSCALE_CANDIDATES[index];
      if (command.includes("\\") && !existsSync(command)) {
        tryCandidate(index + 1);
        return;
      }
      execFile(command, args, { windowsHide: true, timeout: COMMAND_TIMEOUT_MS }, (error, stdout) => {
        if (error?.code === "ENOENT") {
          tryCandidate(index + 1);
          return;
        }
        // `tailscale status` exits non-zero when signed out but still prints JSON.
        resolve({ ok: Boolean(stdout), stdout: String(stdout || "") });
      });
    };
    tryCandidate(0);
  });
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Tailscale's state as a setup checklist:
 * { installed, signedIn, dnsName, httpsCertificates, serveConfigured, publicUrl, nextStep }
 */
export async function getRemoteAccessStatus({ fresh = false } = {}) {
  if (!fresh && cached && Date.now() - cached.at < CACHE_MS) {
    return cached.value;
  }

  const status = await runTailscale(["status", "--json"]);
  const statusJson = status.ok ? parseJson(status.stdout) : null;
  const installed = !status.notFound;
  const signedIn = statusJson?.BackendState === "Running";
  const dnsName = String(statusJson?.Self?.DNSName || "").replace(/\.$/, "") || null;
  const httpsCertificates = Array.isArray(statusJson?.CertDomains) && statusJson.CertDomains.length > 0;

  let serveConfigured = false;
  if (signedIn) {
    const serve = await runTailscale(["serve", "status", "--json"]);
    // Any serve handler proxying to this server's port counts.
    serveConfigured = serve.ok && new RegExp(`(localhost|127\\.0\\.0\\.1):${serverConfig.port}\\b`).test(serve.stdout);
  }

  const override = String(process.env.CONTROL_CENTER_PUBLIC_URL || "").trim().replace(/\/$/, "");
  const publicUrl = override || (signedIn && dnsName ? `https://${dnsName}` : null);

  let nextStep = null;
  if (!override) {
    if (!installed) nextStep = "Install Tailscale on this PC.";
    else if (!signedIn) nextStep = "Sign in to Tailscale on this PC.";
    else if (!httpsCertificates) nextStep = "Turn on HTTPS certificates in the Tailscale admin console (DNS page).";
    else if (!serveConfigured) nextStep = `Run: tailscale serve --bg ${serverConfig.port}`;
  }

  const value = { installed, signedIn, dnsName, httpsCertificates, serveConfigured, publicUrl, nextStep };
  cached = { at: Date.now(), value };
  return value;
}
