// Reads raw Linux evdev multi-touch events from the laptop touchpad to detect
// true 1-finger-anchored "screw" rotation gestures (one finger stays still while
// the second orbits clockwise or counter-clockwise), which Wayland/Chromium does
// not forward via standard DOM wheel events.
//
// Pure Node.js, zero native addons, graceful no-op if /dev/input is unreadable.
const fs = require('node:fs');

const EV_SYN = 0x00;
const EV_KEY = 0x01;
const EV_ABS = 0x03;
const SYN_REPORT = 0x00;
const BTN_TOOL_FINGER = 0x145;
const BTN_TOUCH = 0x14a;
const BTN_TOOL_DOUBLETAP = 0x14d;
const BTN_TOOL_TRIPLETAP = 0x14e;
const BTN_TOOL_QUADTAP = 0x14f;
const ABS_MT_SLOT = 0x2f;
const ABS_MT_POSITION_X = 0x35;
const ABS_MT_POSITION_Y = 0x36;
const ABS_MT_TRACKING_ID = 0x39;
const EVENT_SIZE = 24; // struct input_event on 64-bit Linux (16B timeval + 2B type + 2B code + 4B value)

function wrapDeltaDeg(d) {
  let out = d;
  while (out > 180) out -= 360;
  while (out < -180) out += 360;
  return out;
}

// Pure multi-touch screw-rotation state machine (unit-testable without hardware).
// Calls onRotate(deltaDeg) ONLY when 2 fingers are genuinely down on the touchpad
// and one orbits an anchored finger (or both counter-twist).
function createScrewDetector(onRotate) {
  let slot = 0;
  const fingers = new Map(); // slot -> { id, x, y, prevX, prevY }
  let prevAngle = null;
  let prevDist = null;
  let accumAngle = 0;

  // Hardware EV_KEY finger-count gates (prevents single-finger mouse motion from ever rotating
  // if a touchpad drops a tracking-ID release or leaves a stale slot behind).
  let hasToolKeyEvents = false;
  let btnTouch = false;
  let btnSingleFinger = false;
  let btnDoubleTap = false;
  let btnMultiOther = false;

  function resetGesture() {
    prevAngle = null;
    prevDist = null;
    accumAngle = 0;
  }

  function feedEvent(type, code, value) {
    if (type === EV_KEY) {
      if (code === BTN_TOUCH) {
        hasToolKeyEvents = true;
        btnTouch = value !== 0;
        if (!btnTouch) {
          fingers.clear();
          resetGesture();
        }
      } else if (code === BTN_TOOL_FINGER) {
        hasToolKeyEvents = true;
        btnSingleFinger = value !== 0;
        if (btnSingleFinger) {
          btnDoubleTap = false;
          resetGesture();
        }
      } else if (code === BTN_TOOL_DOUBLETAP) {
        hasToolKeyEvents = true;
        btnDoubleTap = value !== 0;
        if (!btnDoubleTap) resetGesture();
      } else if (code === BTN_TOOL_TRIPLETAP || code === BTN_TOOL_QUADTAP) {
        hasToolKeyEvents = true;
        btnMultiOther = value !== 0;
        if (btnMultiOther) resetGesture();
      }
      return;
    }

    if (type === EV_ABS) {
      if (code === ABS_MT_SLOT) {
        slot = value;
      } else if (code === ABS_MT_TRACKING_ID) {
        if (value < 0) {
          fingers.delete(slot);
          resetGesture();
        } else {
          fingers.set(slot, { id: value, x: null, y: null, prevX: null, prevY: null });
          resetGesture();
        }
      } else if (code === ABS_MT_POSITION_X) {
        // Never auto-create a ghost finger without an active ABS_MT_TRACKING_ID >= 0
        const f = fingers.get(slot);
        if (f) f.x = value;
      } else if (code === ABS_MT_POSITION_Y) {
        const f = fingers.get(slot);
        if (f) f.y = value;
      }
      return;
    }

    if (type === EV_SYN && code === SYN_REPORT) {
      const ready = Array.from(fingers.values()).filter((f) => f.x !== null && f.y !== null);
      // If hardware EV_KEY tool events are reported, strictly require 2-finger contact
      // (BTN_TOUCH=1, BTN_TOOL_DOUBLETAP=1, and NOT single-finger / 3+ finger mode).
      const toolAllowsTwoFingers = !hasToolKeyEvents || (btnTouch && btnDoubleTap && !btnSingleFinger && !btnMultiOther);
      if (ready.length !== 2 || !toolAllowsTwoFingers) {
        resetGesture();
        for (const f of ready) { f.prevX = f.x; f.prevY = f.y; }
        return;
      }

      const [f0, f1] = ready;
      const dx = f1.x - f0.x;
      const dy = f1.y - f0.y;
      const dist = Math.hypot(dx, dy);
      const angle = (Math.atan2(dy, dx) * 180) / Math.PI;

      if (prevAngle !== null && f0.prevX !== null && f1.prevX !== null && dist > 20) {
        const move0 = Math.hypot(f0.x - f0.prevX, f0.y - f0.prevY);
        const move1 = Math.hypot(f1.x - f1.prevX, f1.y - f1.prevY);
        const maxMove = Math.max(move0, move1);
        const minMove = Math.min(move0, move1);

        // One finger anchored while the other orbits, OR counter-rotating fingers
        const oneAnchored = maxMove > 1 && minMove <= maxMove * 0.45;
        const dotMove = (f0.x - f0.prevX) * (f1.x - f1.prevX) + (f0.y - f0.prevY) * (f1.y - f1.prevY);
        const counterTwist = maxMove > 1 && dotMove < 0;

        const dAngle = wrapDeltaDeg(angle - prevAngle);
        const dDist = prevDist !== null ? Math.abs(dist - prevDist) : 0;
        const arcLen = (Math.abs(dAngle) * Math.PI / 180) * dist;

        // Require tangential (rotational) motion to dominate radial (pinch) motion
        if ((oneAnchored || counterTwist) && arcLen > dDist * 0.85 && Math.abs(dAngle) < 45) {
          accumAngle += dAngle;
          if (Math.abs(accumAngle) >= 0.4) {
            onRotate(accumAngle);
            accumAngle = 0;
          }
        }
      }

      prevAngle = angle;
      prevDist = dist;
      f0.prevX = f0.x;
      f0.prevY = f0.y;
      f1.prevX = f1.x;
      f1.prevY = f1.y;
    }
  }

  return { feedEvent };
}

