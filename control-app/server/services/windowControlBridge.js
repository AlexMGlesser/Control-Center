let windowControlHandler = null;

export function registerWindowControlHandler(handler) {
  if (!handler || typeof handler.closeAppWindow !== "function") {
    windowControlHandler = null;
    console.log("[WindowControlBridge] handler cleared.");
    return;
  }

  windowControlHandler = handler;
  console.log("[WindowControlBridge] handler registered.");
}

export function closeAppWindow(target) {
  if (!windowControlHandler) {
    console.warn("[WindowControlBridge] closeAppWindow called but no handler registered. target:", target);
    return {
      ok: false,
      code: "WINDOW_CONTROL_UNAVAILABLE",
      message: "Desktop window controller is not available."
    };
  }

  console.log("[WindowControlBridge] closeAppWindow called, target:", target);
  try {
    return windowControlHandler.closeAppWindow(String(target || "").trim().toLowerCase());
  } catch (error) {
    return {
      ok: false,
      code: "WINDOW_CONTROL_FAILED",
      message: error?.message || "Could not close app window."
    };
  }
}