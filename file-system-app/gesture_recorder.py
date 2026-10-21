"""
Gesture Recorder — guided capture of labeled hand-gesture training data.

Pick (or type) a gesture label and a repetition count, then the recorder runs
a loop per rep:  countdown -> record a fixed-length clip -> short rest -> next.
Each finished rep is saved as one sample file under dataset/<label>/ and the
dataset manifest is rebuilt. See README.md ("Gesture dataset format") for the
file schema and gesture_dataset.py for the writer/loader.

Reuses HandTracker (camera thread + MediaPipe HandLandmarker) from
file_explorer.py, so capture settings match the explorer exactly.

Keys:  Space = start / pause / resume    R = redo last rep
       D or Backspace = discard last rep  Esc = quit

CLI (used by Control Center to launch pre-configured):
    python gesture_recorder.py --label swipe_left --reps 20 [--duration 2.0]
        [--countdown 3] [--rest 1.5] [--dataset-dir DIR] [--save-video] [--autostart]
"""

import argparse
import os
import sys
import time
from datetime import datetime

import gesture_dataset as gds

RECORDER_VERSION = "0.1.0"

DEFAULT_REPS = 10
DEFAULT_DURATION_SEC = 2.0
DEFAULT_COUNTDOWN_SEC = 3.0
DEFAULT_REST_SEC = 1.5

# Suggested labels: the explorer's existing calibration actions plus the
# background class. Free text is allowed too.
SUGGESTED_LABELS = [
    "select",
    "back_swipe",
    "reset_pointer",
    "scroll_up",
    "scroll_down",
    gds.BACKGROUND_LABEL,
]


def default_dataset_dir():
    # Same DATA_DIR rule as file_explorer.py, without importing it (and so
    # without importing OpenCV/MediaPipe) just to compute a path.
    app_dir = os.path.dirname(os.path.abspath(__file__))
    data_dir = os.path.abspath(os.environ.get("FILE_SYSTEM_DATA_DIR") or app_dir)
    return os.path.join(data_dir, "dataset")


def log(message):
    # Control Center keeps the tail of stdout/stderr for its status endpoint.
    print(f"[gesture_recorder] {message}", flush=True)


# ══════════════════════════════════════════════════════════════════════════
# Session state machine (no UI, no camera — driven by tick())
# ══════════════════════════════════════════════════════════════════════════

class VideoClipWriter:
    """Optional raw-video sidecar for one sample. Lazily imports cv2."""

    def __init__(self, path, fps, frame_size):
        import cv2

        self.path = path
        os.makedirs(os.path.dirname(path), exist_ok=True)
        self._writer = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*"mp4v"), float(fps), tuple(frame_size))
        if not self._writer.isOpened():
            raise OSError(f"Could not open video writer for {path}")

    def write(self, frame):
        self._writer.write(frame)

    def close(self):
        self._writer.release()

    def discard(self):
        self.close()
        try:
            os.remove(self.path)
        except OSError:
            pass