function findTouchpadDevice() {
  if (process.platform !== 'linux') return null;
  try {
    const text = fs.readFileSync('/proc/bus/input/devices', 'utf8');
    const blocks = text.split(/\n\n+/);
    for (const block of blocks) {
      if (!/touchpad/i.test(block)) continue;
      const m = /Handlers=.*\b(event\d+)\b/.exec(block);
      if (m) return `/dev/input/${m[1]}`;
    }
  } catch { /* ignore */ }
  return null;
}

function startTouchpadWatcher(onRotate) {
  const devPath = findTouchpadDevice();
  if (!devPath) return { available: false, reason: 'No Linux touchpad device found.', stop: () => {} };

  let fd;
  try {
    fd = fs.openSync(devPath, 'r');
  } catch (err) {
    return {
      available: false,
      device: devPath,
      reason: `No read permission on ${devPath} (${err.code || err.message}). Run: sudo usermod -aG input $USER`,
      stop: () => {},
    };
  }

  const detector = createScrewDetector(onRotate);
  const stream = fs.createReadStream(null, { fd, autoClose: true, highWaterMark: EVENT_SIZE * 32 });
  let leftover = Buffer.alloc(0);

  stream.on('data', (chunk) => {
    const buf = leftover.length ? Buffer.concat([leftover, chunk]) : chunk;
    let off = 0;
    while (off + EVENT_SIZE <= buf.length) {
      const type = buf.readUInt16LE(off + 16);
      const code = buf.readUInt16LE(off + 18);
      const value = buf.readInt32LE(off + 20);
      detector.feedEvent(type, code, value);
      off += EVENT_SIZE;
    }
    leftover = off < buf.length ? buf.subarray(off) : Buffer.alloc(0);
  });
  stream.on('error', () => { /* device disconnected or sleep */ });

  return {
    available: true,
    device: devPath,
    stop: () => { try { stream.destroy(); } catch { /* ignore */ } },
  };
}

module.exports = {
  EV_SYN,
  EV_KEY,
  EV_ABS,
  SYN_REPORT,
  BTN_TOOL_FINGER,
  BTN_TOUCH,
  BTN_TOOL_DOUBLETAP,
  BTN_TOOL_TRIPLETAP,
  BTN_TOOL_QUADTAP,
  ABS_MT_SLOT,
  ABS_MT_POSITION_X,
  ABS_MT_POSITION_Y,
  ABS_MT_TRACKING_ID,
  createScrewDetector,
  findTouchpadDevice,
  startTouchpadWatcher,
};
