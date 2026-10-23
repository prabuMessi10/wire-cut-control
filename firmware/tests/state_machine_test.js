/*
 * ============================================================================
 *  Host-side state-machine harness for WireCutControl.ino
 * ============================================================================
 *  Mirrors the C++ function bodies in the sketch VERBATIM (same constants,
 *  same transition logic) with Arduino I/O stubbed out, so we can actually
 *  execute the state machine on this machine (no Arduino toolchain here).
 *  Run with:  node firmware/tests/state_machine_test.js
 *
 *  The only deviation from the sketch: the two `startFeed()` call sites go
 *  through an indirection (startFeedFn) so the harness can also compile the
 *  OLD buggy implementation for the regression test. In the sketch both call
 *  sites share the same compiled function, exactly as modeled here.
 *
 *  Verifies:
 *   A. qty=1 full run: idle -> feeding -> cutting -> done -> idle (after a
 *      /status read) with correct stepsRemaining / cyclesDone at each step.
 *   B. qty=3 full run: feed/cut repeats per cycle, ends done, cyclesDone==3,
 *      cycle counter walks 1..3, startFeed ran exactly 3 times.
 *   C. POST /cut semantics: 202 "started" replies with zero motion consumed
 *      (reply-before-motion), and the next request gets 409 "device busy"
 *      because isBusy() is true right after arming.
 *   D. Regression: the OLD startFeed (no setState) never leaves idle AND a
 *      second job slips through as 202 - proving the bug and the diagnostic.
 *   E. safetyStop: busy -> error, cutter forced LOW, stepper off.
 *   F. setState no-op guard: no log spam, state unchanged.
 *   G. "done" persists until a client reads /status (backend relies on it).
 * ============================================================================
 */

'use strict';

// ---- constants copied from the .ino (sections 2 + 3) ----
const STEPS_PER_MM = 100.0;
const STEP_INTERVAL_US = 300;
const STEP_PULSE_HIGH_US = 5;
const CUTTER_PULSE_MS = 150;
const CUTTER_SETTLE_MS = 250;
const DONE_HOLD_MS = 1500;

// ---- enum copied from the .ino ----
const MS = { IDLE: 0, FEEDING: 1, CUTTING: 2, DONE: 3, ERROR: 4 };

// ---- machine globals (same names as the sketch) ----
let state = MS.IDLE;
let errorReason = '';
let targetLengthMm = 0.0, cyclesTotal = 0, cyclesDone = 0;
let stepsPerFeed = 0, stepsRemaining = 0;
let lastStepUs = 0, cutPhase = 0, cutPhaseStartMs = 0, jobStartedAtMs = 0;
let doneWasRead = false, doneAckedMs = 0;

// ---- Arduino stubs ----
let simUs = 0, simMs = 0;
let pinStep = 0, pinDir = 0, pinEnable = 1, pinCutter = 0;
const logs = [];
function micros() { return simUs; }
function millis() { return simMs; }
function delayMicroseconds(us) { simUs += us; }
function digitalWrite(pin, v) {
  if (pin === 'STEP') pinStep = v;
  else if (pin === 'DIR') pinDir = v;
  else if (pin === 'EN') pinEnable = v;
  else if (pin === 'CUTTER') pinCutter = v;
}
// tiny sprintf for exactly the formats the sketch uses
function S(fmt, ...a) {
  let i = 0;
  const out = fmt.replace(/%[sdu]|%llu|%lu|%.\d+f|%%/g, (m) => {
    if (m === '%%') return '%';
    const v = a[i++];
    if (m === '%s') return String(v);
    if (m === '%d' || m === '%u' || m === '%lu' || m === '%llu') return String(v);
    if (/^%\.\d+f$/.test(m)) return Number(v).toFixed(Number(m.slice(2, -1)));
    return m;
  });
  logs.push(out);
  process.stdout.write(out); // stream like Serial.printf
}

