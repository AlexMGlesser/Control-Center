import os
import time
import cv2
import mediapipe as mp
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision as mp_vision

__version__ = "0.1.0"

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
FINGERTIP_IDS = [4, 8, 12, 16, 20]  # thumb, index, middle, ring, pinky

# Hand skeleton connections (MediaPipe 21-point layout)
HAND_CONNECTIONS = [
    (0, 1), (1, 2), (2, 3), (3, 4),          # thumb
    (0, 5), (5, 6), (6, 7), (7, 8),           # index
    (0, 9), (9, 10), (10, 11), (11, 12),       # middle
    (0, 13), (13, 14), (14, 15), (15, 16),     # ring
    (0, 17), (17, 18), (18, 19), (19, 20),     # pinky
    (5, 9), (9, 13), (13, 17),                 # palm knuckles
]

MODEL_PATH = os.path.join(os.path.dirname(__file__), "hand_landmarker.task")


def ensure_model():
    if not os.path.exists(MODEL_PATH):
        raise FileNotFoundError(
            f"Missing local MediaPipe model: {MODEL_PATH}\n"
            "This demo runs offline and will not download model files."
        )


def draw_hand(frame, landmarks, h, w):
    """Draw green skeleton lines and red fingertip dots onto frame."""
    pts = [(int(lm.x * w), int(lm.y * h)) for lm in landmarks]

    # Green connection lines
    for a, b in HAND_CONNECTIONS:
        cv2.line(frame, pts[a], pts[b], (0, 220, 0), 2)

    # Red fingertip circles
    for tip_id in FINGERTIP_IDS:
        cx, cy = pts[tip_id]
        cv2.circle(frame, (cx, cy), 10, (0, 0, 220), -1)
        cv2.circle(frame, (cx, cy), 10, (0, 0, 160), 2)


def run():
    ensure_model()

    base_opts = mp_python.BaseOptions(model_asset_path=MODEL_PATH)
    opts = mp_vision.HandLandmarkerOptions(
        base_options=base_opts,
        running_mode=mp_vision.RunningMode.VIDEO,
        num_hands=2,
        min_hand_detection_confidence=0.6,
        min_hand_presence_confidence=0.6,
        min_tracking_confidence=0.6,
    )

    cap = cv2.VideoCapture(0, cv2.CAP_DSHOW)
    if not cap.isOpened():
        print("ERROR: Could not open camera.")
        return

    with mp_vision.HandLandmarker.create_from_options(opts) as landmarker:
        start = time.perf_counter()
        while True:
            ret, frame = cap.read()
            if not ret:
                print("ERROR: Failed to read frame.")
                break

            frame = cv2.flip(frame, 1)
            h, w = frame.shape[:2]

            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)

            timestamp_ms = int((time.perf_counter() - start) * 1000)

            result = landmarker.detect_for_video(mp_image, timestamp_ms)

            if result.hand_landmarks:
                for hand_lms in result.hand_landmarks:
                    draw_hand(frame, hand_lms, h, w)

            cv2.imshow(f"Hand Tracker v{__version__}", frame)

            key = cv2.waitKey(1) & 0xFF
            if key == ord("q") or key == 27:
                break

    cap.release()
    cv2.destroyAllWindows()


if __name__ == "__main__":
    run()
