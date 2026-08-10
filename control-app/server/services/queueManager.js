let queue = [];
let nextId = 1;

const PRIORITY_ORDER = { high: 0, normal: 1, low: 2 };

/**
 * entry: { type: "user"|"system"|"returned"|"reply", message, turnId, origin, priority }
 */
export function enqueueTask(entry) {
  const priority = PRIORITY_ORDER[entry.priority] !== undefined ? entry.priority : "normal";
  const task = {
    task_id: `task_${nextId++}`,
    priority,
    type: entry.type,
    message: entry.message,
    turnId: entry.turnId,
    origin: entry.origin || { type: "user" },
    created_at: new Date().toISOString()
  };

  const insertAt = queue.findIndex((existing) => PRIORITY_ORDER[existing.priority] > PRIORITY_ORDER[task.priority]);
  if (insertAt === -1) {
    queue.push(task);
  } else {
    queue.splice(insertAt, 0, task);
  }

  return task;
}

export function dequeueTask() {
  return queue.shift() || null;
}

export function hasPendingTurnEntries(turnId) {
  return queue.some((task) => task.turnId === turnId);
}

function describeEntry(task) {
  switch (task.type) {
    case "user":
      return String(task.message || "");
    case "reply":
      return String(task.message || "");
    case "system": {
      const tools = (task.message?.apiCalls || []).map((call) => call.tool).join(", ");
      return `[tool request] ${tools}`;
    }
    case "returned": {
      const ok = Array.isArray(task.message) ? task.message.every((entry) => entry.result?.ok) : false;
      return `[tool result] ${ok ? "success" : "failure"}`;
    }
    default:
      return "";
  }
}

export function getQueueStatus() {
  return {
    isEmpty: queue.length === 0,
    queueLength: queue.length,
    tasks: queue.map((task) => ({ task_id: task.task_id, priority: task.priority, content: describeEntry(task) }))
  };
}

export function clearQueue() {
  queue = [];
  return { ok: true, queueLength: 0 };
}
