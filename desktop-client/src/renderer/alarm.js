// The ringing window: loops the alarm sound until Stop (here, on the PC, or
// from Jarvis), the same sound the PC uses.
const params = new URLSearchParams(location.search);
const alarmId = params.get("id");
document.getElementById("label").textContent = params.get("label") || "Alarm";
document.getElementById("time").textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

const sound = new Audio("./alarm-sound.mp3");
sound.loop = true;
sound.play().catch(() => {});

document.getElementById("stop").addEventListener("click", async () => {
  sound.pause();
  await window.cc.stopAlarm(alarmId).catch(() => {});
  window.close();
});
