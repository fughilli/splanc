// ap_webserver — example role built on the heapless stack, validated on-target.
//
// Runs the heapless AP role (mlme::ApMlme via stack::Stack in AP role) plus the
// bounded http module as real RISC-V on the C6: accept a station (AUTH ->
// ASSOC_REQ, through stack::Stack::ingest_wifi) then serve `GET /` with a bounded
// HTTP 200 (http::serve). The HITL harness greps PASS (http_status == 200).

#include <Arduino.h>

// The demo builds a full heapless Stack on the loop-task stack; give it room.
SET_LOOP_TASK_STACK_SIZE(16384);

extern "C" {
struct DemoResult {
  uint32_t ok;
  uint32_t step;
  uint32_t detail;
};
DemoResult ap_webserver_demo();
}

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("ap-webserver: boot");
}

void loop() {
  DemoResult r = ap_webserver_demo();
  bool ok = (r.ok == 1) && (r.detail == 200);
  Serial.printf("ap-webserver: http_status=%u step=%u result=%s\n", r.detail,
                r.step, ok ? "PASS" : "FAIL");
  delay(1000);
}
