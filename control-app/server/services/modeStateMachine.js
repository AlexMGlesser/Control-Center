const DESKTOP_MODE = "desktop";
const MOBILE_MODE = "mobile";

const modeState = {
  currentMode: DESKTOP_MODE,
  lastTransitionAt: new Date().toISOString(),
  history: [
    {
      from: null,
      to: DESKTOP_MODE,
      action: "INIT",
      source: "system",
      at: new Date().toISOString()
    }
  ]
};

function getAllowedTargets(currentMode) {
  if (currentMode === DESKTOP_MODE) {
    return [MOBILE_MODE];
  }

  if (currentMode === MOBILE_MODE) {
    return [DESKTOP_MODE];
  }

  return [DESKTOP_MODE, MOBILE_MODE];
}

export function getModeState() {
  return {
    currentMode: modeState.currentMode,
    allowedTargets: getAllowedTargets(modeState.currentMode),
    lastTransitionAt: modeState.lastTransitionAt,
    history: modeState.history.slice(-20)
  };
}

export function switchMode(targetMode, source = "ui") {
  if (targetMode !== DESKTOP_MODE && targetMode !== MOBILE_MODE) {
    return {
      ok: false,
      code: "INVALID_MODE",
      message: `Unsupported mode '${targetMode}'. Expected 'desktop' or 'mobile'.`
    };
  }

  if (targetMode === modeState.currentMode) {
    return {
      ok: true,
      changed: false,
      code: "NO_TRANSITION",
      message: `System is already in ${targetMode} mode.`,
      mode: getModeState()
    };
  }

  const from = modeState.currentMode;
  const to = targetMode;
  const action = to === DESKTOP_MODE ? "SWITCH_TO_DESKTOP" : "SWITCH_TO_MOBILE";
  const timestamp = new Date().toISOString();

  modeState.currentMode = to;
  modeState.lastTransitionAt = timestamp;
  modeState.history.push({ from, to, action, source, at: timestamp });
  if (modeState.history.length > 100) {
    modeState.history.shift();
  }

  return {
    ok: true,
    changed: true,
    code: "TRANSITION_OK",
    message: `Mode changed from ${from} to ${to}.`,
    transition: { from, to, action, source, at: timestamp },
    mode: getModeState()
  };
}