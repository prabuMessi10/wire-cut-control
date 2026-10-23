# Wire Cut Control — ESP32 Firmware

Firmware for the automated wire-cutting machine, pairing with the MERN backend
in this repo (`server/src/services/esp32.js`). The backend POSTs each job to
the ESP32 over `POST /cut`, then **polls `GET /status` every ~300 ms** until it
sees `"state":"done"` (or `"error"`), so the firmware is built as a
**non-blocking state machine**: `POST /cut` validates and returns
`{"status":"started"}` instantly, and all motion happens incrementally in
`loop()` — the web server stays responsive the whole time and the task
watchdog is never starved.

Sketch: `WireCutControl/WireCutControl.ino` (open the folder in Arduino IDE).

---

## 1. Required libraries & installation

| Item                  | How to install                                                                 |
| --------------------- | ------------------------------------------------------------------------------ |
| **ESP32 board package** | Arduino IDE → *File → Preferences → Additional Boards Manager URLs* → add `https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json` → *Tools → Board → Boards Manager* → search **esp32** → install **esp32 by Espressif Systems**. |
| **ArduinoJson**         | *Tools → Manage Libraries* → search **ArduinoJson** → install **ArduinoJson by Benoit Blanchon** (v6 or v7 both work — the sketch auto-detects). |
| **Sketch**              | Copy the `WireCutControl` folder into your Arduino sketchbook, open `WireCutControl.ino`. |

**Build settings:** Board = `ESP32 Dev Module`, Upload speed = `921600`,
Flash size default. Baud for the Serial Monitor = `115200`.

After flashing, open **Serial Monitor (115200)** to see the boot diagnostics
and final IP address.

---

## 2. Wiring / pin summary

Edit the `PIN_*` constants at the top of the sketch to match your wiring.
(Default pins are examples — the numbering shown is for a classic ESP32 DevKit.)

| ESP32 GPIO | Sketch constant   | Connects to                                    | Notes                                      |
| ---------- | ----------------- | ---------------------------------------------- | ------------------------------------------ |
| GPIO 25    | `PIN_STEP`        | Stepper driver **STEP** (A4988 / TMC2209)      | Pulses per step                            |
| GPIO 26    | `PIN_DIR`         | Stepper driver **DIR**                         | `LOW` = feed direction (flip if reversed)  |
| GPIO 14    | `PIN_ENABLE`      | Stepper driver **EN**                          | **Active-LOW**: `LOW` = energised          |
| GPIO 27    | `PIN_CUTTER`      | Solenoid / relay (via MOSFET **or** opto)      | `HIGH` fires the cut; always returns LOW   |
| GPIO 34    | `PIN_LIMIT` *(optional)* | Limit/home switch (closes to GND)        | `INPUT_PULLUP`; not required — set `-1` to disable |

> ⚠️ **GPIO 25 and 26 are reserved for the stepper driver (STEP / DIR) and must
> not be reused for any other purpose** (e.g. the cutter — the cutter is on
> **GPIO 27**). Confirm against every `PIN_*` constant in `WireCutControl.ino`
> that no two constants share a GPIO. Also avoid the strapping pins (0, 2, 12,
> 15) and the input-only pins (34–39) for any output.

### SLEEP / RESET — driver enable
On most A4988/TMC2209 breakouts, **SLEEP and RESET must be jumpered together
(or both pulled HIGH)** or the driver stays in sleep mode and never moves a
motor — this is normally a **physical jumper** on the board, not a
software-controlled pin. If *your specific board* exposes SLEEP/RESET as
separate free pins (not hardwired/jumpered), set `PIN_SLEEP` / `PIN_RESET` in
the sketch to spare GPIOs and they are driven HIGH in `setup()`. **Verify
against the physical board's silkscreen labels** — the pin naming varies
between vendors, and feeding the wrong pin 3.3 V can damage the driver.

Stepper driver power (left to you, per driver):

- **A4988:** VMOT → motor-rail `+`, GND → motor-rail `GND`, connect `1A/1B/2A/2B`
  to the motor coil, and `VDD/GND` (logic side) to the ESP32's 3.3 V rail.
  Set the **microstep jumpers** (MS1/MS2/MS3) for your resolution — this is a
  multiplier in the `STEPS_PER_MM` formula (see §4).
- **TMC2209:** VCC → 3.3 V logic, VM → motor rail, EN pulled low to enable.

---

## 3. Power supply — read this before powering the motor ⚠️

**The stepper motor must use a SEPARATE power rail from the ESP32's own logic
supply, with the two grounds connected (common ground).**

- ESP32 (and driver logic side): 5 V from USB or a dedicated 5 V/3.3 V regulator.
- Stepper driver **motor side (VMOT/VCC + motor supply GND)**: a separate
  12–24 V supply **rated for the motor's running current** (e.g. 2 A+).
- **Never power the motor from the ESP32's 5 V pin.** Motor inrush can pull the
  board's 3.3 V rail below its minimum and cause a **brownout reset** mid-job —
  the exact restart the diagnostics below are designed to catch.
- Keep motor cabling short and add a **100–470 µF bulk capacitor** across the
  motor supply near the driver; a small decoupling cap (0.1 µF) across the
  ESP32 3.3 V to EN is also good practice.
- The cutter solenoid/relay is high-current too: drive it through a MOSFET
  (or relay module) fed from the **motor rail**, never straight from a GPIO.

---

## 4. Calibrating `STEPS_PER_MM` and `STEP_INTERVAL_US`

