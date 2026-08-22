// ble_peripheral — example role built on the heapless stack, validated on-target.
//
// Runs the heapless BLE-peripheral role (GAP advertising + a fixed GATT server)
// as real RISC-V on the C6: it advertises, then handles an ATT WRITE_REQ to a
// characteristic and confirms the stored value — all through the real
// stack::Stack::ingest_ble seam, allocation-free. The HITL harness greps PASS.

#include <Arduino.h>

// The demo builds a full heapless Stack on the loop-task stack; give it room.
SET_LOOP_TASK_STACK_SIZE(16384);

extern "C" {
struct DemoResult {
  uint32_t ok;
  uint32_t step;
  uint32_t detail;
};
DemoResult ble_peripheral_demo();
}

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("ble-peripheral: boot");
}

void loop() {
  DemoResult r = ble_peripheral_demo();
  bool ok = (r.ok == 1);
  Serial.printf(
      "ble-peripheral: advertising+gatt_write step=%u stored_first=0x%02x "
      "result=%s\n",
      r.step, r.detail, ok ? "PASS" : "FAIL");
  delay(1000);
}