class RecordingSession:
    """Guided countdown -> record -> rest loop for one label.

    States: idle, countdown, recording, rest, paused, done.
    The caller feeds frames via tick(now, frame) where frame is a dict
    {"seq", "ts", "hands", "frame_size", "raw_frame"} (or None).
    """

    def __init__(self, dataset_dir, label, reps, duration_sec=DEFAULT_DURATION_SEC,
                 countdown_sec=DEFAULT_COUNTDOWN_SEC, rest_sec=DEFAULT_REST_SEC,
                 save_video=False, video_fps=24.0, on_event=None):
        self.dataset_dir = dataset_dir
        self.label = gds.normalize_label(label)
        if not self.label:
            raise ValueError("A gesture label is required (letters, digits, _ or -).")
        self.reps = max(1, int(reps))
        self.duration_sec = max(0.2, float(duration_sec))
        self.countdown_sec = max(0.0, float(countdown_sec))
        self.rest_sec = max(0.0, float(rest_sec))
        self.save_video = bool(save_video)
        self.video_fps = float(video_fps)
        self.session_id = f"{self.label}_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
        self._on_event = on_event or (lambda kind, data: None)

        self.state = "idle"
        self.saved = []            # stack of (sample_id, path) saved this session
        self.phase_until = 0.0
        self._paused_from = None
        self._clip_frames = []
        self._clip_start = 0.0
        self._clip_started_at = ""
        self._clip_frame_size = (0, 0)
        self._last_seq = -1
        self._video = None
        self._pending_sample_id = None
        self.last_message = "Ready."

    # ── Queries ─────────────────────────────────────────────────────────
    @property
    def completed(self):
        return len(self.saved)

    @property
    def current_rep(self):
        """1-based number of the rep being (or about to be) recorded."""
        return min(self.completed + 1, self.reps)

    def seconds_left(self, now):
        return max(0.0, self.phase_until - now)

    def clip_frame_count(self):
        return len(self._clip_frames)

    # ── Controls ────────────────────────────────────────────────────────
    def start(self, now):
        if self.state in ("idle", "done"):
            if self.completed >= self.reps:
                self.reps = self.completed + 1   # "Start" after done = one more
            self._begin_countdown(now)
            return True
        return False

    def toggle_pause(self, now):
        if self.state == "paused":
            # Resume: always re-run the countdown so the user can get ready.
            self._paused_from = None
            self._begin_countdown(now)
            self._emit("resumed", {})
            return True
        if self.state in ("countdown", "recording", "rest"):
            if self.state == "recording":
                self._abort_clip()
            self._paused_from = self.state
            self.state = "paused"
            self.last_message = "Paused. Press Space to resume."
            self._emit("paused", {})
            return True
        return False

    def discard_last(self):
        """Delete the most recently saved sample from this session."""
        if not self.saved:
            self.last_message = "Nothing to discard."
            return None
        sample_id, _path = self.saved.pop()
        gds.delete_sample(self.dataset_dir, self.label, sample_id)
        gds.rebuild_manifest(self.dataset_dir, RECORDER_VERSION)
        if self.state == "done":
            self.state = "idle"
        self.last_message = f"Discarded {sample_id}."
        self._emit("discarded", {"sample_id": sample_id})
        return sample_id

    def redo_last(self, now):
        """Discard the last saved rep and immediately re-record it."""
        if self.state == "recording":
            self._abort_clip()
        discarded = self.discard_last()
        if discarded is None and self.state in ("idle", "done"):
            return None
        self._begin_countdown(now)
        return discarded

    def quit(self):
        if self.state == "recording":
            self._abort_clip()
        self.state = "done"
        gds.rebuild_manifest(self.dataset_dir, RECORDER_VERSION)

    # ── Main loop ───────────────────────────────────────────────────────
    def tick(self, now, frame=None):
        if self.state == "countdown":
            if now >= self.phase_until:
                self._begin_recording(now)
            else:
                return

        if self.state == "recording":
            if frame is not None:
                self._add_frame(frame)
            if now >= self.phase_until:
                self._finish_clip(now)
            return

        if self.state == "rest" and now >= self.phase_until:
            self._begin_countdown(now)

    # ── Internals ───────────────────────────────────────────────────────
    def _emit(self, kind, data):
        try:
            self._on_event(kind, data)
        except Exception:
            pass

    def _begin_countdown(self, now):
        self.state = "countdown"
        self.phase_until = now + self.countdown_sec
        self.last_message = f"Get ready: rep {self.current_rep}/{self.reps} ({self.label})"

    def _begin_recording(self, now):
        self.state = "recording"
        self.phase_until = now + self.duration_sec
        self._clip_frames = []
        self._clip_start = now
        self._clip_started_at = datetime.now().isoformat(timespec="milliseconds")
        self._last_seq = -1
        self._video = None
        self.last_message = f"Recording rep {self.current_rep}/{self.reps}..."

    def _add_frame(self, frame):
        seq = frame.get("seq")
        ts = float(frame.get("ts") or 0.0)
        if seq is not None and seq == self._last_seq:
            return                      # same camera frame re-read by the UI tick
        if ts < self._clip_start:
            return                      # captured before this clip began
        self._last_seq = seq
        size = frame.get("frame_size") or (0, 0)
        if size[0] and size[1]:
            self._clip_frame_size = (int(size[0]), int(size[1]))
        self._clip_frames.append(
            {
                "t": round(ts - self._clip_start, 4),
                "seq": seq,
                "hands": [gds.hand_to_record(h) for h in frame.get("hands", [])],
            }
        )
        raw = frame.get("raw_frame")
        if self.save_video and raw is not None:
            if self._video is None:
                self._pending_sample_id = gds.new_sample_id(self.label)
                path = os.path.join(self.dataset_dir, self.label, f"{self._pending_sample_id}.mp4")
                try:
                    self._video = VideoClipWriter(path, self.video_fps, self._clip_frame_size)
                except OSError as exc:
                    log(f"video disabled: {exc}")
                    self.save_video = False
                    self._video = None
            if self._video is not None:
                self._video.write(raw)

    def _abort_clip(self):
        if self._video is not None:
            self._video.discard()
            self._video = None
        self._clip_frames = []

    def _finish_clip(self, now):
        frames = self._clip_frames
        self._clip_frames = []
        video_file = None
        if self._video is not None:
            sample_id = self._pending_sample_id
            self._video.close()
            video_file = os.path.basename(self._video.path)
            self._video = None
        else:
            sample_id = gds.new_sample_id(self.label)

        if not frames:
            # Camera produced nothing during the clip; don't save an empty sample.
            if video_file:
                gds.delete_sample(self.dataset_dir, self.label, sample_id)
            self.last_message = "No camera frames captured; repeating this rep."
            self._emit("empty", {})
            self._begin_countdown(now)
            return

        sample = gds.build_sample(
            label=self.label,
            sample_id=sample_id,
            session_id=self.session_id,
            rep_index=self.completed,
            frames=frames,
            frame_size=self._clip_frame_size,
            target_duration_sec=self.duration_sec,
            recorder_version=RECORDER_VERSION,
            started_at=self._clip_started_at,
            video_file=video_file,
        )
        path = gds.write_sample(self.dataset_dir, sample)
        self.saved.append((sample_id, path))
        gds.rebuild_manifest(self.dataset_dir, RECORDER_VERSION)
        self.last_message = (
            f"Saved rep {self.completed}/{self.reps}: {sample['num_frames']} frames, "
            f"{sample['frames_with_hands']} with hands"
        )
        self._emit("saved", {"sample_id": sample_id, "path": path, "num_frames": sample["num_frames"]})

        if self.completed >= self.reps:
            self.state = "done"
            self.last_message = f"Done: {self.completed} reps of '{self.label}' saved."
            self._emit("done", {"count": self.completed})
        else:
            self.state = "rest"
            self.phase_until = now + self.rest_sec


