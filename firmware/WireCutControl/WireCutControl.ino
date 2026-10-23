/*
 * ============================================================================
 *  Wire Cut Control - ESP32 firmware
 * ============================================================================
 *  Automated wire-cutting machine controller. Pair with the existing MERN
 *  backend (server/src/services/esp32.js). The backend POSTs jobs to /cut,
 *  then polls /status every ~300 ms until "done" or "error" - this firmware
 *  must therefore NEVER block the web server for more than a few ms.
 *
 *  HTTP CONTRACT (do not change - the backend depends on it):
 *
 *    GET  /status
 *      -> 200, JSON: { "state": "idle"|"feeding"|"cutting"|"done"|"error",
 *                      "busy": true|false,
 *                      "cycle": <int>, "cycles_total": <int>,
 *                      "target_length_mm": <float> }
 *
 *    POST /cut
 *      body: { "length_mm": <float>, "qty": <int>, "gauge": <string>, "ref": <string> }
 *      -> 202, JSON: { "status": "started" }   (answered INSTANTLY, never after
 *                                               the job finishes)
 *      -> 409, JSON: { "error": "device busy" } if a job is already running
 *      -> 400, JSON: { "error": "<reason>" }    on invalid input
 *
 *    OPTIONS on any path -> 204. Every response (success AND error) carries:
 *      Access-Control-Allow-Origin:  *
 *      Access-Control-Allow-Methods: GET, POST, OPTIONS
 *      Access-Control-Allow-Headers: Content-Type
 *
 *  ARCHITECTURE: strict non-blocking state machine.
 *    - POST /cut validates + arms the job and returns immediately; all motion
 *      happens incrementally inside loop() -> processMachine(), a couple of
 *      microseconds at a time per iteration.
 *    - loop() keeps calling server.handleClient() every pass, so /status
 *      polling stays responsive and the ESP32 task watchdog is never starved.
 *    - Every state change goes through setState(), which logs a
 *      "[state] a -> b" line on each transition - a machine that stalls is
 *      visible in seconds on the Serial Monitor.
 *    - The only blocking calls in the motion path are delayMicroseconds(5) for
 *      the step pulse width - nothing longer.
 *
 *  Requires: ESP32 board package + ArduinoJson (Benoit Blanchon) v6 or v7.
 *  See firmware/README.md for wiring, calibration and power-supply notes.
 * ============================================================================
 */

#include <WiFi.h>
#include <WebServer.h>
#include <ArduinoJson.h>
#include "esp_system.h" // esp_reset_reason() - brownout/watchdog diagnostics

// ============================================================================
// 1. WIFI  (edit these)
// ============================================================================
const char* WIFI_SSID     = "Adidass";
const char* WIFI_PASSWORD = "12345678";
const uint32_t WIFI_RETRY_MS   = 5000UL; // how often to re-attempt in loop()
const uint32_t WIFI_ABORT_GRACE_MS = 3000UL; // disconnect must persist this long
                                             // before a running job is aborted

// ============================================================================
// 2. MACHINE LIMITS / VALIDATION
// ============================================================================
const float  MAX_LENGTH_MM = 2000.0f;          // reject anything longer
const int    MAX_QTY       = 200;              // reject anything larger
// Sane runtime ceiling per job: if the job's estimated duration (from the
// motor timing math below) would exceed this, it is rejected at validation
// time instead of silently occupying the machine for many minutes.
const uint32_t JOB_MAX_RUNTIME_MS = 5UL * 60UL * 1000UL; // 5 minutes

