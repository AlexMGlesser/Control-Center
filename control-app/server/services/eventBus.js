const MAX_EVENTS = 250;
let eventCounter = 1;

const recentEvents = [];
const subscribers = new Set();

function nextEventId() {
  const id = eventCounter;
  eventCounter += 1;
  return id;
}

export function publishEvent({
  source = "system",
  appId = "control-center",
  type = "info",
  message,
  meta = {}
}) {
  if (!message || !String(message).trim()) {
    return {
      ok: false,
      code: "INVALID_EVENT",
      message: "Event message is required."
    };
  }

  const event = {
    id: nextEventId(),
    timestamp: new Date().toISOString(),
    source,
    appId,
    type,
    message: String(message),
    meta
  };

  recentEvents.push(event);
  if (recentEvents.length > MAX_EVENTS) {
    recentEvents.shift();
  }

  subscribers.forEach((send) => {
    send(event);
  });

  return { ok: true, event };
}

export function getRecentEvents(limit = 40) {
  const parsedLimit = Number(limit);
  const safeLimit = Number.isFinite(parsedLimit)
    ? Math.max(1, Math.min(parsedLimit, MAX_EVENTS))
    : 40;

  return recentEvents.slice(-safeLimit).reverse();
}

export function subscribeToEvents(sendFn) {
  subscribers.add(sendFn);
  return () => subscribers.delete(sendFn);
}

publishEvent({
  source: "system",
  appId: "control-center",
  type: "status",
  message: "Event bus initialized."
});