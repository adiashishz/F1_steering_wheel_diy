/**
 * ControlLoop — what runs 100×/sec.
 *
 *   FixedRateLoop tick
 *     → buildFrame(sensor)          read inputs
 *     → AxisProcessor ×2            roll → steering, pitch → pedal tilt (−1 brake … +1 throttle)
 *     → ControllerState             steering (or a held test chip) + touch pads (+ gyro pedals if on)
 *                                   + exclusivity
 *     → output.send(state, armed)   the §15 seam — loopback now, ESP32 later
 *     → write LiveState + bump()    so the UI can show it
 *
 * Pedals come from the touch pads, plus pitch when `pedals.gyro` is on. The
 * three proper control modes (which input drives which pedal) come in Phase 10.
 *
 * Starts DISARMED (plan.md §19.1). While disarmed the state is still sent every
 * tick with armed=false, so the output stays in step and arming is instant.
 *
 * A stale or missing gyro reading NEVER steers: output goes to 0, and smoothing
 * is reset when readings come back so nothing glides in from an old value.
 *
 * ─── HOT PATH RULES ─────────────────────────────────────────────────────────
 *   No React. No DOM. No allocation per tick: no object/array literals,
 *   no .map/.filter, no spreads, no new closures. Mutate the objects we own.
 * ─────────────────────────────────────────────────────────────────────────
 */

import {
  AxisProcessor,
  DEFAULT_EXCLUSIVITY_THRESHOLD,
  createNeutralState,
  enforceExclusivity,
  type ControllerState,
} from '@wheel/protocol';
import { FixedRateLoop } from './FixedRateLoop';
import type { HotStore } from './hotStore';
import { buildFrame, createFrame, DEFAULT_STALE_SENSOR_MS, type RawInputFrame } from './pipeline';
import { IntervalStats, RateMeter } from './telemetry';
import type { ConfigStore } from '../config/configStore';
import {
  DRIVE_ACTIONS,
  MENU_ACTIONS,
  onTouchChange,
  releaseAllTouch,
  touchIsNeutral,
  type TouchState,
} from '../input/touchState';
import type { OutputDevice } from '../output/OutputDevice';
import type { SensorSource, SensorStatus } from '../sensors/types';

/** Everything the debug UI shows about the loop and inputs. Mutated in place by the loop. */
export interface LiveState {
  ticks: number;
  loopHz: number;
  tickMeanMs: number;
  tickP99Ms: number;
  tickMaxMs: number;
  stalls: number;
  errors: number;

  sensorId: string;
  sensorStatus: SensorStatus;
  sensorHz: number;
  sensorFresh: boolean;
  sensorAgeMs: number;
  roll: number;
  pitch: number;

  /** Tilt from centre ÷ range, before any shaping — the "what your hand did" line on the graph. */
  steeringRaw: number;
  /** −1 full left … +1 full right. 0 when the gyro is stale. */
  steering: number;
  /** Steering before smoothing — for the tuning graph. */
  steeringShaped: number;
  /** Pitch from centre ÷ range, before shaping. */
  pedalTiltRaw: number;
  /** −1 full brake … +1 full throttle, from pitch. 0 when the gyro is stale. */
  pedalTilt: number;
  /** Pedal tilt before smoothing. */
  pedalTiltShaped: number;

  /** A test chip is forcing the steering value. */
  steerOverride: boolean;
  /** Steering actually handed to the output: the gyro value, or the test chip's. */
  steeringOut: number;
  /** Disarmed by a link drop; re-arms once the link is back and nothing is pressed. */
  rearmPending: boolean;
  /** Disarmed and linked: only the menu buttons (D-pad, face buttons, L1/R1, Options) are sent. */
  menuMode: boolean;

  /** What was actually handed to the output this tick (after exclusivity). */
  throttle: number;
  brake: number;
  armed: boolean;
  outputId: string;
  outputReady: boolean;
}

export function createLiveState(): LiveState {
  return {
    ticks: 0,
    loopHz: 0,
    tickMeanMs: 0,
    tickP99Ms: 0,
    tickMaxMs: 0,
    stalls: 0,
    errors: 0,
    sensorId: '',
    sensorStatus: 'idle',
    sensorHz: 0,
    sensorFresh: false,
    sensorAgeMs: Infinity,
    roll: 0,
    pitch: 0,
    steeringRaw: 0,
    steering: 0,
    steeringShaped: 0,
    pedalTiltRaw: 0,
    pedalTilt: 0,
    pedalTiltShaped: 0,
    steerOverride: false,
    steeringOut: 0,
    rearmPending: false,
    menuMode: false,
    throttle: 0,
    brake: 0,
    armed: false,
    outputId: '',
    outputReady: false,
  };
}

export interface ControlLoopDeps {
  sensor: SensorSource;
  config: ConfigStore;
  output: OutputDevice;
  touch: TouchState;
  live: HotStore<LiveState>;
  hz?: number;
  staleSensorMs?: number;
}