// ============================================================================
// 3. CALIBRATION - tune these, see README for the full procedure
// ============================================================================
// Motor steps required to feed exactly 1 mm of wire.
//
// HOW TO CALIBRATE (once the machine is wired):
//   1. Put a test wire through the feeder, mark it at the cutter blade.
//   2. Send a job with length_mm = 500, qty = 1 (or use the app's demo-off
//      mode with the ESP32 IP set in Settings).
//   3. Measure the length of wire that was actually fed.
//   4. New value = old value * (measured / 500). E.g. 500 mm requested but
//      486 mm fed  ->  STEPS_PER_MM *= 500/486.
//   5. Repeat once; the error should drop to < 1 %.
// The formula from the mechanical side (sanity check):
//   STEPS_PER_MM = (steps per motor rev) x (microstepping) / (mm fed per rev)
//   e.g. 200 steps/rev x 16 microsteps / 32 mm per rev = 100.
const float STEPS_PER_MM = 100.0f;

// Time between step-pulse edges in microseconds - this sets the feed speed:
//   feed speed mm/s = 1,000,000 / (STEP_INTERVAL_US x STEPS_PER_MM)
// With STEPS_PER_MM = 100 and STEP_INTERVAL_US = 300 that is ~33 mm/s.
//
// WARNING 1: setting this too low (fast) can cause skipped steps / stalling,
// especially under load. Raise it (slow down) if the machine skips.
// WARNING 2: real-world loop() overhead (WiFi + web-server handling, JSON
// parsing) makes the ACTUAL average rate slower than the raw math above. The
// firmware catches up with bounded micro-bursts, but under heavy /status
// polling the true rate may still be lower. Always verify with a real timed
// job rather than trusting the formula alone.
const uint32_t STEP_INTERVAL_US   = 300UL;
// Minimum width of the high pulse on the STEP pin (per A4988/TMC2209 datasheet
// a few microseconds are plenty). Keep this small.
const uint32_t STEP_PULSE_HIGH_US = 5UL;

// Cutter actuator (solenoid/relay) timing, in milliseconds:
//   CUTTER_PULSE_MS  - how long the cutter stays FIRED per cut
//   CUTTER_SETTLE_MS - pause after the cutter releases before feeding again
//   (so the blade clears the wire path before the next feed phase)
const uint32_t CUTTER_PULSE_MS  = 150UL;
const uint32_t CUTTER_SETTLE_MS = 250UL;

// How long the "done" state is held once a client has read it over /status
// before the machine returns to "idle" (prevents done/idle flapping from
// confusing quick polling clients).
const uint32_t DONE_HOLD_MS = 1500UL;

// ============================================================================
// 4. HARDWARE PINS  (edit to match your wiring - see README wiring table)
//
//  Pin map (ESP32-WROOM-32 DevKit):
//    GPIO25 -> PIN_STEP     stepper driver STEP
//    GPIO26 -> PIN_DIR      stepper driver DIR
//    GPIO14 -> PIN_ENABLE   stepper driver EN  (active-low)
//    GPIO27 -> PIN_CUTTER   cutter solenoid/relay
//    GPIO34 -> PIN_LIMIT    optional home switch (input-only pin)
//
//  GPIO 25 and 26 are consumed by the stepper driver (STEP/DIR) - do NOT
//  reuse them for any other purpose (e.g. the cutter lives on GPIO27).
//
//  Why GPIO27 for the cutter: usable, non-strapping, output-capable GPIOs on
//  this board are 4, 13, 16, 17, 18, 19, 21, 22, 23, 27, 32, 33. The rest are
//  off-limits: 0/2/12/15 are strapping pins (best left unloaded; GPIO5 is
//  also a strapping pin - keep it free too), 1/3 are UART0 TX/RX (reserved
//  for flashing + Serial Monitor), 6-11 are the SPI-flash lines, 20/24/28-31
//  are not exposed on this module, and 34-39 are input-only. GPIO27 is a
//  plain bidirectional GPIO with no boot-time strap function.
// ============================================================================
const int PIN_STEP   = 25; // stepper driver STEP  (A4988/TMC2209)
const int PIN_DIR    = 26; // stepper driver DIR   (LOW = feed direction)
const int PIN_ENABLE = 14; // stepper driver EN    (ACTIVE-LOW: LOW enables)
const int PIN_CUTTER = 27; // cutter solenoid/relay output (HIGH = fire)