Both live at the top of the sketch under **“3. CALIBRATION”.**

### `STEPS_PER_MM` (feed accuracy)

1. Thread a test wire through the feeder and mark it right at the cutter blade.
2. Send a job with `length_mm = 500`, `qty = 1` (in the app: Settings → turn
   **Demo mode OFF**, set the ESP32 IP, then submit a 500 mm job).
3. Measure how much wire was *actually* fed.
4. Correct the constant:
   ```
   STEPS_PER_MM = old value × (requested 500 / measured length)
   ```
   e.g. request 500 mm, measure 486 mm → `STEPS_PER_MM *= 500/486`.
5. Repeat once — error should drop under 1 %.

Sanity-check formula (mechanical side):
```
STEPS_PER_MM = (motor steps per rev) × (microstepping) ÷ (mm of wire fed per rev)
```
e.g. `200 steps/rev × 16 microsteps ÷ 32 mm/rev = 100`.

### `STEP_INTERVAL_US` (feed speed)

Feed speed is roughly `1,000,000 ÷ (STEP_INTERVAL_US × STEPS_PER_MM)` mm/s
(e.g. `100` steps/mm and `300 µs` → ~33 mm/s). **Treat that as a ceiling, not
a promise:**

- **Too low (too fast) → skipped steps / motor stalling**, especially under
  load or with a long wire run. If you hear skips, raise the value (slow down).
- **Real loop() overhead** (WiFi + web-server handling, JSON parsing) makes the
  *actual* average rate somewhat **slower** than the raw math — the firmware
  catches up with bounded micro-bursts, but it will not beat the formula.
- **Always verify against a real timed job** (send a known `length_mm` × `qty`,
  time it, compare to the estimate the device prints) — never trust the formula
  alone on a calibrated machine.

There is also a **safety ceiling**: if a job's estimated duration would exceed
`JOB_MAX_RUNTIME_MS` (default 5 minutes), `POST /cut` rejects it with a 400
explaining what to change — the machine never silently runs for many minutes.

---

## 5. Reading the reset-reason diagnostic

On every boot the firmware prints, first thing:

```
[boot] reset reason: BROWNOUT (supply voltage dropped)
```

If the board ever restarts unexpectedly, this line tells you why. Table:

| Reason        | Meaning                                                            | Likely fix                                     |
| ------------- | ------------------------------------------------------------------ | ---------------------------------------------- |
| `POWERON`     | Normal power-up (also expected after re-flashing)                 | —                                              |
| `BROWNOUT`    | **3.3 V supply dropped** while running — classic motor-induced reset | Separate motor rail, bigger bulk cap (§3)      |
| `PANIC`       | Software crash (exception)                                          | Check the last serial log before the reboot    |
| `TASK_WDT` / `INT_WDT` / `WDT` | A task blocked too long                     | Should not happen with this firmware; if it does, an unexpected `delay()` crept in |
| `SW`          | Software restart (e.g. `ESP.restart()`)                             | —                                              |
| `DEEPSLEEP`   | Woke from deep sleep                                                 | —                                              |

The firmware also logs **every state transition** as `[state] a -> b` (e.g.
`[state] idle -> feeding`, `[state] feeding -> cutting`). This is the fastest
diagnostic there is: after you see the job-accepted `[cut]` line, the machine
*must* keep printing transition lines until `[state] cutting -> done`. If you
see the accept line followed by silence, the state machine is stuck — the
transition that should fire next is the one to investigate.

For a **brownout**, the firmware also prints explicit wiring advice at boot.
The device prints `[safety] STOP: <reason>` when it aborts a job safely (also
used if WiFi drops for more than `WIFI_ABORT_GRACE_MS` mid-job) — that abort
line in the serial log is your first stop when diagnosing a mid-job failure.

---

## 6. HTTP contract (what the backend expects)

| Endpoint      | Response                                                                    |
| ------------- | --------------------------------------------------------------------------- |
| `GET /status` | `200` → `{ "state":"idle\|feeding\|cutting\|done\|error", "busy":bool, "cycle":int, "cycles_total":int, "target_length_mm":float }` |
| `POST /cut`   | `202` → `{ "status":"started" }` (instant) · `409` → `{ "error":"device busy" }` · `400` → `{ "error":"<reason>" }` |
| `OPTIONS` any | `204` (CORS preflight)                                                       |

Every response (including errors) carries:
`Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods: GET, POST, OPTIONS`,
`Access-Control-Allow-Headers: Content-Type`.

The backend `POST /cut` has a **10 s** cap and `GET /status` polls run on a
**3 s** timeout — both are comfortably satisfied because `/cut` replies before
the job even starts and `/status` is served from inside the non-blocking loop.

---

## 7. Behaviour notes

- **“done” → “idle” handshake:** once all cycles finish the machine reports
  `"state":"done"`. As soon as a client has read that over `/status`, the
  machine returns to `idle` after a short hold (`DONE_HOLD_MS`).
- **Cycle semantics:** a `qty` of 5 means 5 feed-and-cut cycles; each piece is
  re-fed to `length_mm` before its cut.
- **WiFi drop mid-job:** the machine aborts safely (cutter de-energised,
  stepper disabled, `state:"error"`) after `WIFI_ABORT_GRACE_MS`, then keeps
  reconnecting from `loop()` without blocking.
- **Input validation** rejects bad length/qty with clear 400 messages before
  the machine is armed; a running job returns `409 device busy` rather than
  silently queueing a second job.
  