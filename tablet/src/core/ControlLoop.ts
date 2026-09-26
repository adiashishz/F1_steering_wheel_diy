/**
 * ControlLoop — what runs 100×/sec.
 *
 *   FixedRateLoop tick
 *     → buildFrame(sensor)          read inputs
 *     → AxisProcessor ×2            roll → steering, pitch → pedal tilt (−1 brake … +1 throttle)
 *     → ControllerState             steering + throttle/brake (+ exclusivity)
 *     → output.send(state, armed)   the §15 seam — loopback now, ESP32 later
 *     → write LiveState + bump()    so the UI can show it
 *
 * Pedals come from gyro tilt for now. Touch pedals arrive in Phase 5, and the
 * three control modes (which input drives which pedal) in Phase 10.
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
  /** Was the gyro fresh last tick? Used to spot "readings just came back". */
  private wasFresh = false;

  /** The one state object this loop owns and refills every tick. */
  private readonly state: ControllerState = createNeutralState();
  /** plan.md §19.1: start with every output released. */
  private armed = false;

  constructor(deps: ControlLoopDeps) {
    this.deps = deps;
    this.loop = new FixedRateLoop(deps.hz ?? 100, this.tick);

    const cfg = deps.config.get();
    this.steeringAxis = new AxisProcessor(cfg.steering);
    this.pitchAxis = new AxisProcessor(cfg.pitch);
    // Settings changes apply on the next tick. Each change is a new object, so just swap the reference.
    this.unsubscribeConfig = deps.config.subscribe((next) => {
      this.steeringAxis.config = next.steering;
      this.pitchAxis.config = next.pitch;
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
    if (this.armed && !on) this.deps.output.releaseAll(performance.now(), 'disarmed');
    this.armed = on;
    return true;
  }

  private readonly tick = (now: number, dt: number, stalled: boolean): void => {
    const { sensor, live } = this.deps;
    const f = buildFrame(this.frame, sensor, now, dt, stalled, this.deps.staleSensorMs ?? DEFAULT_STALE_SENSOR_MS);

    this.rate.mark(now);
    this.gaps.mark(now);

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
    if (stalled || (f.sensorFresh && !this.wasFresh)) {
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
    const s = this.state;
    s.steering = v.steering;
    // Gyro pedals for now: one signed tilt → forward = throttle, back = brake.
    s.throttle = v.pedalTilt > 0 ? v.pedalTilt : 0;
    s.brake = v.pedalTilt < 0 ? -v.pedalTilt : 0;
    enforceExclusivity(s, 'dominant', DEFAULT_EXCLUSIVITY_THRESHOLD);

    // If the output stops being ready (e.g. disconnect later), drop to disarmed.
    if (this.armed && !output.ready) this.setArmed(false);
    output.send(s, now, this.armed);

    v.throttle = s.throttle;
    v.brake = s.brake;
    v.armed = this.armed;
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