// ---- SLEEP / RESET: driver enable (read this before wiring the driver) ----
// On most A4988/TMC2209 breakout boards, SLEEP and RESET must be jumpered
// together (or both pulled HIGH) or the driver stays in sleep mode and will
// NOT move a motor no matter what STEP/DIR/ENABLE do. This is normally a
// PHYSICAL JUMPER on the board - not a software-controlled pin - so no GPIO
// is consumed for it here by default.
//
// IF your specific drive board exposes SLEEP and RESET as separate free pins
// (i.e. they are NOT already hardwired/jumpered HIGH on the board), set the
// two constants below to spare GPIOs (e.g. 32 / 33). The firmware will then
// drive both HIGH in setup() alongside the other pin initialization, which
// takes the driver out of sleep mode. Verify against the PHYSICAL board's
// SILKSCREEN labels first - pin naming varies between vendors.
const int PIN_SLEEP = -1; // spare GPIO to drive HIGH for SLEEP, or -1 if jumpered/hardwired
const int PIN_RESET = -1; // spare GPIO to drive HIGH for RESET, or -1 if jumpered/hardwired

// OPTIONAL limit/home switch (digital input, INPUT_PULLUP, closes to GND).
// Not required for basic operation - this is a stub for future zero-
// referencing. If not wired, leave PIN_LIMIT = -1.
const int PIN_LIMIT  = 34; // GPIO34 (input-only on ESP32); or -1 to disable

// ============================================================================
// 5. WEB SERVER + MACHINE STATE
// ============================================================================
WebServer server(80);

enum MachineState {
  MS_IDLE,    // nothing running
  MS_FEEDING, // stepper feeding the target length
  MS_CUTTING, // cutter firing + settling, one cycle
  MS_DONE,    // job finished, waiting for a client to read the status
  MS_ERROR    // aborted (validation always rejects; ERROR only from safety)
};

MachineState state = MS_IDLE;
String errorReason = "";

// ---- job parameters (mirror the JSON contract) ----
float    targetLengthMm = 0.0f; // length per piece, in mm
int      cyclesTotal    = 0;    // == qty
int      cyclesDone     = 0;
uint32_t stepsPerFeed   = 0;    // steps per piece  = length_mm * STEPS_PER_MM
uint32_t stepsRemaining = 0;    // steps left in the current feed phase

// ---- motion timing ----
uint32_t lastStepUs      = 0;   // micros() accumulator for step pacing
uint32_t cutPhase        = 0;   // 0=idle 1=firing 2=settling (inside MS_CUTTING)
uint32_t cutPhaseStartMs = 0;   // millis() anchor for the cutter phase
uint32_t jobStartedAtMs  = 0;   // diagnostics only
bool     doneWasRead     = false;
uint32_t doneAckedMs     = 0;

// ---- wifi bookkeeping ----
uint32_t wifiLossSinceMs = 0;   // 0 = connected; else when loss started
uint32_t lastWifiRetryMs = 0;
bool     wifiWasDown     = false;

// ============================================================================
// Helpers - ALL state assignment goes through setState(), which is the single
// point that prints a "[state] a -> b" line on every transition. A machine
// that stalls shows up in one second of Serial Monitor: you see the job-accept
// line but no transition line after it.
// ============================================================================
const char* machineStateName(MachineState s) {
  switch (s) {
    case MS_IDLE:    return "idle";
    case MS_FEEDING: return "feeding";
    case MS_CUTTING: return "cutting";
    case MS_DONE:    return "done";
    case MS_ERROR:   return "error";
  }
  return "idle";
}

// Current state as a string, for the /status JSON body.
const char* stateStr() {
  return machineStateName(state);
}

bool isBusy() {
  return state == MS_FEEDING || state == MS_CUTTING;
}

int currentCycle() {
  switch (state) {
    case MS_FEEDING:
    case MS_CUTTING: return cyclesDone + 1;
    case MS_DONE:    return cyclesTotal;
    default:         return 0;
  }
}