// ============================================================================
// Verbatim function bodies from the fixed .ino
// ============================================================================
function machineStateName(s) {
  switch (s) {
    case MS.IDLE: return 'idle';
    case MS.FEEDING: return 'feeding';
    case MS.CUTTING: return 'cutting';
    case MS.DONE: return 'done';
    case MS.ERROR: return 'error';
  }
  return 'idle';
}
function stateStr() { return machineStateName(state); }
function isBusy() { return state === MS.FEEDING || state === MS.CUTTING; }
function currentCycle() {
  switch (state) {
    case MS.FEEDING:
    case MS.CUTTING: return cyclesDone + 1;
    case MS.DONE: return cyclesTotal;
    default: return 0;
  }
}
function setState(s) {
  if (s === state) return; // no-op guard
  S('[state] %s -> %s\n', machineStateName(state), machineStateName(s));
  state = s;
}
function safetyStop(why) {
  digitalWrite('CUTTER', 0);  // never leave the cutter fired
  digitalWrite('EN', 1);      // active-low -> 1 = stepper off
  digitalWrite('STEP', 0);
  setState(MS.ERROR);
  errorReason = why;
  S('[safety] STOP: %s\n', why);
}
function doStepPulse() {
  digitalWrite('STEP', 1);
  delayMicroseconds(STEP_PULSE_HIGH_US);
  digitalWrite('STEP', 0);
}
// startFeed = the FIXED implementation (setState lives here so both the arm
// path and the between-cycles restart move the machine into FEEDING).
function startFeed() {
  setState(MS.FEEDING);
  digitalWrite('DIR', 0);
  digitalWrite('EN', 0);
  stepsRemaining = stepsPerFeed;
  lastStepUs = micros();
  S('[job] feeding start: cycle %d/%d, %.1f mm, %u steps\n',
    cyclesDone + 1, cyclesTotal, targetLengthMm, stepsPerFeed);
}
// the OLD buggy implementation (no setState) - used by the regression test
function startFeedBuggy() {
  digitalWrite('DIR', 0);
  digitalWrite('EN', 0);
  stepsRemaining = stepsPerFeed;
  lastStepUs = micros();
  S('[job] feeding start: cycle %d/%d, %.1f mm, %u steps\n',
    cyclesDone + 1, cyclesTotal, targetLengthMm, stepsPerFeed);
}
let startFeedFn = startFeed; // indirection used at BOTH call sites (see header)
function resetJobParams() {
  targetLengthMm = 0.0; cyclesTotal = 0; cyclesDone = 0;
  stepsPerFeed = 0; stepsRemaining = 0; errorReason = '';
}
function processMachine() {
  switch (state) {
    case MS.FEEDING: {
      const now = micros();
      let bursts = 0;
      while (stepsRemaining > 0 &&
             (now - lastStepUs) >= STEP_INTERVAL_US &&
             bursts < 8) {
        lastStepUs += STEP_INTERVAL_US;
        doStepPulse();
        stepsRemaining--;
        bursts++;
      }
      if (stepsRemaining === 0) {
        cutPhase = 0;
        setState(MS.CUTTING);
      }
      break;
    }
    case MS.CUTTING: {
      const elapsed = millis() - cutPhaseStartMs;
      if (cutPhase === 0) {
        digitalWrite('CUTTER', 1);
        cutPhase = 1;
        cutPhaseStartMs = millis();
        S('[job] cutting cycle %d/%d (pulse %u ms)\n',
          cyclesDone + 1, cyclesTotal, CUTTER_PULSE_MS);
      } else if (cutPhase === 1 && elapsed >= CUTTER_PULSE_MS) {
        digitalWrite('CUTTER', 0);
        cutPhase = 2;
        cutPhaseStartMs = millis();
      } else if (cutPhase === 2 && elapsed >= CUTTER_SETTLE_MS) {
        cyclesDone++;
        if (cyclesDone >= cyclesTotal) {
          digitalWrite('CUTTER', 0);
          digitalWrite('EN', 1);
          setState(MS.DONE);
          doneWasRead = false;
          S('[job] Job complete.\n');
        } else {
          startFeedFn(); // feed the next piece (startFeed sets state -> feeding)
        }
      }
      break;
    }
    case MS.DONE: {
      if (doneWasRead && (millis() - doneAckedMs >= DONE_HOLD_MS)) {
        setState(MS.IDLE);
        resetJobParams();
      }
      break;
    }
    case MS.IDLE:
    case MS.ERROR:
    default:
      break;
  }
}
// the part of handleStatus() that matters here: DONE -> IDLE handshake
function handleStatusRead() {
  if (state === MS.DONE) { doneWasRead = true; doneAckedMs = millis(); }
}
// handleCut() with busy pre-check + arming (validation elided for valid input)
function apiCut(lengthMm, qty) {
  if (isBusy()) return { status: 409, body: { error: 'device busy' } };
  targetLengthMm = lengthMm;
  cyclesTotal = qty;
  cyclesDone = 0;
  stepsPerFeed = Math.round(lengthMm * STEPS_PER_MM);
  stepsRemaining = 0;
  jobStartedAtMs = millis();
  errorReason = '';
  startFeedFn();
  return { status: 202, body: { status: 'started' } };
}
// one virtual loop() pass (~1 ms of machine time: wifi + handleClient +
// processMachine - same advance pattern a real loop sees)
function loopPass() { simMs += 1; simUs += 1000; processMachine(); }
function runUntil(test, maxPasses = 200000) {
  for (let i = 0; i < maxPasses; i++) { loopPass(); if (test()) return i; }
  throw new Error('runUntil: condition never became true (machine stuck?)');
}
function resetAll(buggy) {
  state = MS.IDLE; errorReason = '';
  targetLengthMm = 0; cyclesTotal = 0; cyclesDone = 0;
  stepsPerFeed = 0; stepsRemaining = 0;
  lastStepUs = 0; cutPhase = 0; cutPhaseStartMs = 0; jobStartedAtMs = 0;
  doneWasRead = false; doneAckedMs = 0;
  simUs = 0; simMs = 0;
  pinStep = 0; pinDir = 0; pinEnable = 1; pinCutter = 0;
  logs.length = 0;
  startFeedFn = buggy ? startFeedBuggy : startFeed;
}