/** Refresh the slower stats (jitter summary, sensor rate) every N ticks: 25 → 4×/sec at 100 Hz. */
const SLOW_STATS_EVERY = 25;

export class ControlLoop {
  private readonly deps: ControlLoopDeps;
  private readonly loop: FixedRateLoop;
  private readonly frame: RawInputFrame = createFrame();
  private readonly rate = new RateMeter();
  private readonly gaps = new IntervalStats(256);

  private readonly steeringAxis: AxisProcessor;
  private readonly pitchAxis: AxisProcessor;
  private readonly unsubscribeConfig: () => void;
  private readonly unsubscribeTouch: () => void;
  /** performance.now() of the last tick (scheduled or kicked). */
  private lastTickAt = 0;
  /** Was the gyro fresh last tick? Used to spot "readings just came back". */
  private wasFresh = false;
  /** Sensor id last tick — a change means the source was switched. */
  private lastSensorId = '';
  private gyroPedals: boolean;

  /** The one state object this loop owns and refills every tick. */
  private readonly state: ControllerState = createNeutralState();
  /** plan.md §19.1: start with every output released. */
  private armed = false;
  /**
   * The driver's choice. A link drop disarms but keeps this, and the loop
   * re-arms by itself once the link is back AND nothing is pressed on screen —
   * so a reconnect with a foot on the throttle can't mean instant full throttle.
   */
  private armIntent = false;

  constructor(deps: ControlLoopDeps) {
    this.deps = deps;
    this.loop = new FixedRateLoop(deps.hz ?? 100, this.tick);

    const cfg = deps.config.get();
    this.steeringAxis = new AxisProcessor(cfg.steering);
    this.pitchAxis = new AxisProcessor(cfg.pitch);
    this.gyroPedals = cfg.pedals.gyro;
    deps.output.configure({ steerPulse: cfg.steerOutput });
    // Settings changes apply on the next tick. Each change is a new object, so just swap the reference.
    this.unsubscribeTouch = onTouchChange(this.kick);
    this.unsubscribeConfig = deps.config.subscribe((next, changed) => {
      this.steeringAxis.config = next.steering;
      this.pitchAxis.config = next.pitch;
      this.gyroPedals = next.pedals.gyro;
      if (changed === 'all' || changed.startsWith('steerOutput.')) {
        deps.output.configure({ steerPulse: next.steerOutput });
      }
    });
  }

  start(): void {
    this.loop.start();
  }

  /** Stopping always releases everything first — a stopped loop must never leave a key held. */
  stop(): void {
    this.loop.stop();
    this.armed = false;
    this.deps.output.releaseAll(performance.now(), 'loop stopped');
  }

  /** Stop and detach from the config store. The loop can't be restarted after this. */
  dispose(): void {
    this.stop();
    this.unsubscribeConfig();
    this.unsubscribeTouch();
  }

  get isRunning(): boolean {
    return this.loop.isRunning;
  }

  get isArmed(): boolean {
    return this.armed;
  }

  /**
   * Arm / disarm output. Simple switch for now — piece 7.4 replaces this with
   * the ArmingMachine (needs connection, calibration, neutral inputs, …).
   * Arming is refused if the output isn't ready.
   */
  setArmed(on: boolean): boolean {
    if (on && !this.deps.output.ready) return false;
    // The screen swaps (F1 ↔ menu) and unmounted buttons never see pointerup:
    // let go of every touch so nothing held on one screen carries into the other.
    if (on !== this.armed) releaseAllTouch();
    this.armIntent = on;
    if (this.armed && !on) this.deps.output.releaseAll(performance.now(), 'disarmed');
    this.armed = on;
    return true;
  }

  /** Disarmed by a link drop, waiting to re-arm (link back + nothing pressed). */
  get rearmPending(): boolean {
    return this.armIntent && !this.armed;
  }

  /**
   * "The way I'm holding it now is straight": the current roll / pitch become zero.
   * Refused (false) without a fresh gyro reading. Plan §9's averaged, hold-still
   * capture replaces this in piece 10.2.
   */
  calibrateCenter(): boolean {
    const f = this.frame;
    if (!f.sensorFresh) return false;
    this.steeringAxis.setCenter(f.roll);
    this.pitchAxis.setCenter(f.pitch);
    return true;
  }

  /**
   * Run one extra tick RIGHT NOW (from a touch handler): the press / release goes
   * out immediately instead of waiting for a timer Chrome may be deferring.
   */
  private readonly kick = (): void => {
    if (!this.loop.isRunning) return;
    const now = performance.now();
    this.tick(now, Math.max(now - this.lastTickAt, 0), false, true);
  };