// The ONLY way the machine state is ever changed. Logs every real transition
// (no-op when the value does not change, so the serial log shows exactly the
// machine's state timeline and cannot be spammed by re-entry).
void setState(MachineState s) {
  if (s == state) return; // guard: log only actual changes
  Serial.printf("[state] %s -> %s\n",
                machineStateName(state), machineStateName(s));
  state = s;
}

// Always de-energize the cutter and stepper on any stop path. This is the
// single choke point for every abort: cutter HIGH->LOW is guaranteed here.
void safetyStop(const char* why) {
  digitalWrite(PIN_CUTTER, LOW);   // NEVER leave the cutter fired
  digitalWrite(PIN_ENABLE, HIGH);  // EN is active-low -> HIGH = stepper off
  digitalWrite(PIN_STEP, LOW);
  setState(MS_ERROR);
  errorReason = why;
  Serial.printf("[safety] STOP: %s\n", why);
}

// One full step pulse (5 us) - the ONLY blocking call in the motion path.
inline void doStepPulse() {
  digitalWrite(PIN_STEP, HIGH);
  delayMicroseconds(STEP_PULSE_HIGH_US);
  digitalWrite(PIN_STEP, LOW);
}

// Enter the FEEDING phase. Called from two places: job arming in handleCut()
// and the between-cycles restart inside the MS_CUTTING case of
// processMachine(). The state transition lives HERE (not at the call sites)
// so both paths move the machine into MS_FEEDING - missing this was the bug
// where a freshly armed job sat in MS_IDLE forever and /status never left
// "idle". Any duplicate setState(MS_FEEDING) at the call sites would be a
// no-op, so keeping it in one place is safe.
void startFeed() {
  setState(MS_FEEDING);             // <-- state transition (the actual fix)
  digitalWrite(PIN_DIR, LOW);       // feed direction (flip if your wiring feeds backwards)
  digitalWrite(PIN_ENABLE, LOW);    // energize stepper (active-low)
  stepsRemaining = stepsPerFeed;
  lastStepUs = micros();
  Serial.printf("[job] feeding start: cycle %d/%d, %.1f mm, %u steps\n",
                cyclesDone + 1, cyclesTotal, (double)targetLengthMm, stepsPerFeed);
}

void resetJobParams() {
  targetLengthMm = 0.0f;
  cyclesTotal    = 0;
  cyclesDone     = 0;
  stepsPerFeed   = 0;
  stepsRemaining = 0;
  errorReason    = "";
}

