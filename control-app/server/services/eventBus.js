const MAX_EVENTS = 500;
let eventCounter = 1;

const recentEvents = [];
const subscribers = new Set();
const consoleLogs = [];

// Intercept console methods
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;
const originalInfo = console.info;
const originalDebug = console.debug;

function interceptConsole(level, args) {
  const message = args.map(arg => {
    if (typeof arg === 'object') {
      try {
        return JSON.stringify(arg, null, 2);
      } catch {
        return String(arg);
      }
    }
    return String(arg);
  }).join(' ');

  const event = {
    id: nextEventId(),
    timestamp: new Date().toISOString(),
    source: 'console',
    appId: 'control-center',
    type: 'debug',
    level,
    message,
    meta: {
      stack: new Error().stack?.split('\n').slice(2, 4) || []
    }
  };

  recentEvents.push(event);
  if (recentEvents.length > MAX_EVENTS) {
    recentEvents.shift();
  }

  subscribers.forEach((send) => {
    send(event);
  });

  consoleLogs.push(event);
  if (consoleLogs.length > 200) {
    consoleLogs.shift();
  }
}

console.log = function(...args) {
  originalLog(...args);
  interceptConsole('log', args);
};

console.error = function(...args) {
  originalError(...args);
  interceptConsole('error', args);
};

console.warn = function(...args) {
  originalWarn(...args);
  interceptConsole('warn', args);
};

console.info = function(...args) {
  originalInfo(...args);
  interceptConsole('info', args);
};

console.debug = function(...args) {
  originalDebug(...args);
  interceptConsole('debug', args);
};

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
  meta = {},
  thoughts = null,
  isAIThought = false
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
    meta,
    ...(thoughts && { thoughts }),
    ...(isAIThought && { isAIThought: true })
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

export function publishAIThought(thought, meta = {}) {
  return publishEvent({
    source: "ai-runtime",
    appId: "control-center",
    type: "thought",
    message: thought,
    meta,
    isAIThought: true
  });
}

export function publishDebugEvent(message, details = {}) {
  return publishEvent({
    source: "debug",
    appId: "control-center",
    type: "debug",
    message,
    meta: {
      timestamp: new Date().toISOString(),
      ...details
    }
  });
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

export function getConsoleLogs(limit = 50) {
  const parsedLimit = Number(limit);
  const safeLimit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(parsedLimit, 200)) : 50;
  return consoleLogs.slice(-safeLimit);
}

publishEvent({
  source: "system",
  appId: "control-center",
  type: "status",
  message: "Event bus initialized with console interception and AI thought tracking."
});