// ---- mini test harness ----
let failures = 0;
function check(cond, label) {
  S('%s %s', cond ? '  [PASS]' : '  [FAIL]', label);
  if (!cond) failures++;
}

S('============================================================');
S(' WireCutControl state-machine harness (mirrors fixed .ino)');
S('============================================================');

S('\n==== TEST D: regression - OLD buggy startFeed (no state set) ====');
resetAll(true);
let r1 = apiCut(5, 1);
check(r1.status === 202, 'buggy: first POST /cut still returned 202');
for (let i = 0; i < 50; i++) loopPass(); // let time pass, as on hardware
check(state === MS.IDLE, 'buggy: machine stuck in idle (motor never moves)');
const r2 = apiCut(5, 1);
check(r2.status === 202, 'buggy: second POST wrongly accepted too (409 missing)');
const buggyTransitions = logs.filter(l => l.startsWith('[state]')).length;
check(buggyTransitions === 0,
      'buggy: ZERO [state] transition lines despite job accepted - this is the exact diagnostic gap');

S('\n==== TEST A: qty=1 full run on the FIXED firmware ====');
resetAll(false);
r1 = apiCut(5, 1);
check(r1.status === 202 && r1.body.status === 'started', 'POST /cut -> 202 {status:started}');
check(isBusy(), 'isBusy() true immediately after arming (409 will fire)');
check(stepsRemaining === stepsPerFeed,
      'zero motion consumed at reply time -> 202 is returned before any motion');