// ============================================================================
// Incremental, non-blocking machine driver. Called every loop() iteration.
// Never blocks more than a handful of microseconds at a time.
//
// ---- DRY RUN: exact state-value sequence + counters (S = stepsPerFeed) ----
//
// qty=1 (cyclesTotal=1):
//   handleCut() -> startFeed()            [state] idle -> feeding   (S=stepsPerFeed, cyclesDone=0)
//   feed loop  ... S reaches 0            [state] feeding -> cutting
//   cutter fires (phase 0->1), releases (1->2), settle elapses:
//     cyclesDone++ -> 1 >= 1              [state] cutting -> done    (S=0, cyclesDone=1)
//   /status read (doneWasRead=true) + DONE_HOLD_MS passes
//                                         [state] done -> idle       (job params reset)
//
// qty=3 (cyclesTotal=3):
//   handleCut() -> startFeed()            [state] idle -> feeding   (S=stepsPerFeed, cyclesDone=0)
//   feed done                             [state] feeding -> cutting (cycle 1)
//   settle: cyclesDone++ -> 1 < 3 -> startFeed()
//                                         [state] cutting -> feeding (S reset to stepsPerFeed, cyclesDone=1)
//   feed done                             [state] feeding -> cutting (cycle 2)
//   settle: cyclesDone++ -> 2 < 3 -> startFeed()
//                                         [state] cutting -> feeding (cyclesDone=2)
//   feed done                             [state] feeding -> cutting (cycle 3)
//   settle: cyclesDone++ -> 3 >= 3        [state] cutting -> done    (S=0, cyclesDone=3)
//   /status read + DONE_HOLD_MS           [state] done -> idle
//
// any busy state + WiFi loss > grace:
//   loop() -> safetyStop()                [state] X -> error (cutter LOW, stepper OFF)
// ============================================================================
void processMachine() {
  switch (state) {
    case MS_FEEDING: {
      // Step with a bounded catch-up burst so a slow loop iteration (WiFi /
      // web-server work) does not drop the average rate. Cap at 8 pulses per
      // iteration -> worst case ~40 us of blocking, always chainable.
      uint32_t now = micros();
      int bursts = 0;
      while (stepsRemaining > 0 &&
             (int32_t)(now - lastStepUs) >= (int32_t)STEP_INTERVAL_US &&
             bursts < 8) {
        lastStepUs += STEP_INTERVAL_US;
        doStepPulse();
        stepsRemaining--;
        bursts++;
      }
      if (stepsRemaining == 0) {
        // Feed complete for this piece - arm the cutter.
        cutPhase = 0;
        setState(MS_CUTTING);
      }
      break;
    }

    case MS_CUTTING: {
      uint32_t elapsed = millis() - cutPhaseStartMs;
      if (cutPhase == 0) {
        // Fire: energize the cutter (solenoid/relay).
        digitalWrite(PIN_CUTTER, HIGH);
        cutPhase = 1;
        cutPhaseStartMs = millis();
        Serial.printf("[job] cutting cycle %d/%d (pulse %u ms)\n",
                      cyclesDone + 1, cyclesTotal, CUTTER_PULSE_MS);
      } else if (cutPhase == 1 && elapsed >= CUTTER_PULSE_MS) {
        // Release: always de-energize the cutter.
        digitalWrite(PIN_CUTTER, LOW);
        cutPhase = 2;
        cutPhaseStartMs = millis();
      } else if (cutPhase == 2 && elapsed >= CUTTER_SETTLE_MS) {
        cyclesDone++;
        if (cyclesDone >= cyclesTotal) {
          digitalWrite(PIN_CUTTER, LOW);      // belt-and-braces
          digitalWrite(PIN_ENABLE, HIGH);     // stepper off until next job
          setState(MS_DONE);
          doneWasRead = false;
          Serial.println("[job] Job complete.");
        } else {
          startFeed(); // feed the next piece (startFeed() sets state -> feeding)
        }
      }
      break;
    }

    case MS_DONE: {
      // Back to IDLE once a client has read the "done" status (plus a short
      // hold so quick pollers settle on a stable "done" for >= 1 response).
      if (doneWasRead && (millis() - doneAckedMs >= DONE_HOLD_MS)) {
        setState(MS_IDLE);
        resetJobParams();
      }
      break;
    }

    case MS_IDLE:
    case MS_ERROR:
    default:
      break; // nothing to do
  }
}

// ============================================================================
// CORS headers - must be present on EVERY response, including errors.
// ============================================================================
void sendCorsHeaders() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type");
}

// ============================================================================
// GET /status
// ============================================================================
void handleStatus() {
  sendCorsHeaders();
  char body[192];
  snprintf(body, sizeof(body),
           "{\"state\":\"%s\",\"busy\":%s,\"cycle\":%d,\"cycles_total\":%d,"
           "\"target_length_mm\":%.2f}",
           stateStr(),
           isBusy() ? "true" : "false",
           currentCycle(),
           cyclesTotal,
           (double)targetLengthMm);
  server.send(200, "application/json", body);

  // DONE -> IDLE handshake: acknowledge that a client has read the result.
  if (state == MS_DONE) {
    doneWasRead = true;
    doneAckedMs = millis();
  }
}