# ══════════════════════════════════════════════════════════════════════════
# Tk UI
# ══════════════════════════════════════════════════════════════════════════

def run_ui(args):
    import cv2
    import tkinter as tk
    from tkinter import ttk
    from PIL import Image, ImageTk
    import file_explorer as fe

    PREVIEW_W, PREVIEW_H = 800, 450
    STATE_COLOURS = {   # BGR for cv2 overlays
        "idle": (200, 200, 200),
        "countdown": (80, 220, 250),
        "recording": (80, 80, 240),
        "rest": (160, 230, 160),
        "paused": (200, 160, 160),
        "done": (160, 230, 160),
    }

    class RecorderApp:
        def __init__(self, root):
            self.root = root
            root.title(f"Gesture Recorder v{RECORDER_VERSION}")
            root.configure(bg=fe.BG)
            root.geometry("1220x640")
            root.minsize(1100, 600)

            self.dataset_dir = os.path.abspath(args.dataset_dir or default_dataset_dir())
            os.makedirs(self.dataset_dir, exist_ok=True)
            self.session = None
            self._photo = None
            self._last_preview_at = 0.0
            self._tracker_announced = False

            self.label_var = tk.StringVar(value=gds.normalize_label(args.label) if args.label else "")
            self.reps_var = tk.IntVar(value=args.reps)
            self.duration_var = tk.DoubleVar(value=args.duration)
            self.countdown_var = tk.DoubleVar(value=args.countdown)
            self.rest_var = tk.DoubleVar(value=args.rest)
            self.video_var = tk.BooleanVar(value=bool(args.save_video))
            self.status_var = tk.StringVar(value="Starting camera...")
            self.counts_var = tk.StringVar(value="")

            self._build_ui()
            self._refresh_counts()

            self.tracker = fe.HandTracker()
            self.tracker.start()

            root.bind("<space>", lambda _e: self._on_space())
            root.bind("<KeyPress-r>", lambda _e: self._on_redo())
            root.bind("<KeyPress-d>", lambda _e: self._on_discard())
            root.bind("<BackSpace>", lambda _e: self._on_discard())
            root.bind("<Escape>", lambda _e: self._close())
            root.protocol("WM_DELETE_WINDOW", self._close)
            self._autostart_pending = bool(args.autostart and self.label_var.get())
            root.after(15, self._tick)

        # ── UI construction ────────────────────────────────────────────
        def _build_ui(self):
            btn = {
                "bg": fe.SURFACE, "fg": fe.TXT, "activebackground": fe.HOVER_BG,
                "activeforeground": fe.TXT, "relief": "flat", "bd": 0,
                "font": ("Segoe UI", 10), "padx": 10, "pady": 5,
            }
            lbl = {"bg": fe.HEADER_BG, "fg": fe.TXT, "font": ("Segoe UI", 10)}

            top = tk.Frame(self.root, bg=fe.HEADER_BG)
            top.pack(fill=tk.X)

            tk.Label(top, text="Label", **lbl).pack(side=tk.LEFT, padx=(10, 4), pady=8)
            self.label_box = ttk.Combobox(top, textvariable=self.label_var, width=18, values=self._label_choices())
            self.label_box.pack(side=tk.LEFT, pady=8)

            def spin(text, var, lo, hi, inc, width=5):
                tk.Label(top, text=text, **lbl).pack(side=tk.LEFT, padx=(12, 4))
                tk.Spinbox(top, from_=lo, to=hi, increment=inc, textvariable=var, width=width,
                           bg=fe.SURFACE, fg=fe.TXT, buttonbackground=fe.SURFACE, relief="flat").pack(side=tk.LEFT)

            spin("Reps", self.reps_var, 1, 500, 1)
            spin("Clip s", self.duration_var, 0.5, 30, 0.5)
            spin("Countdown s", self.countdown_var, 0, 10, 0.5)
            spin("Rest s", self.rest_var, 0, 10, 0.5)
            tk.Checkbutton(top, text="Save video", variable=self.video_var, bg=fe.HEADER_BG, fg=fe.TXT,
                           selectcolor=fe.SURFACE, activebackground=fe.HEADER_BG,
                           activeforeground=fe.TXT).pack(side=tk.LEFT, padx=12)

            bar = tk.Frame(self.root, bg=fe.BG)
            bar.pack(fill=tk.X, pady=(6, 0))
            self.start_btn = tk.Button(bar, text="Start  [Space]", command=self._on_space,
                                       **{**btn, "bg": fe.SEL_BG, "fg": fe.TXT_SEL, "font": ("Segoe UI", 10, "bold")})
            self.start_btn.pack(side=tk.LEFT, padx=(10, 4))
            tk.Button(bar, text="Redo last  [R]", command=self._on_redo, **btn).pack(side=tk.LEFT, padx=4)
            tk.Button(bar, text="Discard last  [D]", command=self._on_discard, **btn).pack(side=tk.LEFT, padx=4)
            tk.Button(bar, text="Record background (none)", command=self._use_background, **btn).pack(side=tk.LEFT, padx=12)
            tk.Button(bar, text="Quit  [Esc]", command=self._close, **btn).pack(side=tk.RIGHT, padx=10)

            body = tk.Frame(self.root, bg=fe.BG)
            body.pack(fill=tk.BOTH, expand=True, padx=10, pady=8)
            self.preview = tk.Label(body, bg="#000000", width=PREVIEW_W, height=PREVIEW_H)
            self.preview.pack(side=tk.LEFT, anchor="n")

            side = tk.Frame(body, bg=fe.HEADER_BG, width=330)
            side.pack(side=tk.LEFT, fill=tk.BOTH, expand=True, padx=(10, 0))
            side.pack_propagate(False)
            tk.Label(side, textvariable=self.status_var, bg=fe.HEADER_BG, fg=fe.GREEN, wraplength=300,
                     justify="left", font=("Segoe UI", 10, "bold"), anchor="w").pack(fill=tk.X, padx=10, pady=(10, 6))
            tk.Label(side, text="Dataset", bg=fe.HEADER_BG, fg=fe.TXT, font=("Segoe UI", 10, "bold"),
                     anchor="w").pack(fill=tk.X, padx=10)
            tk.Label(side, text=self.dataset_dir, bg=fe.HEADER_BG, fg=fe.MUTED, wraplength=300, justify="left",
                     font=("Segoe UI", 8), anchor="w").pack(fill=tk.X, padx=10)
            tk.Label(side, textvariable=self.counts_var, bg=fe.HEADER_BG, fg=fe.TXT, justify="left",
                     font=("Consolas", 9), anchor="nw").pack(fill=tk.X, padx=10, pady=6)
            hint = (
                "Tips\n"
                "- Perform the gesture once per clip, starting after the red REC appears.\n"
                "- Vary position, distance and speed a little between reps.\n"
                f"- Background label '{gds.BACKGROUND_LABEL}': idle hands, random non-gesture motion, "
                "hands entering/leaving, empty frame. Record about as many as your largest gesture class."
            )
            tk.Label(side, text=hint, bg=fe.HEADER_BG, fg=fe.MUTED, wraplength=300, justify="left",
                     font=("Segoe UI", 9), anchor="nw").pack(fill=tk.X, padx=10, pady=(6, 10))

        def _label_choices(self):
            existing = []
            manifest = None
            try:
                manifest = gds.read_manifest(self.dataset_dir)
            except (OSError, ValueError):
                manifest = None
            if manifest:
                existing = list(manifest.get("labels", {}).keys())
            return sorted(set(SUGGESTED_LABELS) | set(existing))

        def _refresh_counts(self):
            try:
                manifest = gds.read_manifest(self.dataset_dir) or {"labels": {}, "total_samples": 0}
            except (OSError, ValueError):
                manifest = {"labels": {}, "total_samples": 0}
            lines = [f"{name:<20}{count:>5}" for name, count in manifest.get("labels", {}).items()]
            lines.append(f"{'total':<20}{manifest.get('total_samples', 0):>5}")
            self.counts_var.set("\n".join(lines))
            self.label_box.configure(values=self._label_choices())

        # ── Controls ───────────────────────────────────────────────────
        def _use_background(self):
            if self.session and self.session.state not in ("idle", "done"):
                return
            self.label_var.set(gds.BACKGROUND_LABEL)
            self.status_var.set("Background label selected. Press Space to start.")

        def _settings_changed(self):
            s = self.session
            return (
                s is None
                or gds.normalize_label(self.label_var.get()) != s.label
                or bool(self.video_var.get()) != s.save_video
            )

        def _on_space(self):
            if not self.tracker.is_available:
                self.status_var.set("Camera is not available yet.")
                return
            now = time.time()
            s = self.session
            if s is None or (s.state in ("idle", "done") and self._settings_changed()):
                try:
                    reps = int(self.reps_var.get())
                    self.session = RecordingSession(
                        self.dataset_dir, self.label_var.get(), reps,
                        duration_sec=float(self.duration_var.get()),
                        countdown_sec=float(self.countdown_var.get()),
                        rest_sec=float(self.rest_var.get()),
                        save_video=bool(self.video_var.get()),
                        video_fps=fe.TRACKER_FPS,
                        on_event=self._on_session_event,
                    )
                except (ValueError, tk.TclError) as exc:
                    self.status_var.set(str(exc))
                    return
                self.label_var.set(self.session.label)
                log(f"session {self.session.session_id}: {reps} reps of '{self.session.label}'")
                self.session.start(now)
                return
            if s.state in ("idle", "done"):
                try:
                    s.reps = max(s.completed + 1, int(self.reps_var.get()))
                    s.duration_sec = max(0.2, float(self.duration_var.get()))
                    s.countdown_sec = max(0.0, float(self.countdown_var.get()))
                    s.rest_sec = max(0.0, float(self.rest_var.get()))
                except (ValueError, tk.TclError):
                    pass
                s.start(now)
                return
            s.toggle_pause(now)

        def _on_redo(self):
            if self.session is not None:
                self.session.redo_last(time.time())
                self._refresh_counts()

        def _on_discard(self):
            if self.session is not None:
                self.session.discard_last()
                self._refresh_counts()

        def _on_session_event(self, kind, data):
            if kind in ("saved", "discarded", "done"):
                log(f"{kind}: {data}")
                self.root.after(0, self._refresh_counts)

        # ── Tick ───────────────────────────────────────────────────────
        def _tick(self):
            now = time.time()
            frame, raw_frame, _wire, hands, seq, ts = self.tracker.latest_with_meta()

            if self.tracker.init_done and not self._tracker_announced:
                self._tracker_announced = True
                if self.tracker.is_available:
                    self.status_var.set("Camera ready. Choose a label and press Space.")
                    log("camera ready")
                else:
                    msg = self.tracker.init_error or "Camera unavailable"
                    self.status_var.set(f"Camera unavailable: {msg}")
                    log(f"camera unavailable: {msg}")
            if self._autostart_pending and self.tracker.is_available:
                self._autostart_pending = False
                self._on_space()

            s = self.session
            if s is not None and frame is not None:
                h, w = frame.shape[:2]
                s.tick(now, {"seq": seq, "ts": ts, "hands": hands, "frame_size": (w, h),
                             "raw_frame": raw_frame if s.save_video else None})
            elif s is not None:
                s.tick(now, None)

            if s is not None:
                self.status_var.set(s.last_message)
                self.start_btn.configure(text={
                    "idle": "Start  [Space]", "done": "Start  [Space]",
                    "paused": "Resume  [Space]",
                }.get(s.state, "Pause  [Space]"))

            if frame is not None and now - self._last_preview_at >= 1.0 / 20:
                self._last_preview_at = now
                self._render(frame, hands, now)

            if self.tracker.init_error and self.tracker.init_done and not self.tracker.is_available:
                self.status_var.set(self.tracker.init_error)

            self.root.after(15, self._tick)

        def _render(self, frame, hands, now):
            img = cv2.resize(frame, (PREVIEW_W, PREVIEW_H), interpolation=cv2.INTER_LINEAR)
            s = self.session
            state = s.state if s else "idle"
            colour = STATE_COLOURS.get(state, (220, 220, 220))
            cv2.rectangle(img, (0, 0), (PREVIEW_W, 44), (20, 20, 20), -1)
            label = s.label if s else (gds.normalize_label(self.label_var.get()) or "-")
            try:
                reps = s.reps if s else int(self.reps_var.get())
            except (ValueError, tk.TclError):
                reps = 0
            done = s.completed if s else 0
            cv2.putText(img, f"{state.upper()}", (12, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.8, colour, 2, cv2.LINE_AA)
            cv2.putText(img, f"label: {label}   rep {min(done + 1, reps)}/{reps}   saved {done}",
                        (190, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (230, 230, 230), 1, cv2.LINE_AA)
            hand_text = f"hands: {len(hands)}"
            cv2.putText(img, hand_text, (PREVIEW_W - 120, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.6,
                        (120, 230, 120) if hands else (120, 120, 240), 1, cv2.LINE_AA)

            if s and state == "countdown":
                left = s.seconds_left(now)
                text = str(int(left) + 1) if left > 0 else "GO"
                cv2.putText(img, text, (PREVIEW_W // 2 - 40, PREVIEW_H // 2 + 40),
                            cv2.FONT_HERSHEY_SIMPLEX, 4.0, colour, 8, cv2.LINE_AA)
            elif s and state == "recording":
                cv2.circle(img, (30, 70), 12, (40, 40, 230), -1)
                cv2.putText(img, f"REC {s.seconds_left(now):.1f}s  frames {s.clip_frame_count()}", (52, 78),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.7, (40, 40, 230), 2, cv2.LINE_AA)
                frac = 1.0 - (s.seconds_left(now) / s.duration_sec if s.duration_sec else 0)
                cv2.rectangle(img, (0, PREVIEW_H - 10), (int(PREVIEW_W * frac), PREVIEW_H), (40, 40, 230), -1)
            elif s and state == "rest":
                cv2.putText(img, f"rest {s.seconds_left(now):.1f}s", (12, 78),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.7, colour, 2, cv2.LINE_AA)
            elif state == "paused":
                cv2.putText(img, "PAUSED - Space to resume", (12, 78),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.7, colour, 2, cv2.LINE_AA)

            rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
            try:
                self._photo = ImageTk.PhotoImage(Image.fromarray(rgb))
                self.preview.configure(image=self._photo, width=PREVIEW_W, height=PREVIEW_H)
            except tk.TclError:
                pass

        def _close(self):
            if self.session is not None:
                self.session.quit()
                log(f"quit: {self.session.completed} reps saved this session")
            self.tracker.stop()
            self.root.destroy()

    root = tk.Tk()
    RecorderApp(root)
    root.mainloop()


def parse_args(argv=None):
    p = argparse.ArgumentParser(description="Record labeled hand-gesture training samples.")
    p.add_argument("--label", default="", help=f"Gesture label (use '{gds.BACKGROUND_LABEL}' for background/negatives).")
    p.add_argument("--reps", type=int, default=DEFAULT_REPS, help="Number of repetitions to record.")
    p.add_argument("--duration", type=float, default=DEFAULT_DURATION_SEC, help="Clip length per rep, seconds.")
    p.add_argument("--countdown", type=float, default=DEFAULT_COUNTDOWN_SEC, help="Countdown before each rep, seconds.")
    p.add_argument("--rest", type=float, default=DEFAULT_REST_SEC, help="Rest between reps, seconds.")
    p.add_argument("--dataset-dir", default=None, help="Dataset root (default: <data dir>/dataset).")
    p.add_argument("--save-video", action="store_true", help="Also save each rep's raw camera clip as .mp4.")
    p.add_argument("--autostart", action="store_true", help="Start the rep loop as soon as the camera is ready (needs --label).")
    p.add_argument("--version", action="version", version=f"gesture_recorder {RECORDER_VERSION}")
    return p.parse_args(argv)


if __name__ == "__main__":
    os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
    os.environ.setdefault("GLOG_minloglevel", "3")
    cli_args = parse_args()
    log(f"v{RECORDER_VERSION} starting (python {sys.version.split()[0]})")
    run_ui(cli_args)
