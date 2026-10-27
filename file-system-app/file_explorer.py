"""
File System App: gesture-controlled file explorer
Navigate files using hand gestures:
  Index fingertip              -> move cursor / hover over items
  Other hand pointing (index)  -> enter folders / preview files
  Swipe hand up/down quickly   -> scroll the file list
"""

import math
import os
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
os.environ.setdefault("GLOG_minloglevel", "3")
os.environ.setdefault("GLOG_logtostderr", "1")
import json
import shutil
import stat
import threading
import time
from collections import deque
from datetime import datetime

import cv2
import mediapipe as mp
import numpy as np
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision as mp_vision
from PIL import Image, ImageTk
import tkinter as tk
from tkinter import messagebox, simpledialog, ttk

__version__ = "0.1.0"

# ── Paths ──────────────────────────────────────────────────────────────────
# Code and the model live beside this file. User data (calibration profiles,
# recorded datasets) lives under DATA_DIR, which defaults to this folder but
# can be redirected with FILE_SYSTEM_DATA_DIR (Control Center does this in
# packaged builds, where the app folder is read-only).
APP_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.abspath(os.environ.get("FILE_SYSTEM_DATA_DIR") or APP_DIR)

# ── Model ──────────────────────────────────────────────────────────────────
MODEL_PATH = os.path.join(APP_DIR, "hand_landmarker.task")

# ── Hand skeleton ──────────────────────────────────────────────────────────
FINGERTIP_IDS = [4, 8, 12, 16, 20]
HAND_CONNECTIONS = [
    (0, 1), (1, 2), (2, 3), (3, 4),
    (0, 5), (5, 6), (6, 7), (7, 8),
    (0, 9), (9, 10), (10, 11), (11, 12),
    (0, 13), (13, 14), (14, 15), (15, 16),
    (0, 17), (17, 18), (18, 19), (19, 20),
    (5, 9), (9, 13), (13, 17),
]

# ── Layout ─────────────────────────────────────────────────────────────────
WIN_W, WIN_H  = 1280, 800
HEADER_H      = 40
TREE_W        = 280
CAM_W, CAM_H  = 296, 222
PREVIEW_W, PREVIEW_H = 440, 260
ITEM_W, ITEM_H = 120, 110
ITEM_PAD       = 16

# ── Colours (Catppuccin Mocha) ─────────────────────────────────────────────
BG        = "#1e1e2e"
HEADER_BG = "#181825"
SURFACE   = "#313244"
HOVER_BG  = "#45475a"
SEL_BG    = "#89b4fa"
TXT       = "#cdd6f4"
TXT_SEL   = "#1e1e2e"
YELLOW    = "#f9e2af"
TEAL      = "#89dceb"
GREEN     = "#a6e3a1"
MAUVE     = "#cba6f7"
RED       = "#f38ba8"
MUTED     = "#6c7086"

# ── Gesture tuning ─────────────────────────────────────────────────────────
SELECT_COOLDOWN = 0.7
SELECT_HOLD_FRAMES = 3
SWIPE_VEL        = 0.35
SWIPE_TRAVEL     = 0.035
SWIPE_COOLDOWN   = 0.18
BACK_SWIPE_VEL = 0.32
BACK_SWIPE_TRAVEL = 0.045
BACK_DIR_DOMINANCE = 1.05
BACK_COOLDOWN = 0.85
RESET_WAVE_TRAVEL = 0.035
RESET_WAVE_WINDOW = 0.9
RESET_COOLDOWN    = 0.8
RESET_STATUS_TIME = 1.5
RESET_HOLD_FRAMES = 2
OPEN_MIN_EXTENDED = 2
PTR_ALPHA        = 0.18
PTR_RAY          = 2.4
PTR_DEADZONE_PX  = 2.0
SCROLL_FRICTION = 0.88
SCROLL_SCALE    = 520
PREFERRED_POINTER_LABEL = "Left"
# Keep inference square to avoid MediaPipe NORM_RECT non-square warnings.
INFER_W, INFER_H = 320, 320
TRACKER_FPS = 24
CAMERA_UI_FPS = 12
HOVER_PREVIEW_SEC = 0.45
PROFILE_DIR = os.path.join(DATA_DIR, "gesture_profiles")
CALIB_COUNTDOWN_SEC = 3
CALIB_RECORD_SEC = 2
WIREFRAME_PERSIST_SEC = 0.22
CALIB_ACTIONS = [
    "select",
    "back_swipe",
    "reset_pointer",
    "scroll_up",
    "scroll_down",
    "pointer_tracking",
]


# ══════════════════════════════════════════════════════════════════════════
# Background hand tracker
# ══════════════════════════════════════════════════════════════════════════

def ensure_model():
    if os.path.exists(MODEL_PATH):
        return
    raise FileNotFoundError(
        f"Missing local MediaPipe model: {MODEL_PATH}\n"
        "This app runs offline and will not download model files."
    )


class HandTracker:
    def __init__(self):
        self._lm = None
        self._cap = None
        self._available = False
        self._init_done = False
        self._init_error = ""
        self._lock  = threading.Lock()
        self._frame = None
        self._raw_frame = None
        self._wire_frame = None
        self._hands = []
        self._last_wire_pts = []
        self._last_wire_ts = 0.0
        self._t0    = time.perf_counter()
        self._alive = False
        self._thread = None
        self._last_infer_at = 0.0
        # Per-frame metadata so consumers that need every frame exactly once
        # (gesture_recorder.py) can tell a new frame from a re-read of the
        # same one. Additive only; latest() is unchanged.
        self._seq = 0
        self._frame_ts = 0.0

    @property
    def is_available(self):
        return self._available

    @property
    def init_done(self):
        return self._init_done

    @property
    def init_error(self):
        return self._init_error

    def _open_camera(self):
        # Use DirectShow only on Windows; MSMF/default backend probing can hang
        # indefinitely on some systems and block app startup.
        candidates = [
            (0, cv2.CAP_DSHOW),
            (1, cv2.CAP_DSHOW),
        ]

        for index, backend in candidates:
            cap = cv2.VideoCapture(index, backend)
            if not cap or not cap.isOpened():
                if cap:
                    cap.release()
                continue

            cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
            cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 360)
            cap.set(cv2.CAP_PROP_FPS, TRACKER_FPS)
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)

            # Validate that the device can actually deliver frames.
            ok = False
            for _ in range(5):
                ret, _frame = cap.read()
                if ret:
                    ok = True
                    break
                time.sleep(0.02)

            if ok:
                return cap
            cap.release()
        return None

    def start(self):
        if self._thread is not None and self._thread.is_alive():
            return
        self._alive = True
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def stop(self):
        self._alive = False
        if self._thread is not None and self._thread.is_alive():
            self._thread.join(timeout=1.0)
        if self._cap is not None:
            self._cap.release()
            self._cap = None
        if self._lm is not None:
            self._lm.close()
            self._lm = None

    def latest(self):
        with self._lock:
            return self._frame, self._raw_frame, self._wire_frame, list(self._hands)

    def latest_with_meta(self):
        """Like latest(), plus (seq, capture_time) — seq increments once per
        processed camera frame, capture_time is time.time() at capture."""
        with self._lock:
            return (
                self._frame, self._raw_frame, self._wire_frame, list(self._hands),
                self._seq, self._frame_ts,
            )

    def _loop(self):
        try:
            ensure_model()
            base = mp_python.BaseOptions(model_asset_path=MODEL_PATH)
            opts = mp_vision.HandLandmarkerOptions(
                base_options=base,
                running_mode=mp_vision.RunningMode.VIDEO,
                num_hands=2,
                min_hand_detection_confidence=0.5,
                min_hand_presence_confidence=0.5,
                min_tracking_confidence=0.5,
            )
            self._lm = mp_vision.HandLandmarker.create_from_options(opts)
            self._cap = self._open_camera()
            self._available = self._cap is not None
            self._init_done = True
            if not self._available:
                self._init_error = "Camera unavailable"
                self._alive = False
                return
        except Exception as exc:
            self._init_error = str(exc)
            self._init_done = True
            self._available = False
            self._alive = False
            return

        while self._alive:
            try:
                now_loop = time.perf_counter()
                elapsed = now_loop - self._last_infer_at
                min_interval = 1.0 / TRACKER_FPS
                if elapsed < min_interval:
                    time.sleep(min_interval - elapsed)
                self._last_infer_at = time.perf_counter()

                ret, frame = self._cap.read()
                if not ret:
                    time.sleep(0.01)
                    continue
                captured_at = time.time()

                frame = cv2.flip(frame, 1)
                raw_frame = frame.copy()
                wire_frame = np.zeros_like(frame)
                h, w = frame.shape[:2]

                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                infer = cv2.resize(rgb, (INFER_W, INFER_H), interpolation=cv2.INTER_LINEAR)
                mp_img = mp.Image(image_format=mp.ImageFormat.SRGB, data=infer)
                ts = int((time.perf_counter() - self._t0) * 1000.0)

                result = self._lm.detect_for_video(mp_img, ts)
                hand_infos = []
                handedness = getattr(result, "handedness", []) or []
                detected_wire_pts = []

                # Draw skeleton onto preview frame
                if result.hand_landmarks:
                    for hand_index, lms in enumerate(result.hand_landmarks):
                        pts = [(int(lm.x * w), int(lm.y * h)) for lm in lms]
                        detected_wire_pts.append(pts)
                        for a, b in HAND_CONNECTIONS:
                            cv2.line(frame, pts[a], pts[b], (0, 220, 0), 2)
                            cv2.line(wire_frame, pts[a], pts[b], (0, 220, 0), 2)
                        for tip in FINGERTIP_IDS:
                            cv2.circle(frame, pts[tip], 8, (0, 0, 220), -1)
                            cv2.circle(frame, pts[tip], 8, (0, 0, 160), 2)
                            cv2.circle(wire_frame, pts[tip], 8, (0, 0, 220), -1)
                            cv2.circle(wire_frame, pts[tip], 8, (0, 0, 160), 2)

                        label = f"hand_{hand_index}"
                        score = None
                        if hand_index < len(handedness) and handedness[hand_index]:
                            label = getattr(handedness[hand_index][0], "category_name", label)
                            score = getattr(handedness[hand_index][0], "score", None)

                        world = getattr(result, "hand_world_landmarks", None) or []
                        hand_infos.append(
                            {
                                "id": f"{label}_{hand_index}",
                                "label": label,
                                "landmarks": lms,
                                # Additive fields used by gesture_recorder.py.
                                "score": score,
                                "world_landmarks": world[hand_index] if hand_index < len(world) else None,
                            }
                        )

                now = time.perf_counter()
                if detected_wire_pts:
                    self._last_wire_pts = detected_wire_pts
                    self._last_wire_ts = now
                elif self._last_wire_pts and (now - self._last_wire_ts) <= WIREFRAME_PERSIST_SEC:
                    # Keep last known skeleton briefly to hide one-frame tracker dropouts.
                    for pts in self._last_wire_pts:
                        for a, b in HAND_CONNECTIONS:
                            cv2.line(wire_frame, pts[a], pts[b], (0, 170, 0), 2)
                        for tip in FINGERTIP_IDS:
                            cv2.circle(wire_frame, pts[tip], 8, (0, 0, 170), -1)
                else:
                    self._last_wire_pts = []

                with self._lock:
                    self._frame = frame
                    self._raw_frame = raw_frame
                    self._wire_frame = wire_frame
                    self._hands = hand_infos
                    self._seq += 1
                    self._frame_ts = captured_at
            except Exception as exc:
                self._init_error = f"Tracker runtime error: {exc}"
                self._available = False
                self._alive = False
                break