// ============================================================================
// POST /cut  - validate, arm, reply instantly.
// ============================================================================
void handleCut() {
  sendCorsHeaders();

  // 409 first: never queue silently into an ongoing job.
  if (isBusy()) {
    server.send(409, "application/json", "{\"error\":\"device busy\"}");
    return;
  }

  String body = server.arg("plain");
  if (body.length() == 0) {
    server.send(400, "application/json", "{\"error\":\"missing JSON body\"}");
    return;
  }

  // Parse with ArduinoJson - works on v6 (DynamicJsonDocument) and v7
  // (sized JsonDocument) without further changes.
#if ARDUINOJSON_VERSION_MAJOR >= 7
  JsonDocument doc;
#else
  DynamicJsonDocument doc(1024);
#endif
  DeserializationError err = deserializeJson(doc, body);
  if (err) {
    server.send(400, "application/json", "{\"error\":\"invalid JSON body\"}");
    return;
  }

  float lengthMm = doc["length_mm"].as<float>();
  String gauge = doc["gauge"] | "";
  String ref   = doc["ref"] | "";

  // Print every received job for diagnostics (this handler is not in the
  // tight timing loop, so printing here is safe).
  Serial.printf("[cut] REQUEST length_mm=%.1f qty=%d gauge=\"%s\" ref=\"%s\"\n",
                (double)lengthMm, doc["qty"].as<int>(), gauge.c_str(), ref.c_str());

  // ---- validation (reject before arming) ----
  if (isnan(lengthMm) || lengthMm <= 0.0f) {
    server.send(400, "application/json",
                "{\"error\":\"length_mm must be a number greater than 0\"}");
    return;
  }
  if (lengthMm > MAX_LENGTH_MM) {
    char msg[96];
    snprintf(msg, sizeof(msg),
             "{\"error\":\"length_mm exceeds maximum of %.0f mm\"}", (double)MAX_LENGTH_MM);
    server.send(400, "application/json", msg);
    return;
  }

  if (!doc["qty"].is<int>()) {
    server.send(400, "application/json",
                "{\"error\":\"qty must be a whole number (integer)\"}");
    return;
  }
  int qty = doc["qty"].as<int>();
  if (qty < 1 || qty > MAX_QTY) {
    char msg[96];
    snprintf(msg, sizeof(msg),
             "{\"error\":\"qty must be between 1 and %d\"}", MAX_QTY);
    server.send(400, "application/json", msg);
    return;
  }

  // ---- safety: maximum expected runtime ceiling ----
  uint32_t totalSteps = (uint32_t)(lengthMm * STEPS_PER_MM) * (uint32_t)qty;
  uint64_t estUs =
      (uint64_t)totalSteps * STEP_INTERVAL_US +
      (uint64_t)qty * ((uint64_t)CUTTER_PULSE_MS + CUTTER_SETTLE_MS) * 1000ULL;
  if (estUs > (uint64_t)JOB_MAX_RUNTIME_MS * 1000ULL) {
    char msg[160];
    snprintf(msg, sizeof(msg),
             "{\"error\":\"job would take ~%llu s but max is %lu s: reduce "
             "length/qty or raise STEP_INTERVAL_US\"}",
             (unsigned long long)(estUs / 1000000ULL),
             (unsigned long)(JOB_MAX_RUNTIME_MS / 1000UL));
    server.send(400, "application/json", msg);
    return;
  }

  // ---- arm the machine and reply immediately ----
  targetLengthMm = lengthMm;
  cyclesTotal    = qty;
  cyclesDone     = 0;
  stepsPerFeed   = (uint32_t)(lengthMm * STEPS_PER_MM);
  stepsRemaining = 0;
  jobStartedAtMs = millis();
  errorReason    = "";
  startFeed();
  Serial.printf("[cut] job accepted: %.1f mm x %d pcs = %u steps, est ~%llu s\n",
                (double)lengthMm, qty, (uint32_t)totalSteps,
                (unsigned long long)(estUs / 1000000ULL));

  // 202 + {"status":"started"} - never block until the job ends.
  server.send(202, "application/json", "{\"status\":\"started\"}");
}