const r3 = apiCut(5, 1);
check(r3.status === 409 && r3.body.error === 'device busy', 'second POST while busy -> 409');
check(currentCycle() === 1, 'cycle == 1 while feeding cycle 1/1');
runUntil(() => state === MS.DONE);
check(state === MS.DONE, 'reached done');
check(cyclesDone === 1, 'cyclesDone == 1 at done');
check(stepsRemaining === 0, 'stepsRemaining == 0 at done');
check(pinCutter === 0, 'cutter de-energized at done');
check(pinEnable === 1, 'stepper de-energized at done');
for (let i = 0; i < 5000; i++) loopPass();
check(state === MS.DONE, 'done persists while no client has read /status (backend poll wins)');
handleStatusRead();
runUntil(() => state === MS.IDLE);
check(state === MS.IDLE, 'done -> idle after /status read + DONE_HOLD_MS');
check(cyclesTotal === 0 && targetLengthMm === 0.0, 'job params reset on idle');
const seqA = logs.filter(l => l.startsWith('[state]')).map(l => l.trim().replace(/^\[state\] /, ''));
S('  transition trace (qty=1): %s', seqA.join(' | '));
check(seqA.join('|') ===
      'idle -> feeding|feeding -> cutting|cutting -> done|done -> idle',
      'exact qty=1 transition sequence');

S('\n==== TEST B: qty=3 full run on the FIXED firmware ====');
resetAll(false);
r1 = apiCut(3, 3);
check(r1.status === 202, 'qty=3 job accepted (202)');
const cyclesSeen = [];
while (state !== MS.DONE) {
  if (state === MS.FEEDING) cyclesSeen.push(currentCycle());
  if (simMs > 20000) throw new Error('qty=3 run did not finish in time');
  loopPass();
}
check(cyclesDone === 3, 'cyclesDone == 3 at done');
check(currentCycle() === 3, 'cycle == 3 at done');
const uniq = [...new Set(cyclesSeen)];
check([1, 2, 3].every(c => uniq.includes(c)),
      'currentCycle() walked 1..3 across feed phases [' + uniq.join(',') + ']');
check(stepsRemaining === 0, 'stepsRemaining == 0 at done (no leaked steps)');
const feedEntries = logs.filter(l => l.startsWith('[job] feeding start')).length;
check(feedEntries === 3, 'startFeed ran exactly 3x for qty=3 (arm + 2 restarts)');
const seqB = logs.filter(l => l.startsWith('[state]')).map(l => l.trim().replace(/^\[state\] /, ''));
S('  transition trace (qty=3): %s', seqB.join(' | '));
check(seqB.join('|') ===
      'idle -> feeding|feeding -> cutting|cutting -> feeding|feeding -> cutting|cutting -> feeding|feeding -> cutting|cutting -> done',
      'exact qty=3 transition sequence (3 feeds, 3 cuts)');
check(pinCutter === 0 && pinEnable === 1, 'pins safe at done');
handleStatusRead();
runUntil(() => state === MS.IDLE);
check(state === MS.IDLE, 'qty=3: done -> idle after read + hold');

S('\n==== TEST E: safetyStop (WiFi-loss abort) ====');
resetAll(false);
apiCut(5, 1);
runUntil(() => state === MS.FEEDING);
safetyStop('WiFi disconnected during job (grace period exceeded)');
check(state === MS.ERROR, 'busy -> error on safety stop');
check(pinCutter === 0, 'cutter forced LOW on abort');
check(pinEnable === 1, 'stepper de-energized on abort');
check(!isBusy(), 'isBusy() false in error (new job allowed)');
check(errorReason.length > 0, 'error reason recorded');
const lastE = logs.filter(l => l.startsWith('[state]')).map(l => l.trim().replace(/^\[state\] /, '')).pop();
check(lastE === 'feeding -> error', 'transition log shows feeding -> error');
const r4 = apiCut(2, 1);
check(r4.status === 202, 'new job accepted after error (202)');

S('\n==== TEST F: setState no-op guard ====');
resetAll(false);
const before = logs.filter(l => l.startsWith('[state]')).length;
setState(MS.IDLE); setState(MS.IDLE); setState(MS.IDLE);
const after = logs.filter(l => l.startsWith('[state]')).length;
check(before === after && state === MS.IDLE,
      'three setState(IDLE) on idle: no log spam, no change');

S('\n==== TEST C: 409 window FIXED while mid-CUTTING ====');
resetAll(false);
apiCut(20, 1);
runUntil(() => state === MS.CUTTING);
check(apiCut(20, 1).status === 409, '409 while CUTTING');

S('\n==== summary ====');
S('failures: %d', failures);
process.exit(failures ? 1 : 0);