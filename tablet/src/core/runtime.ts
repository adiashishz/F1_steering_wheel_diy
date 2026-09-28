/**
 * COMPOSITION ROOT — the one place that decides which pieces are plugged in.
 *
 *   sensor  : SensorSwitch → SimulatedSensorSource (start) | DeviceOrientationSource (tap "Use gyro")
 *   config  : in-memory ConfigStore   (saved to device: Phase 8)
 *   touch   : touch pads + test chips (input/touchState)
 *   output  : WebSocketOutput → ESP32 or mock server, via the `/esp` proxy
 *   loop    : ControlLoop @ 100 Hz, starts DISARMED
 *
 * Swapping the sensor or the output later is a change HERE and nowhere else.
 * UI imports `runtime` to read state and poke inputs; it never builds these itself.
 */

import { ControlLoop, createLiveState, type LiveState } from './ControlLoop';
import { createHotStore, type HotStore } from './hotStore';
import { createConfigStore, type ConfigStore } from '../config/configStore';
import { installReleaseGuards } from '../input/releaseGuards';
import { ACTION_IDS, releaseAllTouch, touch, type TouchState } from '../input/touchState';
import type { LoopbackOutput } from '../output/LoopbackOutput';
import type { OutputDevice } from '../output/OutputDevice';
import { WebSocketOutput } from '../output/WebSocketOutput';
import { DeviceOrientationSource } from '../sensors/DeviceOrientationSource';
import { SensorSwitch } from '../sensors/SensorSwitch';
import { SimulatedSensorSource } from '../sensors/SimulatedSensorSource';

export interface Runtime {
  /** Whichever sensor is active (simulated or tablet gyro). */
  sensor: SensorSwitch;
  /** The fake gyro, for the desktop sliders. */
  sim: SimulatedSensorSource;
  config: ConfigStore;
  touch: TouchState;
  /** Whatever output is plugged in. */
  output: OutputDevice;
  /** The ESP32 link, for connection status in the UI. */
  esp: WebSocketOutput;
  /** The loopback output when it's the one plugged in, else null — for the key view. */
  loopback: LoopbackOutput | null;
  live: HotStore<LiveState>;
  control: ControlLoop;
  /** Start sensor + loop + connection. Safe to call more than once. */
  boot(): void;
  shutdown(): void;
}

function createRuntime(): Runtime {
  const sim = new SimulatedSensorSource({ jitterDeg: 0.3 });
  const sensor = new SensorSwitch({ simulated: sim, deviceorientation: new DeviceOrientationSource() }, 'simulated');
  const config = createConfigStore();
  const esp = new WebSocketOutput(undefined, ACTION_IDS);
  const output: OutputDevice = esp; // ← the §15 swap point
  const live = createHotStore(createLiveState());
  const control = new ControlLoop({ sensor, config, output, touch, live, hz: 100 });

  let booted = false;
  let removeGuards = () => {};

  return {
    sensor,
    sim,
    config,
    touch,
    output,
    esp,
    loopback: null,
    live,
    control,
    boot() {
      if (booted) return;
      booted = true;
      void sensor.start();
      control.start();
      if (document.visibilityState !== 'hidden') esp.connect();
      const removeRelease = installReleaseGuards(() => control.setArmed(false));
      // The ESP32 serves ONE driver: a background tab must not hold the link,
      // or it locks out the page you're actually using.
      const onVisibility = () => (document.visibilityState === 'hidden' ? esp.pause() : esp.connect());
      document.addEventListener('visibilitychange', onVisibility);
      removeGuards = () => {
        removeRelease();
        document.removeEventListener('visibilitychange', onVisibility);
      };
    },
    shutdown() {
      booted = false;
      removeGuards();
      releaseAllTouch();
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
    runtime.esp.dispose();
  });
}