// ============================================================================
// OPTIONS / catch-all: OPTIONS must answer 204 with CORS headers on any path.
// ============================================================================
void handleNotFound() {
  sendCorsHeaders();
  if (server.method() == HTTP_OPTIONS) {
    server.send(204); // preflight: no body
    return;
  }
  server.send(404, "application/json", "{\"error\":\"not found\"}");
}

// ============================================================================
// Boot + reset-reason diagnostics
// ============================================================================
const char* resetReasonStr(esp_reset_reason_t r) {
  switch (r) {
    case ESP_RST_UNKNOWN:    return "UNKNOWN";
    case ESP_RST_POWERON:    return "POWERON";
    case ESP_RST_EXT:        return "EXT (external pin)";
    case ESP_RST_SW:         return "SW (software restart)";
    case ESP_RST_PANIC:      return "PANIC (crash)";
    case ESP_RST_INT_WDT:    return "INT_WDT (interrupt watchdog)";
    case ESP_RST_TASK_WDT:   return "TASK_WDT (task watchdog)";
    case ESP_RST_WDT:        return "WDT (watchdog)";
    case ESP_RST_DEEPSLEEP:  return "DEEPSLEEP";
    case ESP_RST_BROWNOUT:   return "BROWNOUT (supply voltage dropped)";
    case ESP_RST_SDIO:       return "SDIO";
    default:                 return "OTHER";
  }
}

void printResetReason() {
  esp_reset_reason_t r = esp_reset_reason();
  Serial.printf("[boot] reset reason: %s\n", resetReasonStr(r));
  if (r == ESP_RST_BROWNOUT) {
    Serial.println("[boot]   ^^ BROWNOUT: the 3.3V supply dropped out while running.");
    Serial.println("[boot]      The stepper motor MUST be powered from a separate rail");
    Serial.println("[boot]      with a common ground - see firmware/README.md power section.");
  }
  if (r == ESP_RST_PANIC || r == ESP_RST_TASK_WDT || r == ESP_RST_INT_WDT) {
    Serial.println("[boot]   ^^ A crash/watchdog reset - check the previous serial log");
    Serial.println("[boot]      for the abort message (often a motor-induced brownout).");
  }
}

// ============================================================================
// WiFi: connect at boot, then keep the link alive without ever blocking loop()
// ============================================================================
void setupWiFi() {
  Serial.printf("[wifi] connecting to \"%s\"", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  // Boot-time connect may block briefly (max ~15 s) - acceptable at startup.
  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED && (millis() - t0) < 15000UL) {
    delay(250);
    Serial.print(".");
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\n[wifi] connected, IP: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("\n[wifi] connect failed - will keep retrying in loop()");
  }
}

void maintainWifi() {
  if (WiFi.status() == WL_CONNECTED) {
    wifiLossSinceMs = 0;
    if (wifiWasDown) {
      wifiWasDown = false;
      Serial.printf("[wifi] reconnected, IP: ");
      Serial.println(WiFi.localIP());
    }
    return;
  }

  wifiWasDown = true;
  if (wifiLossSinceMs == 0) wifiLossSinceMs = millis();

  uint32_t now = millis();
  if (now - lastWifiRetryMs >= WIFI_RETRY_MS) {
    lastWifiRetryMs = now;
    Serial.println("[wifi] disconnected - attempting reconnect (non-blocking)…");
    WiFi.disconnect();
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  }
}

// ============================================================================
// Optional limit/home switch stub (future zero-referencing).
// ============================================================================
inline bool readLimitSwitch() {
  if (PIN_LIMIT < 0) return false;
  return digitalRead(PIN_LIMIT) == LOW; // closes to GND -> LOW
}

