/**
 * COMPOSITION ROOT — the one place that decides which pieces are plugged in.
 *
 *   sensor  : SimulatedSensorSource   (real gyro: Phase 9)
 *   config  : in-memory ConfigStore   (saved to device: Phase 8)
 *   output  : LoopbackOutput          (key logic in the browser; WebSocket → ESP32: Phase 6)
 *   loop    : ControlLoop @ 100 Hz, starts DISARMED
 *
 * Swapping the sensor or the output later is a change HERE and nowhere else.
 * UI imports `runtime` to read state and poke inputs; it never builds these itself.
 */

import { ControlLoop, createLiveState, type LiveState } from './ControlLoop';
import { createHotStore, type HotStore } from './hotStore';
import { createConfigStore, type ConfigStore } from '../config/configStore';
import { LoopbackOutput } from '../output/LoopbackOutput';
import type { OutputDevice } from '../output/OutputDevice';
import { SimulatedSensorSource } from '../sensors/SimulatedSensorSource';
import type { SensorSource } from '../sensors/types';

export interface Runtime {
  /** Whatever sensor is active. Use this for status / reading. */
  sensor: SensorSource;
  /** The fake gyro, for the desktop sliders. Same object as `sensor` for now. */
  sim: SimulatedSensorSource;
  config: ConfigStore;
  /** Whatever output is plugged in. */
  output: OutputDevice;
  /** The loopback output when it's the one plugged in, else null — for the key view. */
  loopback: LoopbackOutput | null;
  live: HotStore<LiveState>;
  control: ControlLoop;
  /** Start sensor + loop. Safe to call more than once. */
  boot(): void;
  shutdown(): void;
}

function createRuntime(): Runtime {
  const sim = new SimulatedSensorSource({ jitterDeg: 0.3 });
  const sensor: SensorSource = sim;
  const config = createConfigStore();
  const loopback = new LoopbackOutput();
  const output: OutputDevice = loopback; // ← the §15 swap point
  const live = createHotStore(createLiveState());
  const control = new ControlLoop({ sensor, config, output, live, hz: 100 });

  let booted = false;

  return {
    sensor,
    sim,
    config,
    output,
    loopback,
    live,
    control,
    boot() {
      if (booted) return;
      booted = true;
      void sensor.start();
      control.start();
    },
    shutdown() {
      booted = false;
      control.stop();
      sensor.stop();
    },
  };
}

export const runtime = createRuntime();

// When Vite hot-reloads this module, stop the old loop so two never run at once.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    runtime.shutdown();
    runtime.control.dispose();
  });
}
