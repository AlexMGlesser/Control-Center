const audioDeviceOptions = [
  { id: "system-default", label: "System Default" },
  { id: "desktop-speakers", label: "Desktop Speakers" },
  { id: "usb-headset", label: "USB Headset" },
  { id: "bluetooth-earbuds", label: "Bluetooth Earbuds" }
];

const voiceOptions = [
  { id: "neutral-assistant", label: "Neutral Assistant" },
  { id: "clear-professional", label: "Clear Professional" },
  { id: "warm-concise", label: "Warm Concise" }
];

const settingsState = {
  desktop: {
    audioDevice: "system-default",
    voice: "neutral-assistant",
    voiceSpeed: "normal"
  }
};

export function getSettingsOptions() {
  return {
    desktop: {
      audioDeviceOptions,
      voiceOptions,
      voiceSpeedOptions: ["slow", "normal", "fast"]
    }
  };
}

export function getSettings() {
  return {
    desktop: { ...settingsState.desktop }
  };
}

export function updateDesktopSettings(input) {
  const next = {
    audioDevice: String(input?.audioDevice || ""),
    voice: String(input?.voice || ""),
    voiceSpeed: String(input?.voiceSpeed || "")
  };

  const validAudio = audioDeviceOptions.some((opt) => opt.id === next.audioDevice);
  const validVoice = voiceOptions.some((opt) => opt.id === next.voice);
  const validSpeed = ["slow", "normal", "fast"].includes(next.voiceSpeed);

  if (!validAudio || !validVoice || !validSpeed) {
    return {
      ok: false,
      code: "INVALID_SETTINGS",
      message: "One or more desktop settings values are invalid."
    };
  }

  settingsState.desktop = {
    audioDevice: next.audioDevice,
    voice: next.voice,
    voiceSpeed: next.voiceSpeed
  };

  return {
    ok: true,
    settings: getSettings()
  };
}

export function getDesktopSettingsLabelValueMap() {
  const desktop = settingsState.desktop;
  const audioLabel =
    audioDeviceOptions.find((opt) => opt.id === desktop.audioDevice)?.label || desktop.audioDevice;
  const voiceLabel =
    voiceOptions.find((opt) => opt.id === desktop.voice)?.label || desktop.voice;

  return {
    audioDevice: desktop.audioDevice,
    audioDeviceLabel: audioLabel,
    voice: desktop.voice,
    voiceLabel,
    voiceSpeed: desktop.voiceSpeed
  };
}