// ============================================================================
void setup() {
  Serial.begin(115200);
  delay(100); // let the USB-serial bridge settle
  Serial.println();
  Serial.println("=======================================");
  Serial.println(" Wire Cut Control ESP32 - boot");
  Serial.println("=======================================");
  printResetReason();
  Serial.printf("[boot] chip: %s, SDK %s, flash %u KB\n",
                ESP.getChipModel(), ESP.getSdkVersion(), ESP.getFlashChipSize() / 1024);
  Serial.printf("[boot] MAC: %s\n", WiFi.macAddress().c_str());

  // ---- pins: safe power-down defaults before enabling motion ----
  pinMode(PIN_STEP, OUTPUT);
  pinMode(PIN_DIR, OUTPUT);
  pinMode(PIN_ENABLE, OUTPUT);
  pinMode(PIN_CUTTER, OUTPUT);
  digitalWrite(PIN_STEP, LOW);
  digitalWrite(PIN_DIR, LOW);
  digitalWrite(PIN_ENABLE, HIGH); // stepper disabled (active-low)
  digitalWrite(PIN_CUTTER, LOW);  // cutter de-energized

  // ---- SLEEP/RESET: normally jumpered HIGH on the breakout board (physical
  // jumper, see section 4). If this specific board exposes them as separate
  // pins, set PIN_SLEEP/PIN_RESET above to spare GPIOs and they are driven
  // HIGH here so the driver exits sleep mode before any motion is possible.
  if (PIN_SLEEP >= 0) {
    pinMode(PIN_SLEEP, OUTPUT);
    digitalWrite(PIN_SLEEP, HIGH);
    Serial.printf("[boot] driver SLEEP pin: GPIO%d driven HIGH\n", PIN_SLEEP);
  } else {
    Serial.println("[boot] driver SLEEP pin: -1 (physical jumper assumed HIGH)");
  }
  if (PIN_RESET >= 0) {
    pinMode(PIN_RESET, OUTPUT);
    digitalWrite(PIN_RESET, HIGH);
    Serial.printf("[boot] driver RESET pin: GPIO%d driven HIGH\n", PIN_RESET);
  } else {
    Serial.println("[boot] driver RESET pin: -1 (physical jumper assumed HIGH)");
  }

  if (PIN_LIMIT >= 0) {
    pinMode(PIN_LIMIT, INPUT_PULLUP);
    Serial.printf("[boot] limit switch: configured on GPIO%d (trip=%s)\n",
                  PIN_LIMIT, readLimitSwitch() ? "ACTIVE" : "clear");
  } else {
    Serial.println("[boot] limit switch: disabled (PIN_LIMIT = -1)");
  }

  Serial.printf("[boot] calibration: STEPS_PER_MM=%.1f, STEP_INTERVAL_US=%lu "
                "(~%.1f mm/s max feed)\n",
                (double)STEPS_PER_MM, (unsigned long)STEP_INTERVAL_US,
                (double)(1000000.0 / ((double)STEP_INTERVAL_US * STEPS_PER_MM)));

  setupWiFi();

  // ---- HTTP routes ----
  server.on("/status", HTTP_GET, handleStatus);
  server.on("/cut", HTTP_POST, handleCut);
  server.onNotFound(handleNotFound); // handles OPTIONS (204) on every path
  server.begin();
  Serial.println("[http] server ready on port 80");
  Serial.println("       GET  /status   -> machine state");
  Serial.println("       POST /cut      -> {length_mm, qty, gauge, ref}");
  Serial.println("----------------------------------------");
  delay(10);
}

// ============================================================================
void loop() {
  // 1. Keep the radio alive; a persistent loss aborts a running job safely.
  maintainWifi();
  if (isBusy() && wifiLossSinceMs != 0 &&
      (millis() - wifiLossSinceMs) >= WIFI_ABORT_GRACE_MS) {
    safetyStop("WiFi disconnected during job (grace period exceeded)");
  }

  // 2. Serve HTTP - stays responsive during motion because processMachine()
  //    below never blocks for more than ~40 us at a time.
  server.handleClient();

  // 3. Advance the state machine a little bit per iteration.
  processMachine();
}