  private readonly tick = (now: number, dt: number, stalled: boolean, kicked = false): void => {
    const { sensor, live } = this.deps;
    this.lastTickAt = now;
    const f = buildFrame(this.frame, sensor, now, dt, stalled, this.deps.staleSensorMs ?? DEFAULT_STALE_SENSOR_MS);

    // Kicked ticks are extra: keep them out of the loop-rate / jitter stats.
    if (!kicked) {
      this.rate.mark(now);
      this.gaps.mark(now);
    }

    const v = live.peek();
    v.ticks = this.loop.stats.ticks;
    v.stalls = this.loop.stats.stalls;
    v.errors = this.loop.stats.errors;
    v.loopHz = this.rate.read(now);
    v.sensorFresh = f.sensorFresh;
    v.sensorAgeMs = f.sensorAgeMs;
    v.roll = f.roll;
    v.pitch = f.pitch;

    // ─── tilt → control values ───────────────────────────────────────────────
    const steer = this.steeringAxis;
    const tilt = this.pitchAxis;

    // After a stall, or when readings return after a gap, forget old smoothing
    // so the output jumps to where the tablet IS instead of gliding from where it WAS.
    // Same after switching sensor source.
    const switched = sensor.id !== this.lastSensorId;
    this.lastSensorId = sensor.id;
    if (stalled || switched || (f.sensorFresh && !this.wasFresh)) {
      steer.reset();
      tilt.reset();
    }
    this.wasFresh = f.sensorFresh;

    if (f.sensorFresh) {
      v.steering = steer.process(f.roll, dt);
      v.steeringShaped = steer.shaped;
      v.steeringRaw = steer.centeredDeg / (steer.config.rangeDeg || 1);
      v.pedalTilt = tilt.process(f.pitch, dt);
      v.pedalTiltShaped = tilt.shaped;
      v.pedalTiltRaw = tilt.centeredDeg / (tilt.config.rangeDeg || 1);
    } else {
      // Stale or missing gyro never steers.
      v.steering = 0;
      v.steeringShaped = 0;
      v.steeringRaw = 0;
      v.pedalTilt = 0;
      v.pedalTiltShaped = 0;
      v.pedalTiltRaw = 0;
    }

    // ─── build ControllerState → hand to the output ──────────────────────────
    const output = this.deps.output;
    const touch = this.deps.touch;
    const s = this.state;
    // Armed → drive buttons only. Disarmed (and not waiting to re-arm) → MENU mode:
    // menu buttons only, and no steering or pedals at all.
    const menu = !this.armed && !this.rearmPending && output.ready;
    v.menuMode = menu;
    for (const id of DRIVE_ACTIONS) s.buttons[id] = this.armed && touch.buttons[id] === true;
    for (const id of MENU_ACTIONS) s.buttons[id] = menu && touch.buttons[id] === true;
    // A held test chip wins over the gyro: a fixed, repeatable steering value.
    v.steerOverride = touch.steerOverride !== null;
    s.steering = touch.steerOverride ?? v.steering;
    // Touch pads always; gyro pedals (forward = throttle, back = brake) only if switched on.
    const tiltThrottle = this.gyroPedals && v.pedalTilt > 0 ? v.pedalTilt : 0;
    const tiltBrake = this.gyroPedals && v.pedalTilt < 0 ? -v.pedalTilt : 0;
    // Each pad is exactly what its finger does: both held → both sent, like real pedals.
    s.throttle = Math.max(touch.throttle, tiltThrottle);
    s.brake = Math.max(touch.brake, tiltBrake);
    enforceExclusivity(s, 'allow-both', DEFAULT_EXCLUSIVITY_THRESHOLD);
    if (menu) {
      s.steering = 0;
      s.throttle = 0;
      s.brake = 0;
    }

    // If the output stops being ready (e.g. disconnect later), drop to disarmed.
    if (this.armed && !output.ready) {
      this.armed = false; // keep armIntent: re-arm when the link returns
      output.releaseAll(now, 'link lost');
    } else if (this.rearmPending && output.ready && touchIsNeutral()) {
      this.armed = true;
    }
    // Menu mode goes out "armed" so the menu buttons reach the game; the state
    // itself is neutral apart from them.
    output.send(s, now, this.armed || menu);

    v.steeringOut = s.steering;
    v.throttle = s.throttle;
    v.brake = s.brake;
    v.armed = this.armed;
    v.rearmPending = this.rearmPending;
    v.outputId = output.id;
    v.outputReady = output.ready;

    if (v.ticks % SLOW_STATS_EVERY === 0) {
      const g = this.gaps.summary(); // small allocation, 4×/sec — fine
      v.tickMeanMs = g.mean;
      v.tickP99Ms = g.p99;
      v.tickMaxMs = g.max;
      v.sensorId = sensor.id;
      v.sensorStatus = sensor.status;
      v.sensorHz = sensor.sampleRateHz;
    }

    live.bump();
  };
}
