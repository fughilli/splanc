// sta_client — example role built on the heapless stack, validated on-target.
//
// Runs the heapless STA MLME (mlme::StaMlme via stack::Stack in STA role) as real
// RISC-V on the C6: connect -> receive AUTH -> receive ASSOC_RESP -> Associated,
// driven through the real stack::Stack::ingest_wifi seam. The HITL harness greps
// PASS (final_state == 4 == Associated).

#include <Arduino.h>

// The demo builds a full heapless Stack on the loop-task stack; give it room.
SET_LOOP_TASK_STACK_SIZE(16384);

extern "C" {
struct DemoResult {
  uint32_t ok;
  uint32_t step;
  uint32_t detail;
};
DemoResult sta_client_demo();
}

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("sta-client: boot");
}

void loop() {
  DemoResult r = sta_client_demo();
  bool ok = (r.ok == 1) && (r.detail == 4);
  Serial.printf(
      "sta-client: final_state=%u (4=Associated) step=%u result=%s\n", r.detail,
      r.step, ok ? "PASS" : "FAIL");
  delay(1000);
}
