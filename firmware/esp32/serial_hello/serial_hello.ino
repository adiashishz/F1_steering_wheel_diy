// F.1 — plan.md Stage 1: prove the board can be programmed and talks back.
//
// Prints "Hello from ESP32-S3" every second, and every 5 s a chip report
// so we can confirm this really is an N16R8 (16 MB flash, 8 MB PSRAM).
//
// Build + upload + watch (settings come from sketch.yaml):
//   arduino-cli compile --upload firmware/esp32/serial_hello
//   arduino-cli monitor -p /dev/ttyACM0 -c baudrate=115200

void printChipReport() {
  Serial.println("---- chip report ----");
  Serial.printf("Model:  %s rev %d, %d cores @ %lu MHz\n",
                ESP.getChipModel(), ESP.getChipRevision(), ESP.getChipCores(),
                (unsigned long)ESP.getCpuFreqMHz());
  Serial.printf("Flash:  %lu MB\n", (unsigned long)(ESP.getFlashChipSize() / (1024 * 1024)));
  Serial.printf("PSRAM:  %lu MB (free %lu KB)\n",
                (unsigned long)(ESP.getPsramSize() / (1024 * 1024)),
                (unsigned long)(ESP.getFreePsram() / 1024));
  Serial.printf("SDK:    %s\n", ESP.getSdkVersion());
  Serial.println("---------------------");
}

void setup() {
  Serial.begin(115200);
  delay(1500);  // give the USB serial link a moment to come up
  printChipReport();
}

void loop() {
  static uint32_t n = 0;
  Serial.println("Hello from ESP32-S3");
  if (++n % 5 == 0) printChipReport();
  delay(1000);
}