# ══════════════════════════════════════════════════════════════════════════
# File icon helpers
# ══════════════════════════════════════════════════════════════════════════

def item_style(fpath):
    """Return (colour, emoji) for a filesystem entry."""
    if fpath is None:
        return MUTED, "⬆"
    if os.path.isdir(fpath):
        return YELLOW, "📁"
    ext = os.path.splitext(fpath)[1].lower()
    if ext in {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".ico"}:
        return MAUVE, "🖼"
    if ext in {".exe", ".bat", ".cmd", ".sh", ".msi"}:
        return GREEN, "⚙"
    if ext in {".py", ".js", ".ts", ".c", ".cpp", ".cs", ".java", ".rs", ".go"}:
        return TEAL, "💻"
    return TEAL, "📄"


_HIDDEN_ATTRS = getattr(stat, "FILE_ATTRIBUTE_HIDDEN", 0x2) | getattr(stat, "FILE_ATTRIBUTE_SYSTEM", 0x4)


def is_hidden_entry(entry):
    """True for dot-prefixed names and for entries with the Windows HIDDEN or
    SYSTEM attribute ($Recycle.Bin, pagefile.sys, ...). Accepts an
    os.DirEntry (uses its cached stat) or a path. If the attributes can't be
    read (permission denied, vanished), the entry counts as not hidden."""
    if isinstance(entry, os.DirEntry):
        name = entry.name
        get_stat = lambda: entry.stat(follow_symlinks=False)
    else:
        path = os.fspath(entry)
        name = os.path.basename(path.rstrip("\\/"))
        get_stat = lambda: os.stat(path, follow_symlinks=False)
    if name.startswith("."):
        return True
    try:
        attrs = getattr(get_stat(), "st_file_attributes", 0)
    except OSError:
        return False
    return bool(attrs & _HIDDEN_ATTRS)


def list_dir_entries(path, show_hidden=False):
    """Return (dir_names, file_names), each sorted case-insensitively, with
    hidden entries dropped unless show_hidden. Raises OSError if the folder
    itself can't be read. Every directory listing in the app goes through here."""
    dirs = []
    files = []
    with os.scandir(path) as it:
        for entry in it:
            try:
                if not show_hidden and is_hidden_entry(entry):
                    continue
                if entry.is_dir(follow_symlinks=False):
                    dirs.append(entry.name)
                else:
                    files.append(entry.name)
            except OSError:
                # Skip problematic entries instead of freezing the UI.
                continue
    dirs.sort(key=str.lower)
    files.sort(key=str.lower)
    return dirs, files


class GestureProfiler:
    """Records landmark streams and builds per-gesture profile summaries."""
    def __init__(self, base_dir):
        self.base_dir = base_dir
        self.sessions_dir = os.path.join(base_dir, "sessions")
        os.makedirs(self.sessions_dir, exist_ok=True)
        self._active = False
        self._gesture = ""
        self._meta = {}
        self._fp = None
        self._frames = 0
        self._start_ts = 0.0

    @property
    def is_active(self):
        return self._active

    @property
    def gesture(self):
        return self._gesture

    def start(self, gesture_name, pointer_label):
        if self._active:
            return False, "A recording is already active"
        gesture = (gesture_name or "").strip()
        if not gesture:
            return False, "Gesture name is required"

        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        session_id = f"{gesture}_{ts}"
        session_dir = os.path.join(self.sessions_dir, session_id)
        os.makedirs(session_dir, exist_ok=True)
        events_path = os.path.join(session_dir, "events.jsonl")
        meta_path = os.path.join(session_dir, "meta.json")

        self._meta = {
            "session_id": session_id,
            "gesture": gesture,
            "pointer_label": pointer_label,
            "created_at": datetime.now().isoformat(timespec="seconds"),
            "events_path": events_path,
            "meta_path": meta_path,
        }

        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump(self._meta, f, indent=2)

        self._fp = open(events_path, "w", encoding="utf-8")
        self._frames = 0
        self._start_ts = time.time()
        self._active = True
        self._gesture = gesture
        return True, session_id

    def add_frame(self, ts_now, hands):
        if not self._active or self._fp is None:
            return

        event_hands = []
        for hand in hands:
            lms = hand.get("landmarks", [])
            event_hands.append(
                {
                    "id": hand.get("id"),
                    "label": hand.get("label"),
                    "landmarks": [[lm.x, lm.y, lm.z] for lm in lms],
                }
            )

        event = {
            "t": ts_now,
            "dt": ts_now - self._start_ts,
            "hands": event_hands,
        }
        self._fp.write(json.dumps(event) + "\n")
        self._frames += 1

    def stop(self):
        if not self._active:
            return False, "No active recording"

        if self._fp:
            self._fp.close()
            self._fp = None

        duration = max(0.0, time.time() - self._start_ts)
        summary = {
            "frames": self._frames,
            "duration_sec": duration,
            "fps": (self._frames / duration) if duration > 0 else 0.0,
            "stopped_at": datetime.now().isoformat(timespec="seconds"),
        }

        meta_path = self._meta.get("meta_path")
        if meta_path and os.path.exists(meta_path):
            with open(meta_path, "r", encoding="utf-8") as f:
                meta = json.load(f)
            meta["summary"] = summary
            with open(meta_path, "w", encoding="utf-8") as f:
                json.dump(meta, f, indent=2)

        gesture = self._gesture
        self._active = False
        self._gesture = ""
        self._meta = {}
        return True, {"gesture": gesture, **summary}

    def build_profiles(self):
        sessions = []
        if not os.path.isdir(self.sessions_dir):
            return False, "No session directory found"

        for name in os.listdir(self.sessions_dir):
            session_dir = os.path.join(self.sessions_dir, name)
            if not os.path.isdir(session_dir):
                continue
            meta_path = os.path.join(session_dir, "meta.json")
            events_path = os.path.join(session_dir, "events.jsonl")
            if os.path.exists(meta_path) and os.path.exists(events_path):
                sessions.append((meta_path, events_path))

        if not sessions:
            return False, "No recordings found"

        grouped = {}
        for meta_path, events_path in sessions:
            with open(meta_path, "r", encoding="utf-8") as f:
                meta = json.load(f)
            gesture = meta.get("gesture", "unknown")
            grouped.setdefault(gesture, []).append((meta, events_path))

        profiles = {
            "generated_at": datetime.now().isoformat(timespec="seconds"),
            "gestures": {},
        }

        for gesture, items in grouped.items():
            sample_count = 0
            durations = []
            frame_counts = []
            path_len_x = []
            path_len_y = []
            speed_samples = []

            for meta, events_path in items:
                sample_count += 1
                frames = []
                with open(events_path, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        frames.append(json.loads(line))

                frame_counts.append(len(frames))
                durations.append(float(meta.get("summary", {}).get("duration_sec", 0.0)))

                last_x = None
                last_y = None
                last_t = None
                total_x = 0.0
                total_y = 0.0

                for ev in frames:
                    hands = ev.get("hands", [])
                    if not hands:
                        continue
                    # Use first tracked hand in recording as primary movement trace.
                    lms = hands[0].get("landmarks", [])
                    if not lms:
                        continue
                    wrist = lms[0]
                    t = float(ev.get("dt", 0.0))
                    x, y = float(wrist[0]), float(wrist[1])
                    if last_x is not None and last_y is not None:
                        dx = x - last_x
                        dy = y - last_y
                        total_x += abs(dx)
                        total_y += abs(dy)
                        dt = max(1e-6, t - last_t)
                        speed_samples.append(math.hypot(dx, dy) / dt)
                    last_x, last_y, last_t = x, y, t

                path_len_x.append(total_x)
                path_len_y.append(total_y)

            mean = lambda vals: (sum(vals) / len(vals)) if vals else 0.0
            profiles["gestures"][gesture] = {
                "samples": sample_count,
                "avg_duration_sec": mean(durations),
                "avg_frames": mean(frame_counts),
                "avg_path_x": mean(path_len_x),
                "avg_path_y": mean(path_len_y),
                "avg_speed": mean(speed_samples),
                "p95_speed": sorted(speed_samples)[int(0.95 * (len(speed_samples) - 1))] if speed_samples else 0.0,
            }

        out_path = os.path.join(self.base_dir, "profiles.json")
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(profiles, f, indent=2)

        return True, out_path


# ══════════════════════════════════════════════════════════════════════════
# Main application
# ══════════════════════════════════════════════════════════════════════════

class FileExplorerApp:
    def __init__(self, root, start_path):
        self.root = root
        root.title(f"File System v{__version__}")
        root.geometry(f"{WIN_W}x{WIN_H}")
        root.configure(bg=BG)
        root.minsize(960, 640)
        root.resizable(True, True)
        root.attributes("-alpha", 0.82)  # slight transparency so desktop shows through

        self.path    = os.path.abspath(start_path)
        self.entries = []    # [(display_name, full_path_or_None), ...]
        self.hover_i = -1
        self.sel_i   = -1
        self._hover_since = 0.0
        self._previewed_hover_i = -1

        # Smoothed pointer position (window coords)
        self._sx = float(WIN_W) / 2
        self._sy = float(WIN_H) / 2
        self._pointer_offset_x = 0.0
        self._pointer_offset_y = 0.0
        self._primary_label = PREFERRED_POINTER_LABEL

        # Other-hand select state
        self._select_until = 0.0
        self._left_point_frames = 0
        self._last_swipe_at = 0.0
        self._last_reset_at = 0.0
        self._last_back_at = 0.0
        self._reset_pose_frames = 0
        self._reset_active = False
        self._reset_start_x = 0.0
        self._reset_start_t = 0.0
        self._status_until = 0.0
        self._status_text = ""
        self._clipboard_path = None
        self._clipboard_mode = None  # "copy" or "cut"
        self._preview_path = None

        # Scroll state
        self._scroll_px  = 0.0
        self._scroll_vel = 0.0
        self._total_h    = 0
        self._wrist_hist = deque(maxlen=10)   # (time, y_norm)
        self._back_hist  = deque(maxlen=10)   # (time, x_norm, y_norm)
        self._last_grid_width = 0
        self._last_visible_row = -1

        # Keep photo reference alive to prevent garbage collection
        self._cam_photo = None
        self._preview_photo = None
        self._tree_loading = False
        self._last_cam_ui_at = 0.0
        self._profiler = GestureProfiler(PROFILE_DIR)
        self._gesture_cfg = {
            "select_hold_frames": SELECT_HOLD_FRAMES,
            "swipe_vel": SWIPE_VEL,
            "swipe_travel": SWIPE_TRAVEL,
            "back_swipe_vel": BACK_SWIPE_VEL,
            "back_swipe_travel": BACK_SWIPE_TRAVEL,
            "back_dir_dominance": BACK_DIR_DOMINANCE,
            "reset_wave_travel": RESET_WAVE_TRAVEL,
            "reset_wave_window": RESET_WAVE_WINDOW,
        }
        self._calib_win = None
        self._calib_cam_lbl = None
        self._calib_wire_lbl = None
        self._calib_photo = None
        self._calib_wire_photo = None
        self._calib_status_var = tk.StringVar(value="")
        self._calib_action_var = tk.StringVar(value=CALIB_ACTIONS[0])
        self._calib_record_btn = None
        self._calib_countdown_until = 0.0
        self._calib_record_until = 0.0
        self._calib_pending_action = ""
        self._wire_action_var = tk.StringVar(value="Action: none")
        self._wire_action_until = 0.0
        self._tracker_state_announced = False
        self._last_tracker_error = ""
        self._load_req_id = 0
        self._show_hidden_var = tk.BooleanVar(value=False)

        self._build_ui()
        self.load_dir(self.path)
        self._load_and_apply_profiles(silent=True)

        self._tracker = HandTracker()
        self._tracker.start()
        self._status_text = "Initializing camera..."
        self._status_until = time.time() + 8.0

        root.after(33, self._tick)
        root.protocol("WM_DELETE_WINDOW", self._close)

    # ── UI construction ─────────────────────────────────────────────────────

    def _build_ui(self):
        # Header / address bar
        hdr = tk.Frame(self.root, bg=HEADER_BG, height=HEADER_H)
        hdr.pack(fill=tk.X, side=tk.TOP)
        hdr.pack_propagate(False)

        self._path_var = tk.StringVar()
        tk.Label(
            hdr, textvariable=self._path_var,
            bg=HEADER_BG, fg=TXT, font=("Segoe UI", 10),
            anchor="w", padx=12,
        ).pack(fill=tk.BOTH, expand=True)

        tools = tk.Frame(self.root, bg=BG, height=36)
        tools.pack(fill=tk.X, side=tk.TOP)
        tools.pack_propagate(False)

        btn_kwargs = {
            "bg": SURFACE,
            "fg": TXT,
            "activebackground": HOVER_BG,
            "activeforeground": TXT,
            "relief": "flat",
            "bd": 0,
            "font": ("Segoe UI", 9),
            "padx": 10,
            "pady": 4,
        }

        tk.Button(tools, text="New File", command=self._create_new_file, **btn_kwargs).pack(side=tk.LEFT, padx=4, pady=4)
        tk.Button(tools, text="New Folder", command=self._create_new_folder, **btn_kwargs).pack(side=tk.LEFT, padx=4, pady=4)
        tk.Button(tools, text="Open File", command=self._open_selected_file, **btn_kwargs).pack(side=tk.LEFT, padx=4, pady=4)
        tk.Button(tools, text="Delete", command=self._delete_selected, **btn_kwargs).pack(side=tk.LEFT, padx=4, pady=4)
        tk.Button(tools, text="Copy", command=self._copy_selected, **btn_kwargs).pack(side=tk.LEFT, padx=4, pady=4)
        tk.Button(tools, text="Cut", command=self._cut_selected, **btn_kwargs).pack(side=tk.LEFT, padx=4, pady=4)
        tk.Button(tools, text="Paste", command=self._paste_into_current, **btn_kwargs).pack(side=tk.LEFT, padx=4, pady=4)
        tk.Button(tools, text="Calibration Wizard", command=self._open_calibration_wizard, **btn_kwargs).pack(side=tk.LEFT, padx=12, pady=4)
        tk.Button(tools, text="Build Profiles", command=self._build_gesture_profiles, **btn_kwargs).pack(side=tk.LEFT, padx=4, pady=4)
        # A Checkbutton has invoke(), so the gesture "select" reaches it through
        # _invoke_widget_at_pointer exactly like the buttons above.
        tk.Checkbutton(
            tools, text="Show hidden files", variable=self._show_hidden_var,
            command=self._toggle_show_hidden, selectcolor=SURFACE,
            **{**btn_kwargs, "bg": BG, "activebackground": BG},
        ).pack(side=tk.LEFT, padx=12, pady=4)

        body = tk.Frame(self.root, bg=BG)
        body.pack(fill=tk.BOTH, expand=True)

        tree_wrap = tk.Frame(body, bg=HEADER_BG, width=TREE_W)
        tree_wrap.pack(side=tk.LEFT, fill=tk.Y)
        tree_wrap.pack_propagate(False)
        self._drive_btn = tk.Menubutton(tree_wrap, text="Drives", **btn_kwargs)
        self._drive_menu = tk.Menu(self._drive_btn, tearoff=0, bg=SURFACE, fg=TXT)
        self._drive_btn.configure(menu=self._drive_menu)
        self._drive_btn.pack(fill=tk.X, padx=8, pady=(8, 4))
        self._refresh_drive_menu()
        tk.Label(
            tree_wrap, text="Folders", bg=HEADER_BG, fg=TXT,
            font=("Segoe UI", 10, "bold"), anchor="w", padx=10, pady=6,
        ).pack(fill=tk.X)

        style = ttk.Style()
        style.configure("HandExplorer.Treeview", background=HEADER_BG, foreground=TXT, fieldbackground=HEADER_BG)
        style.map("HandExplorer.Treeview", background=[("selected", HOVER_BG)], foreground=[("selected", TXT)])
        self._tree = ttk.Treeview(tree_wrap, show="tree", selectmode="browse", style="HandExplorer.Treeview")
        self._tree.pack(side=tk.LEFT, fill=tk.BOTH, expand=True, padx=(8, 0), pady=(0, 8))
        tree_scroll = tk.Scrollbar(tree_wrap, orient=tk.VERTICAL, command=self._tree.yview)
        tree_scroll.pack(side=tk.RIGHT, fill=tk.Y, padx=(0, 6), pady=(0, 8))
        self._tree.configure(yscrollcommand=tree_scroll.set)
        self._tree.bind("<<TreeviewOpen>>", self._on_tree_open)
        self._tree.bind("<<TreeviewSelect>>", self._on_tree_select)

        grid_wrap = tk.Frame(body, bg=BG)
        grid_wrap.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)

        # Scrollable file-grid canvas
        self._cv = tk.Canvas(
            grid_wrap, bg=BG, highlightthickness=0,
            width=WIN_W - TREE_W, height=WIN_H - HEADER_H,
        )
        self._cv.pack(fill=tk.BOTH, expand=True)
        self._cv.bind("<Motion>", self._on_mouse_move)
        self._cv.bind("<Button-1>", self._on_mouse_click)

        # Pointer items drawn on the grid canvas (raised above file items)
        self._ptr_ring = self._cv.create_oval(
            -50, -50, -20, -20, outline=RED, width=3, fill="", tags="ptr"
        )
        self._ptr_dot = self._cv.create_oval(
            -50, -50, -44, -44, fill=RED, outline="", tags="ptr"
        )
        self._status_id = self._cv.create_text(
            24, 24, text="", anchor="nw", fill=TXT,
            font=("Segoe UI", 12, "bold"), tags="status"
        )

        # Camera preview widget — placed in bottom-right corner
        preview_frame = tk.Frame(self.root, bg=HEADER_BG, bd=1, relief="flat")
        preview_frame.place(relx=1.0, rely=1.0, x=-8, y=-(CAM_H + 18), anchor="se", width=PREVIEW_W, height=PREVIEW_H)

        preview_top = tk.Frame(preview_frame, bg=HEADER_BG)
        preview_top.pack(fill=tk.X)
        self._preview_title = tk.StringVar(value="No file selected")
        tk.Label(
            preview_top, textvariable=self._preview_title, bg=HEADER_BG, fg=TXT,
            font=("Segoe UI", 9, "bold"), anchor="w", padx=8,
        ).pack(side=tk.LEFT, fill=tk.X, expand=True)
        tk.Button(
            preview_top, text="Open File", command=self._open_selected_file,
            bg=SEL_BG, fg=TXT_SEL, activebackground=SEL_BG, activeforeground=TXT_SEL,
            relief="flat", bd=0, font=("Segoe UI", 9, "bold"), padx=10, pady=3,
        ).pack(side=tk.RIGHT, padx=6, pady=5)

        self._preview_img_lbl = tk.Label(preview_frame, bg=BG)
        self._preview_txt = tk.Text(
            preview_frame, bg=BG, fg=TXT, insertbackground=TXT, relief="flat",
            bd=0, wrap=tk.WORD, font=("Consolas", 9), padx=8, pady=6,
        )
        self._preview_txt.configure(state=tk.DISABLED)
        self._preview_txt.pack(fill=tk.BOTH, expand=True)

        self._cam_lbl = tk.Label(self.root, bg="#000000", bd=2, relief="flat")
        self._cam_lbl.place(relx=1.0, rely=1.0, x=-8, y=-8, anchor="se")
        self._populate_tree_roots()

    # ── Directory loading ───────────────────────────────────────────────────

    def load_dir(self, path, keep_view=False):
        path = os.path.abspath(path)
        self._load_req_id += 1
        req_id = self._load_req_id
        show_hidden = bool(self._show_hidden_var.get())

        self._status_text = f"Loading {path}..."
        self._status_until = time.time() + 2.0

        def worker():
            try:
                dirs, files = list_dir_entries(path, show_hidden)
                err = ""
            except OSError as exc:
                dirs = []
                files = []
                err = str(exc)

            self.root.after(0, lambda: self._finish_load_dir(req_id, path, dirs, files, err, keep_view))

        threading.Thread(target=worker, daemon=True).start()

    def _finish_load_dir(self, req_id, path, dirs, files, err, keep_view=False):
        if req_id != self._load_req_id:
            return

        if err:
            self._status_text = f"Cannot open folder: {err}"
            self._status_until = time.time() + RESET_STATUS_TIME
            return

        if keep_view and os.path.abspath(path) == os.path.abspath(self.path):
            self._relist_in_place(path, dirs, files)
            return

        self.path = path
        self.hover_i = -1
        self.sel_i = -1
        self._hover_since = 0.0
        self._previewed_hover_i = -1
        self._preview_path = None
        self._set_preview_text("No file selected", "Point at a file and select it to preview it here.")
        self._scroll_px = 0.0
        self._scroll_vel = 0.0
        self._path_var.set(path)

        parent = os.path.dirname(path)
        self.entries = []
        if parent != path:
            self.entries.append(("..", None))
        self.entries += [(n, os.path.join(path, n)) for n in dirs + files]

        self._draw_grid()
        self._sync_tree_selection(path)

    def _toggle_show_hidden(self):
        self.load_dir(self.path, keep_view=True)
        self._refresh_tree_children()
        self._status_text = "Showing hidden files" if self._show_hidden_var.get() else "Hiding hidden files"
        self._status_until = time.time() + RESET_STATUS_TIME

    def _relist_in_place(self, path, dirs, files):
        """Swap in a new listing of the *current* folder (hidden-files toggle)
        while keeping the selected item, the preview and the scroll position
        where they still make sense."""
        def path_at(i):
            return self.entries[i][1] if 0 <= i < len(self.entries) else None

        sel_path = path_at(self.sel_i)
        hover_path = path_at(self.hover_i)

        parent = os.path.dirname(path)
        self.entries = []
        if parent != path:
            self.entries.append(("..", None))
        self.entries += [(n, os.path.join(path, n)) for n in dirs + files]
        paths = [fp for _n, fp in self.entries]

        def index_of(fp):
            if fp is None:
                return -1
            try:
                return paths.index(fp)
            except ValueError:
                return -1

        self.sel_i = index_of(sel_path)
        self.hover_i = index_of(hover_path)
        self._previewed_hover_i = -1
        if self._preview_path and self._preview_path not in paths:
            self._preview_path = None
            self._set_preview_text("No file selected", "Point at a file and select it to preview it here.")

        cols = self._grid_cols()
        rows = math.ceil(len(self.entries) / cols) if self.entries else 1
        total_h = rows * (ITEM_H + ITEM_PAD) + ITEM_PAD
        self._scroll_vel = 0.0
        self._scroll_px = max(0.0, min(self._scroll_px, float(total_h - self._canvas_height())))
        self._draw_grid()
        self._cv.yview_moveto(self._scroll_px / self._total_h if self._total_h > 0 else 0)

    def _refresh_tree_children(self):
        """Re-list already-expanded folders in the tree so it follows the
        hidden-files setting too."""
        def walk(node):
            for child in self._tree.get_children(node):
                if child.endswith("|dummy"):
                    continue
                if self._tree.get_children(child):
                    walk(child)
            if node and os.path.isdir(node) and any(
                not c.endswith("|dummy") for c in self._tree.get_children(node)
            ):
                self._load_tree_children(node, prune=True)

        self._tree_loading = True
        try:
            walk("")
        finally:
            self._tree_loading = False
        self._sync_tree_selection(self.path)

    def _refresh_drive_menu(self):
        self._drive_menu.delete(0, tk.END)
        drives = self._list_drives()
        if not drives:
            self._drive_menu.add_command(label="No drives found")
            return
        for drive in drives:
            self._drive_menu.add_command(
                label=drive,
                command=lambda d=drive: self.load_dir(d),
            )

    def _list_drives(self):
        return [f"{letter}:\\" for letter in "ABCDEFGHIJKLMNOPQRSTUVWXYZ" if os.path.exists(f"{letter}:\\")]

    def _populate_tree_roots(self):
        self._tree.delete(*self._tree.get_children(""))
        for drive in self._list_drives():
            self._tree.insert("", tk.END, iid=drive, text=drive, open=False, values=(drive,))
            self._add_tree_dummy(drive)

    def _add_tree_dummy(self, path):
        dummy = f"{path}|dummy"
        if not self._tree.exists(dummy):
            self._tree.insert(path, tk.END, iid=dummy, text="", values=("dummy",))

    def _on_tree_open(self, _event=None):
        node = self._tree.focus()
        if node:
            self._load_tree_children(node)

    def _on_tree_select(self, _event=None):
        if self._tree_loading:
            return
        sel = self._tree.selection()
        if not sel:
            return
        path = sel[0]
        if os.path.isdir(path) and os.path.abspath(path) != os.path.abspath(self.path):
            self.load_dir(path)

    def _load_tree_children(self, path, prune=False):
        if not os.path.isdir(path):
            return
        if not self._tree.exists(path):
            # Under a hidden ancestor (e.g. AppData) while hidden files are
            # off: that branch isn't in the tree, so there's nothing to fill.
            return
        for child in self._tree.get_children(path):
            if child.endswith("|dummy"):
                self._tree.delete(child)
        existing = set(self._tree.get_children(path))
        try:
            dir_names, _files = list_dir_entries(path, bool(self._show_hidden_var.get()))
        except OSError:
            return
        dirs = [os.path.join(path, name) for name in dir_names]
        if prune:
            # Hidden-files toggle turned off: drop tree nodes that are now hidden.
            keep = set(dirs)
            for child in existing - keep:
                self._tree.delete(child)
            existing &= keep
        for index, dpath in enumerate(dirs):
            if dpath in existing:
                continue
            self._tree.insert(path, index, iid=dpath, text=os.path.basename(dpath) or dpath, open=False, values=(dpath,))
            self._add_tree_dummy(dpath)

    def _sync_tree_selection(self, path):
        if not hasattr(self, "_tree"):
            return
        self._ensure_tree_path(path)
        if not self._tree.exists(path):
            return
        self._tree_loading = True
        try:
            self._tree.selection_set(path)
            self._tree.see(path)
        finally:
            self._tree_loading = False

    def _ensure_tree_path(self, path):
        drive, _tail = os.path.splitdrive(os.path.abspath(path))
        root = drive + "\\"
        if not self._tree.exists(root):
            return
        parts = []
        cur = os.path.abspath(path)
        while cur and cur != root and not self._tree.exists(cur):
            parts.append(cur)
            parent = os.path.dirname(cur)
            if parent == cur:
                break
            cur = parent
        parent = root
        self._load_tree_children(root)
        for item in reversed(parts):
            if not self._tree.exists(item):
                self._load_tree_children(parent)
            parent = item

    # ── Grid drawing ────────────────────────────────────────────────────────

    def _draw_grid(self):
        self._cv.delete("grid")
        cols = self._grid_cols()
        rows = math.ceil(len(self.entries) / cols) if self.entries else 1
        self._total_h = rows * (ITEM_H + ITEM_PAD) + ITEM_PAD
        self._cv.config(scrollregion=(0, 0, self._grid_width(), self._total_h))

        # Virtualize drawing to visible rows so large folders don't freeze Tk.
        row_h = ITEM_H + ITEM_PAD
        first_row = max(0, int(self._scroll_px // row_h) - 1)
        visible_rows = int(math.ceil(self._canvas_height() / row_h)) + 3
        last_row = min(rows, first_row + visible_rows)

        start_i = first_row * cols
        end_i = min(len(self.entries), last_row * cols)
        for i in range(start_i, end_i):
            name, fpath = self.entries[i]
            self._draw_item(i, name, fpath)

        self._last_visible_row = first_row

        self._cv.tag_raise("ptr")

    def _draw_item(self, i, name, fpath):
        tag = f"item{i}"
        self._cv.delete(tag)

        cols = self._grid_cols()
        col = i % cols
        row = i // cols
        x   = ITEM_PAD + col * (ITEM_W + ITEM_PAD)
        y   = ITEM_PAD + row * (ITEM_H + ITEM_PAD)

        is_hover = (i == self.hover_i)
        is_sel   = (i == self.sel_i)
        bg = SEL_BG  if is_sel   else (HOVER_BG if is_hover else SURFACE)
        fg = TXT_SEL if is_sel   else TXT

        colour, emoji = item_style(fpath)
        if is_sel:
            colour = TXT_SEL

        self._cv.create_rectangle(
            x, y, x + ITEM_W, y + ITEM_H,
            fill=bg, outline="", tags=("grid", tag),
        )
        self._cv.create_text(
            x + ITEM_W // 2, y + 48,
            text=emoji, font=("Segoe UI Emoji", 40),
            fill=colour, tags=("grid", tag),
        )
        display = name if len(name) <= 15 else name[:14] + "…"
        self._cv.create_text(
            x + ITEM_W // 2, y + ITEM_H - 16,
            text=display, font=("Segoe UI", 8),
            fill=fg, width=ITEM_W - 8, tags=("grid", tag),
        )

    # ── Main tick ───────────────────────────────────────────────────────────

    def _tick(self):
        frame, raw_frame, wire_frame, hands = self._tracker.latest()
        now = time.time()

        if self._tracker.init_done and not self._tracker_state_announced:
            self._tracker_state_announced = True
            if self._tracker.is_available:
                self._status_text = "Camera connected. Hand controls active."
                self._status_until = now + 3.0
            else:
                err = self._tracker.init_error or "in use by another app"
                self._status_text = f"Camera unavailable ({err}). Hand controls disabled."
                self._status_until = now + 10.0

        if self._tracker.init_error and self._tracker.init_error != self._last_tracker_error:
            self._last_tracker_error = self._tracker.init_error
            self._status_text = self._tracker.init_error
            self._status_until = now + 10.0

        self._profiler.add_frame(now, hands)
        self._tick_calibration_wizard(now)

        grid_width = self._grid_width()
        if grid_width != self._last_grid_width:
            self._last_grid_width = grid_width
            self._draw_grid()

        if frame is not None and now >= self._last_cam_ui_at + (1.0 / CAMERA_UI_FPS):
            self._last_cam_ui_at = now
            self._refresh_cam(frame, raw_frame, wire_frame)

        self._update_status()
        self._tick_hover_preview(now)

        if hands:
            pointer_hand, other_hands = self._split_hands(hands)
            if pointer_hand is not None:
                self._process_hand(pointer_hand["landmarks"])
                # Pointer hand owns back command regardless of transient handedness labels.
                self._try_back_swipe(pointer_hand)
            else:
                self._hide_pointer()
                self._back_hist.clear()

            # Command hand is any hand object that is not the selected pointer hand.
            # Do not filter by handedness label here because MediaPipe can momentarily
            # label both hands the same during motion.
            command_hands = list(other_hands)

            left_seen = False
            for hand in command_hands:
                left_seen = True
                lms = hand["landmarks"]
                self._try_left_select(lms, now)
                self._try_left_reset(lms, pointer_hand, now)
            if not left_seen:
                self._left_point_frames = 0
                self._reset_left_state()

            self._update_wire_action_status(now, pointer_hand, command_hands)
        else:
            self._wrist_hist.clear()
            self._back_hist.clear()
            self._left_point_frames = 0
            self._reset_left_state()
            self._hide_pointer()
            if now > self._wire_action_until:
                self._wire_action_var.set("Action: none")

        self._tick_scroll()
        self.root.after(33, self._tick)

    def _refresh_cam(self, frame, raw_frame=None, wire_frame=None):
        try:
            rgb   = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            img   = Image.fromarray(rgb).resize((CAM_W, CAM_H), Image.NEAREST)
            photo = ImageTk.PhotoImage(img)
            self._cam_lbl.configure(image=photo)
            self._cam_photo = photo            # prevent garbage collection

            if self._calib_cam_lbl is not None and self._calib_cam_lbl.winfo_exists() and raw_frame is not None:
                raw_rgb = cv2.cvtColor(raw_frame, cv2.COLOR_BGR2RGB)
                big_img = Image.fromarray(raw_rgb).resize((520, 300), Image.NEAREST)
                big_photo = ImageTk.PhotoImage(big_img)
                self._calib_cam_lbl.configure(image=big_photo)
                self._calib_photo = big_photo

            if self._calib_wire_lbl is not None and self._calib_wire_lbl.winfo_exists() and wire_frame is not None:
                wire_rgb = cv2.cvtColor(wire_frame, cv2.COLOR_BGR2RGB)
                wire_img = Image.fromarray(wire_rgb).resize((520, 300), Image.NEAREST)
                wire_photo = ImageTk.PhotoImage(wire_img)
                self._calib_wire_lbl.configure(image=wire_photo)
                self._calib_wire_photo = wire_photo
        except tk.TclError:
            # Widget may be destroyed during update; ignore and continue.
            pass

    def _update_status(self):
        if time.time() < self._status_until:
            self._cv.itemconfigure(self._status_id, text=self._status_text, fill=GREEN)
        else:
            self._cv.itemconfigure(self._status_id, text="")

    def _hide_pointer(self):
        self._cv.coords(self._ptr_ring, -100, -100, -70, -70)
        self._cv.coords(self._ptr_dot,  -100, -100, -94, -94)

    def _hover_index_from_canvas(self, cx, cy):
        cols = self._grid_cols()
        col = int((cx - ITEM_PAD) // (ITEM_W + ITEM_PAD))
        row = int((cy - ITEM_PAD) // (ITEM_H + ITEM_PAD))
        lx = (cx - ITEM_PAD) % (ITEM_W + ITEM_PAD)
        ly = (cy - ITEM_PAD) % (ITEM_H + ITEM_PAD)

        if 0 <= lx <= ITEM_W and 0 <= ly <= ITEM_H and 0 <= col < cols and row >= 0:
            idx = row * cols + col
            if idx < len(self.entries):
                return idx
        return -1

    def _set_hover(self, new_h):
        if new_h == self.hover_i:
            return
        old = self.hover_i
        self.hover_i = new_h
        self._hover_since = time.time()
        self._previewed_hover_i = -1
        if old >= 0:
            self._draw_item(old, *self.entries[old])
        if new_h >= 0:
            self._draw_item(new_h, *self.entries[new_h])
        self._cv.tag_raise("ptr")

    def _on_mouse_move(self, event):
        cx = self._cv.canvasx(event.x)
        cy = self._cv.canvasy(event.y)
        self._set_hover(self._hover_index_from_canvas(cx, cy))

    def _tick_hover_preview(self, now):
        if self.hover_i < 0 or self.hover_i >= len(self.entries):
            return
        if self.hover_i == self._previewed_hover_i:
            return
        if now - self._hover_since < HOVER_PREVIEW_SEC:
            return
        _, fpath = self.entries[self.hover_i]
        if not fpath or os.path.isdir(fpath):
            return
        self._previewed_hover_i = self.hover_i
        self._preview_file(fpath)

    def _on_mouse_click(self, event):
        cx = self._cv.canvasx(event.x)
        cy = self._cv.canvasy(event.y)
        idx = self._hover_index_from_canvas(cx, cy)
        self._set_selected(idx)
        self._activate(idx)

    # ── Hand processing ─────────────────────────────────────────────────────

    def _split_hands(self, hands):
        if not hands:
            return None, []

        labels = [hand["label"] for hand in hands]

        # Prefer the expected label, then keep continuity with the closest candidate.
        if PREFERRED_POINTER_LABEL in labels:
            self._primary_label = PREFERRED_POINTER_LABEL
        elif self._primary_label not in labels:
            closest = min(hands, key=lambda h: self._pointer_dist_to_cursor(h["landmarks"]))
            self._primary_label = closest["label"]

        candidates = [h for h in hands if h["label"] == self._primary_label]
        if candidates:
            pointer_hand = min(candidates, key=lambda h: self._pointer_dist_to_cursor(h["landmarks"]))
        else:
            pointer_hand = min(hands, key=lambda h: self._pointer_dist_to_cursor(h["landmarks"]))
            self._primary_label = pointer_hand["label"]

        other_hands = [hand for hand in hands if hand is not pointer_hand]
        return pointer_hand, other_hands

    def _pointer_dist_to_cursor(self, lms):
        root_w = float(max(1, self.root.winfo_width()))
        root_h = float(max(1, self.root.winfo_height()))
        pip, tip = lms[6], lms[8]
        proj_x = tip.x + PTR_RAY * (tip.x - pip.x)
        proj_y = tip.y + PTR_RAY * (tip.y - pip.y)
        raw_x = proj_x * root_w + self._pointer_offset_x
        raw_y = proj_y * root_h + self._pointer_offset_y
        raw_x = max(0.0, min(raw_x, root_w))
        raw_y = max(0.0, min(raw_y, root_h))
        return math.hypot(raw_x - self._sx, raw_y - self._sy)

    def _process_hand(self, lms):
        now = time.time()
        canvas_h = self._canvas_height()
        canvas_top = self._canvas_top()
        canvas_left = self._canvas_left()
        root_w = float(max(1, self.root.winfo_width()))
        root_h = float(max(1, self.root.winfo_height()))
        pointing_pose = self._is_pointing(lms)
        open_pose = self._is_open_hand(lms)

        if open_pose:
            self._wrist_hist.append((now, lms[0].y))
        else:
            self._wrist_hist.clear()

        if len(self._wrist_hist) >= 5 and now > self._last_swipe_at + SWIPE_COOLDOWN:
            t0, y0 = self._wrist_hist[0]
            t1, y1 = self._wrist_hist[-1]
            dt = t1 - t0
            if dt > 0:
                vy = (y1 - y0) / dt   # positive = hand moved down
                travel = abs(y1 - y0)
                if abs(vy) > self._gesture_cfg["swipe_vel"] and travel > self._gesture_cfg["swipe_travel"]:
                    self._last_swipe_at = now
                    self._scroll_vel = vy * SCROLL_SCALE
                    self._wrist_hist.clear()
                    self._set_wire_action("scroll_down" if vy > 0 else "scroll_up")
                    self._status_text = "Scroll"
                    self._status_until = now + 0.6

        # ── Pointer position — ray cast from PIP knuckle through fingertip ─
        # Only update when in pointing pose so an open/sweep hand doesn't thrash the cursor.
        pip, tip = lms[6], lms[8]
        dx = tip.x - pip.x
        dy = tip.y - pip.y
        proj_x = tip.x + PTR_RAY * dx
        proj_y = tip.y + PTR_RAY * dy
        raw_x = proj_x * root_w + self._pointer_offset_x
        raw_y = proj_y * root_h + self._pointer_offset_y
        raw_x = max(0.0, min(raw_x, root_w))
        raw_y = max(0.0, min(raw_y, root_h))

        if math.hypot(raw_x - self._sx, raw_y - self._sy) > PTR_DEADZONE_PX:
            self._sx += PTR_ALPHA * (raw_x - self._sx)
            self._sy += PTR_ALPHA * (raw_y - self._sy)

        sx, sy = self._sx, self._sy

        # Convert window coords → canvas coords (accounts for scroll offset)
        cx = self._cv.canvasx(sx - canvas_left)
        cy = self._cv.canvasy(sy - canvas_top)

        r, dr = 15, 3
        self._cv.coords(self._ptr_ring, cx - r,  cy - r,  cx + r,  cy + r)
        self._cv.coords(self._ptr_dot,  cx - dr, cy - dr, cx + dr, cy + dr)
        self._cv.tag_raise("ptr")

        # ── Hover detection ───────────────────────────────────────────────
        in_canvas = (canvas_left <= sx <= (canvas_left + self._grid_width())) and (canvas_top <= sy <= (canvas_top + canvas_h))
        if in_canvas and (pointing_pose or not open_pose):
            self._set_hover(self._hover_index_from_canvas(cx, cy))
        elif not in_canvas:
            self._set_hover(-1)

    def _is_pointing(self, lms):
        """Return True when index finger is extended and middle/ring/pinky are curled.
        Used by the other hand to trigger select."""
        states = self._finger_states(lms)
        index_extended = states["index"]
        curled_count = sum(not states[name] for name in ("middle", "ring", "pinky"))
        return index_extended and curled_count >= 2

    def _is_open_hand(self, lms):
        """Return True when at least 3 of 4 fingers (index/middle/ring/pinky) are extended.
        Used by the pointer hand to detect a sweep/scroll gesture."""
        states = self._finger_states(lms)
        extended = sum(states[name] for name in ("index", "middle", "ring", "pinky"))
        return extended >= OPEN_MIN_EXTENDED

    def _finger_states(self, lms):
        """Orientation-robust extended/curl state based on wrist-relative distances."""
        wrist = lms[0]
        hand_size = math.hypot(lms[9].x - wrist.x, lms[9].y - wrist.y) or 0.001
        margin = 0.08 * hand_size

        def is_extended(tip_id, pip_id):
            tip_d = math.hypot(lms[tip_id].x - wrist.x, lms[tip_id].y - wrist.y)
            pip_d = math.hypot(lms[pip_id].x - wrist.x, lms[pip_id].y - wrist.y)
            return tip_d > pip_d + margin

        return {
            "index": is_extended(8, 6),
            "middle": is_extended(12, 10),
            "ring": is_extended(16, 14),
            "pinky": is_extended(20, 18),
        }

    def _go_back(self):
        parent = os.path.dirname(self.path)
        if parent != self.path:
            self.load_dir(parent)

    def _try_back_swipe(self, hand):
        now = time.time()
        lms = hand["landmarks"]

        if now <= self._last_back_at + BACK_COOLDOWN:
            return False

        # Always record wrist position — don't gate on open hand here because
        # a single non-open frame during the swipe would wipe the history.
        self._back_hist.append((now, lms[0].x, lms[0].y))
        if len(self._back_hist) < 5:
            return False

        t0, x0, y0 = self._back_hist[0]
        t1, x1, y1 = self._back_hist[-1]
        dt = t1 - t0
        if dt <= 0:
            return False

        vx = (x1 - x0) / dt
        vy = (y1 - y0) / dt
        travel_x = abs(x1 - x0)

        if not self._is_open_hand(lms):
            return False
        if abs(vx) < self._gesture_cfg["back_swipe_vel"]:
            return False
        if travel_x < self._gesture_cfg["back_swipe_travel"]:
            return False
        # Horizontal motion must dominate vertical to avoid triggering during scroll.
        if abs(vx) < abs(vy) * self._gesture_cfg["back_dir_dominance"]:
            return False

        self._last_back_at = now
        self._back_hist.clear()
        self._go_back()
        self._set_wire_action("back_swipe")
        self._status_text = "Back"
        self._status_until = now + 0.7
        return True

    def _try_left_select(self, lms, now):
        if self._is_pointing(lms):
            self._left_point_frames += 1
        else:
            self._left_point_frames = 0
            return False

        if self._left_point_frames < self._gesture_cfg["select_hold_frames"]:
            return False
        if now <= self._select_until:
            return False

        self._select_until = now + SELECT_COOLDOWN
        self._activate_current_target()
        self._set_wire_action("select")
        self._status_text = "Select"
        self._status_until = now + 0.6
        return True

    def _activate_current_target(self):
        if 0 <= self.hover_i < len(self.entries):
            self._activate(self.hover_i)
            return True
        return self._invoke_widget_at_pointer()

    def _invoke_widget_at_pointer(self):
        sx = int(self.root.winfo_rootx() + self._sx)
        sy = int(self.root.winfo_rooty() + self._sy)
        widget = self.root.winfo_containing(sx, sy)
        if widget is None:
            return False

        # Walk up the widget hierarchy to find something invokable.
        cur = widget
        while cur is not None:
            if cur is self._cv:
                return False

            invoke = getattr(cur, "invoke", None)
            if callable(invoke):
                state = str(cur.cget("state")) if "state" in cur.keys() else "normal"
                if state != "disabled":
                    try:
                        invoke()
                        return True
                    except tk.TclError:
                        return False

            parent_name = cur.winfo_parent()
            if not parent_name:
                break
            try:
                cur = cur.nametowidget(parent_name)
            except KeyError:
                break

        return False

    def _try_left_reset(self, lms, pointer_hand, now):
        if pointer_hand is None:
            return False

        if now <= self._last_reset_at + RESET_COOLDOWN:
            self._reset_left_state()
            return False

        if not self._reset_active:
            # Phase 1: wait for the user to hold an open hand for a few frames.
            if not self._is_open_hand(lms):
                self._reset_pose_frames = 0
                return False
            self._reset_pose_frames += 1
            if self._reset_pose_frames < RESET_HOLD_FRAMES:
                return False
            # Hold frames met — lock in the sweep start position.
            self._reset_active = True
            self._reset_start_x = lms[0].x
            self._reset_start_t = now
            return False

        # Phase 2: active sweep — do NOT re-check open hand here so a single
        # MediaPipe wobble during the swipe doesn't kill the gesture.
        if now - self._reset_start_t > self._gesture_cfg["reset_wave_window"]:
            # Took too long — give up and let the user try again.
            self._reset_left_state()
            return False

        travel = abs(lms[0].x - self._reset_start_x)
        dt = now - self._reset_start_t
        if dt < 0.08 or travel < self._gesture_cfg["reset_wave_travel"]:
            return False

        self._last_reset_at = now
        self._reset_left_state()
        self._center_pointer(pointer_hand["landmarks"])
        self._status_text = "Pointer centered"
        self._status_until = now + RESET_STATUS_TIME
        self._set_wire_action("reset_pointer")
        return True

    def _set_wire_action(self, action_name, hold_sec=1.0):
        self._wire_action_var.set(f"Action: {action_name}")
        self._wire_action_until = time.time() + hold_sec

    def _update_wire_action_status(self, now, pointer_hand, command_hands):
        # Keep explicit trigger text visible briefly, then fall back to pose hints.
        if now <= self._wire_action_until:
            return

        for hand in command_hands:
            lms = hand["landmarks"]
            if self._is_pointing(lms):
                self._wire_action_var.set("Action: select (pose)")
                return
            if self._is_open_hand(lms):
                self._wire_action_var.set("Action: reset_pointer (pose)")
                return

        if pointer_hand is not None:
            self._wire_action_var.set("Action: pointer_tracking")
        else:
            self._wire_action_var.set("Action: none")

    def _reset_left_state(self):
        self._reset_pose_frames = 0
        self._reset_active = False
        self._reset_start_x = 0.0
        self._reset_start_t = 0.0

    def _center_pointer(self, lms):
        root_w = float(max(1, self.root.winfo_width()))
        root_h = float(max(1, self.root.winfo_height()))
        canvas_h = self._canvas_height()
        canvas_top = self._canvas_top()
        pip, tip = lms[6], lms[8]
        proj_x = tip.x + PTR_RAY * (tip.x - pip.x)
        proj_y = tip.y + PTR_RAY * (tip.y - pip.y)
        base_x = proj_x * root_w
        base_y = proj_y * root_h
        target_x = self._canvas_left() + self._grid_width() / 2.0
        target_y = canvas_top + canvas_h / 2.0
        self._pointer_offset_x = target_x - base_x
        self._pointer_offset_y = target_y - base_y
        self._sx = target_x
        self._sy = target_y

    def _grid_width(self):
        width = self._cv.winfo_width()
        return width if width > 1 else WIN_W

    def _canvas_height(self):
        height = self._cv.winfo_height()
        return height if height > 1 else WIN_H - HEADER_H

    def _canvas_top(self):
        return float(self._cv.winfo_rooty() - self.root.winfo_rooty())

    def _canvas_left(self):
        return float(self._cv.winfo_rootx() - self.root.winfo_rootx())

    def _grid_cols(self):
        return max(1, (self._grid_width() - ITEM_PAD) // (ITEM_W + ITEM_PAD))

    def _set_preview_text(self, title, body):
        self._preview_photo = None
        self._preview_img_lbl.pack_forget()
        self._preview_txt.pack(fill=tk.BOTH, expand=True)
        self._preview_title.set(title)
        self._preview_txt.configure(state=tk.NORMAL)
        self._preview_txt.delete("1.0", tk.END)
        self._preview_txt.insert("1.0", body)
        self._preview_txt.configure(state=tk.DISABLED)

    def _preview_file(self, path):
        self._preview_path = path
        name = os.path.basename(path)
        ext = os.path.splitext(path)[1].lower()
        image_exts = {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".ico"}
        text_exts = {
            ".txt", ".md", ".py", ".js", ".ts", ".json", ".jsonl", ".csv", ".tsv",
            ".html", ".css", ".xml", ".yml", ".yaml", ".ini", ".cfg", ".log",
        }

        if ext in image_exts:
            try:
                img = Image.open(path)
                img.thumbnail((PREVIEW_W - 20, PREVIEW_H - 48))
                self._preview_photo = ImageTk.PhotoImage(img)
                self._preview_txt.pack_forget()
                self._preview_img_lbl.configure(image=self._preview_photo, text="")
                self._preview_img_lbl.pack(fill=tk.BOTH, expand=True, padx=8, pady=(0, 8))
                self._preview_title.set(name)
                return
            except OSError as exc:
                self._set_preview_text(name, f"Could not preview image:\n{exc}")
                return

        if ext in text_exts:
            try:
                with open(path, "r", encoding="utf-8", errors="replace") as f:
                    text = f.read(12000)
                if os.path.getsize(path) > 12000:
                    text += "\n\n... preview truncated ..."
                self._set_preview_text(name, text or "(empty file)")
                return
            except OSError as exc:
                self._set_preview_text(name, f"Could not preview file:\n{exc}")
                return

        try:
            size = os.path.getsize(path)
            modified = datetime.fromtimestamp(os.path.getmtime(path)).strftime("%Y-%m-%d %H:%M:%S")
            self._set_preview_text(name, f"Preview is not available for this file type.\n\nPath: {path}\nSize: {size:,} bytes\nModified: {modified}")
        except OSError as exc:
            self._set_preview_text(name, f"Could not read file info:\n{exc}")

    def _open_selected_file(self):
        target = self._preview_path
        if not target:
            target = self._target_path()
        if not target or os.path.isdir(target):
            messagebox.showinfo("Open File", "Select a file first.")
            return
        try:
            os.startfile(target)
        except OSError as exc:
            messagebox.showerror("Open File", str(exc))

    def _activate(self, idx):
        if idx < 0 or idx >= len(self.entries):
            return
        self._set_selected(idx)
        name, fpath = self.entries[idx]
        if fpath is None:
            self.load_dir(os.path.dirname(self.path))
        elif os.path.isdir(fpath):
            self.load_dir(fpath)
        else:
            self._preview_file(fpath)

    def _set_selected(self, idx):
        if idx == self.sel_i:
            return
        old = self.sel_i
        self.sel_i = idx
        if old >= 0 and old < len(self.entries):
            self._draw_item(old, *self.entries[old])
        if idx >= 0 and idx < len(self.entries):
            self._draw_item(idx, *self.entries[idx])
        self._cv.tag_raise("ptr")

    def _target_index(self):
        if 0 <= self.sel_i < len(self.entries):
            return self.sel_i
        if 0 <= self.hover_i < len(self.entries):
            return self.hover_i
        return -1

    def _target_path(self):
        idx = self._target_index()
        if idx < 0:
            return None
        _, fpath = self.entries[idx]
        return fpath

    def _unique_path(self, base_path):
        if not os.path.exists(base_path):
            return base_path
        root, ext = os.path.splitext(base_path)
        n = 1
        while True:
            candidate = f"{root} ({n}){ext}"
            if not os.path.exists(candidate):
                return candidate
            n += 1

    def _create_new_file(self):
        name = simpledialog.askstring("New File", "Enter file name:", parent=self.root)
        if not name:
            return
        new_path = os.path.join(self.path, name)
        if os.path.exists(new_path):
            messagebox.showerror("Create File", "File already exists.")
            return
        try:
            with open(new_path, "w", encoding="utf-8"):
                pass
            self.load_dir(self.path)
            self._status_text = "Created file"
            self._status_until = time.time() + RESET_STATUS_TIME
        except OSError as exc:
            messagebox.showerror("Create File", str(exc))

    def _create_new_folder(self):
        name = simpledialog.askstring("New Folder", "Enter folder name:", parent=self.root)
        if not name:
            return
        new_path = os.path.join(self.path, name)
        if os.path.exists(new_path):
            messagebox.showerror("Create Folder", "Folder already exists.")
            return
        try:
            os.makedirs(new_path)
            self.load_dir(self.path)
            self._status_text = "Created folder"
            self._status_until = time.time() + RESET_STATUS_TIME
        except OSError as exc:
            messagebox.showerror("Create Folder", str(exc))

    def _delete_selected(self):
        target = self._target_path()
        if not target:
            messagebox.showinfo("Delete", "Select an item first.")
            return
        if not messagebox.askyesno("Delete", f"Delete '{os.path.basename(target)}'?", parent=self.root):
            return
        try:
            if os.path.isdir(target):
                shutil.rmtree(target)
            else:
                os.remove(target)
            self.load_dir(self.path)
            self._status_text = "Deleted"
            self._status_until = time.time() + RESET_STATUS_TIME
        except OSError as exc:
            messagebox.showerror("Delete", str(exc))

    def _copy_selected(self):
        target = self._target_path()
        if not target:
            messagebox.showinfo("Copy", "Select an item first.")
            return
        self._clipboard_path = target
        self._clipboard_mode = "copy"
        self._status_text = "Copied"
        self._status_until = time.time() + RESET_STATUS_TIME

    def _cut_selected(self):
        target = self._target_path()
        if not target:
            messagebox.showinfo("Cut", "Select an item first.")
            return
        self._clipboard_path = target
        self._clipboard_mode = "cut"
        self._status_text = "Cut"
        self._status_until = time.time() + RESET_STATUS_TIME

    def _paste_into_current(self):
        if not self._clipboard_path or not self._clipboard_mode:
            messagebox.showinfo("Paste", "Clipboard is empty.")
            return
        src = self._clipboard_path
        if not os.path.exists(src):
            messagebox.showerror("Paste", "Source path no longer exists.")
            self._clipboard_path = None
            self._clipboard_mode = None
            return

        dst = self._unique_path(os.path.join(self.path, os.path.basename(src)))
        try:
            if self._clipboard_mode == "copy":
                if os.path.isdir(src):
                    shutil.copytree(src, dst)
                else:
                    shutil.copy2(src, dst)
            else:
                shutil.move(src, dst)
                self._clipboard_path = None
                self._clipboard_mode = None

            self.load_dir(self.path)
            self._status_text = "Pasted"
            self._status_until = time.time() + RESET_STATUS_TIME
        except OSError as exc:
            messagebox.showerror("Paste", str(exc))

    def _open_calibration_wizard(self):
        if self._calib_win is not None and self._calib_win.winfo_exists():
            self._calib_win.deiconify()
            self._calib_win.lift()
            return

        win = tk.Toplevel(self.root)
        win.title("Gesture Calibration Wizard")
        win.configure(bg=HEADER_BG)
        win.geometry("760x560")
        win.minsize(720, 520)
        self._calib_win = win

        instructions = (
            "1) Choose an action\n"
            "2) Click Start Recording\n"
            "3) Wait for countdown\n"
            "4) Perform the action naturally until recording ends"
        )
        tk.Label(
            win,
            text=instructions,
            justify="left",
            bg=HEADER_BG,
            fg=TXT,
            font=("Segoe UI", 10),
            padx=10,
            pady=8,
        ).pack(fill=tk.X)

        row = tk.Frame(win, bg=HEADER_BG)
        row.pack(fill=tk.X, padx=10, pady=(0, 8))

        tk.Label(row, text="Action:", bg=HEADER_BG, fg=TXT, font=("Segoe UI", 10)).pack(side=tk.LEFT)
        action_menu = tk.OptionMenu(row, self._calib_action_var, *CALIB_ACTIONS)
        action_menu.configure(bg=SURFACE, fg=TXT, activebackground=HOVER_BG, activeforeground=TXT, relief="flat", highlightthickness=0)
        action_menu["menu"].configure(bg=SURFACE, fg=TXT)
        action_menu.pack(side=tk.LEFT, padx=8)

        self._calib_record_btn = tk.Button(
            row,
            text="Start Recording",
            command=self._start_calibration_recording,
            bg=SEL_BG,
            fg=TXT_SEL,
            activebackground=SEL_BG,
            activeforeground=TXT_SEL,
            relief="flat",
            bd=0,
            padx=12,
            pady=4,
            font=("Segoe UI", 10, "bold"),
        )
        self._calib_record_btn.pack(side=tk.LEFT, padx=6)

        tk.Button(
            row,
            text="Cancel",
            command=self._cancel_calibration_recording,
            bg=SURFACE,
            fg=TXT,
            activebackground=HOVER_BG,
            activeforeground=TXT,
            relief="flat",
            bd=0,
            padx=10,
            pady=4,
            font=("Segoe UI", 10),
        ).pack(side=tk.LEFT, padx=4)

        tk.Label(
            win,
            textvariable=self._calib_status_var,
            bg=HEADER_BG,
            fg=GREEN,
            font=("Segoe UI", 10, "bold"),
            anchor="w",
            padx=10,
        ).pack(fill=tk.X, pady=(0, 8))

        preview_wrap = tk.Frame(win, bg=HEADER_BG)
        preview_wrap.pack(fill=tk.BOTH, expand=True, padx=10, pady=(0, 10))

        left = tk.Frame(preview_wrap, bg=HEADER_BG)
        left.pack(side=tk.LEFT, fill=tk.BOTH, expand=True, padx=(0, 6))
        tk.Label(left, text="Camera", bg=HEADER_BG, fg=TXT, font=("Segoe UI", 10, "bold")).pack(anchor="w", pady=(0, 4))
        self._calib_cam_lbl = tk.Label(left, bg="#000000", bd=2, relief="flat")
        self._calib_cam_lbl.pack(fill=tk.BOTH, expand=True)

        right = tk.Frame(preview_wrap, bg=HEADER_BG)
        right.pack(side=tk.LEFT, fill=tk.BOTH, expand=True, padx=(6, 0))
        tk.Label(right, text="Wireframe (Black BG)", bg=HEADER_BG, fg=TXT, font=("Segoe UI", 10, "bold")).pack(anchor="w", pady=(0, 4))
        tk.Label(
            right,
            textvariable=self._wire_action_var,
            bg=GREEN,
            fg=TXT_SEL,
            font=("Segoe UI", 10, "bold"),
            anchor="w",
            padx=8,
            pady=4,
        ).pack(fill=tk.X, pady=(0, 6))
        self._calib_wire_lbl = tk.Label(right, bg="#000000", bd=2, relief="flat")
        self._calib_wire_lbl.pack(fill=tk.BOTH, expand=True)
        self._calib_status_var.set("Ready. Choose an action and click Start Recording.")

        def on_close():
            self._cancel_calibration_recording()
            self._calib_cam_lbl = None
            self._calib_wire_lbl = None
            self._calib_photo = None
            self._calib_wire_photo = None
            self._calib_win.destroy()
            self._calib_win = None

        win.protocol("WM_DELETE_WINDOW", on_close)

    def _start_calibration_recording(self):
        if self._profiler.is_active:
            self._calib_status_var.set("A recording is already active.")
            return

        action = self._calib_action_var.get().strip()
        if not action:
            self._calib_status_var.set("Choose an action first.")
            return

        now = time.time()
        self._calib_pending_action = action
        self._calib_countdown_until = now + CALIB_COUNTDOWN_SEC
        self._calib_record_until = 0.0
        if self._calib_record_btn is not None:
            self._calib_record_btn.configure(state="disabled")
        self._calib_status_var.set(f"Get ready: recording {action} in {CALIB_COUNTDOWN_SEC}...")

    def _cancel_calibration_recording(self):
        self._calib_countdown_until = 0.0
        self._calib_record_until = 0.0
        self._calib_pending_action = ""
        if self._profiler.is_active:
            self._profiler.stop()
        if self._calib_record_btn is not None and self._calib_record_btn.winfo_exists():
            self._calib_record_btn.configure(state="normal")
        if self._calib_win is not None and self._calib_win.winfo_exists():
            self._calib_status_var.set("Recording canceled. Ready.")

    def _tick_calibration_wizard(self, now):
        if self._calib_win is None or not self._calib_win.winfo_exists():
            return

        if self._calib_countdown_until > 0.0:
            remaining = int(math.ceil(self._calib_countdown_until - now))
            if remaining > 0:
                self._calib_status_var.set(f"Starting in {remaining}...")
                return

            action = self._calib_pending_action
            ok, data = self._profiler.start(action, PREFERRED_POINTER_LABEL)
            if not ok:
                self._calib_status_var.set(f"Could not start recording: {data}")
                self._calib_countdown_until = 0.0
                self._calib_pending_action = ""
                if self._calib_record_btn is not None and self._calib_record_btn.winfo_exists():
                    self._calib_record_btn.configure(state="normal")
                return

            self._calib_countdown_until = 0.0
            self._calib_record_until = now + CALIB_RECORD_SEC
            self._status_text = f"Recording: {action}"
            self._status_until = now + CALIB_RECORD_SEC
            self._calib_status_var.set(f"Recording {action}... {CALIB_RECORD_SEC}s")
            return

        if self._calib_record_until > 0.0 and self._profiler.is_active:
            remaining = self._calib_record_until - now
            if remaining > 0:
                self._calib_status_var.set(f"Recording {self._profiler.gesture}... {remaining:.1f}s")
                return

            ok, data = self._profiler.stop()
            self._calib_record_until = 0.0
            self._calib_pending_action = ""
            if self._calib_record_btn is not None and self._calib_record_btn.winfo_exists():
                self._calib_record_btn.configure(state="normal")

            if ok:
                self._profiler.build_profiles()
                self._load_and_apply_profiles(silent=False)
                self._calib_status_var.set(
                    f"Saved {data['gesture']} | {data['frames']} frames @ {data['fps']:.1f} fps"
                )
                self._status_text = "Calibration sample saved"
                self._status_until = now + RESET_STATUS_TIME
                messagebox.showinfo(
                    "Motion Saved",
                    f"Saved: {data['gesture']}\nFrames: {data['frames']}\nThis sample has been applied to live gesture tuning.",
                    parent=self._calib_win,
                )
            else:
                self._calib_status_var.set(f"Failed to save recording: {data}")

    def _build_gesture_profiles(self):
        ok, data = self._profiler.build_profiles()
        if not ok:
            messagebox.showinfo("Build Profiles", data)
            return
        self._load_and_apply_profiles(silent=False)
        self._status_text = "Profiles built"
        self._status_until = time.time() + RESET_STATUS_TIME
        messagebox.showinfo("Build Profiles", f"Profiles saved to:\n{data}")

    def _clamp(self, val, lo, hi):
        return max(lo, min(hi, float(val)))

    def _blend(self, base, learned, alpha=0.25):
        return (1.0 - alpha) * float(base) + alpha * float(learned)

    def _load_and_apply_profiles(self, silent=False):
        path = os.path.join(PROFILE_DIR, "profiles.json")
        if not os.path.exists(path):
            return False

        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, json.JSONDecodeError):
            return False

        gestures = data.get("gestures", {})
        changed = []
        min_samples = 2

        default_cfg = {
            "select_hold_frames": SELECT_HOLD_FRAMES,
            "swipe_vel": SWIPE_VEL,
            "swipe_travel": SWIPE_TRAVEL,
            "back_swipe_vel": BACK_SWIPE_VEL,
            "back_swipe_travel": BACK_SWIPE_TRAVEL,
            "back_dir_dominance": BACK_DIR_DOMINANCE,
            "reset_wave_travel": RESET_WAVE_TRAVEL,
            "reset_wave_window": RESET_WAVE_WINDOW,
        }

        back = gestures.get("back_swipe")
        if back and int(back.get("samples", 0)) >= min_samples:
            learned_v = self._clamp(back.get("avg_speed", default_cfg["back_swipe_vel"]), 0.35, 0.85)
            learned_tx = self._clamp(back.get("avg_path_x", default_cfg["back_swipe_travel"]) * 0.20, 0.04, 0.10)
            self._gesture_cfg["back_swipe_vel"] = self._blend(default_cfg["back_swipe_vel"], learned_v, alpha=0.25)
            self._gesture_cfg["back_swipe_travel"] = self._blend(default_cfg["back_swipe_travel"], learned_tx, alpha=0.25)
            changed.append("back_swipe")

        reset = gestures.get("reset_pointer")
        if reset and int(reset.get("samples", 0)) >= min_samples:
            learned_tx = self._clamp(reset.get("avg_path_x", default_cfg["reset_wave_travel"]) * 0.18, 0.03, 0.09)
            learned_tw = self._clamp(reset.get("avg_duration_sec", default_cfg["reset_wave_window"]) * 0.95, 0.60, 1.20)
            self._gesture_cfg["reset_wave_travel"] = self._blend(default_cfg["reset_wave_travel"], learned_tx, alpha=0.25)
            self._gesture_cfg["reset_wave_window"] = self._blend(default_cfg["reset_wave_window"], learned_tw, alpha=0.25)
            changed.append("reset_pointer")

        su = gestures.get("scroll_up")
        sd = gestures.get("scroll_down")
        candidates = [g for g in (su, sd) if g and int(g.get("samples", 0)) >= min_samples]
        if candidates:
            avg_speed = sum(g.get("avg_speed", default_cfg["swipe_vel"]) for g in candidates) / len(candidates)
            avg_path_y = sum(g.get("avg_path_y", default_cfg["swipe_travel"]) for g in candidates) / len(candidates)
            learned_v = self._clamp(avg_speed, 0.35, 0.90)
            learned_ty = self._clamp(avg_path_y * 0.20, 0.04, 0.10)
            self._gesture_cfg["swipe_vel"] = self._blend(default_cfg["swipe_vel"], learned_v, alpha=0.25)
            self._gesture_cfg["swipe_travel"] = self._blend(default_cfg["swipe_travel"], learned_ty, alpha=0.25)
            changed.append("scroll")

        select = gestures.get("select")
        if select and int(select.get("samples", 0)) >= min_samples:
            dur = self._clamp(select.get("avg_duration_sec", 0.3), 0.15, 0.45)
            learned_frames = int(self._clamp(round(dur * 8.0), 2, 4))
            self._gesture_cfg["select_hold_frames"] = int(
                self._clamp(round(self._blend(default_cfg["select_hold_frames"], learned_frames, alpha=0.35)), 2, 4)
            )
            changed.append("select")

        if changed and not silent:
            self._status_text = f"Applied profiles: {', '.join(changed)}"
            self._status_until = time.time() + RESET_STATUS_TIME
        return bool(changed)

    # ── Scroll inertia ──────────────────────────────────────────────────────

    def _tick_scroll(self):
        if abs(self._scroll_vel) < 0.5:
            self._scroll_vel = 0
            return

        delta      = self._scroll_vel * 0.033          # pixels this frame
        max_scroll = max(0.0, float(self._total_h - self._canvas_height()))
        self._scroll_px   = max(0.0, min(self._scroll_px + delta, max_scroll))
        self._scroll_vel *= SCROLL_FRICTION

        frac = self._scroll_px / self._total_h if self._total_h > 0 else 0
        self._cv.yview_moveto(frac)

        row_h = ITEM_H + ITEM_PAD
        current_row = int(self._scroll_px // row_h)
        if current_row != self._last_visible_row:
            self._draw_grid()

    # ── Cleanup ─────────────────────────────────────────────────────────────

    def _close(self):
        self._tracker.stop()
        self.root.destroy()


# ── Entry point ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    root = tk.Tk()
    FileExplorerApp(root, start_path=os.path.expanduser("~"))
    root.mainloop()
