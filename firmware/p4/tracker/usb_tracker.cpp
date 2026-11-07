// A Vive tracker on the ESP32-P4's high-speed USB OTG port, through the ESP-IDF
// USB Host Library: enumerate it, claim its HID interfaces, stream their
// interrupt-IN reports into a queue, and answer lh_p4.rs's feature-report
// requests with HID GET_REPORT / SET_REPORT control transfers on interface 0.
//
// Tasks: the host library task (usb_host_lib_handle_events) and the client task
// (usb_host_client_handle_events: device events, transfer callbacks). Feature
// requests block on a semaphore, so they must come from another task (the
// tracker task), never from a transfer callback.
#include "firmware/p4/tracker/usb_tracker.h"

#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/semphr.h>
#include <freertos/task.h>
#include <stdio.h>
#include <string.h>
#include <esp_cpu.h>
#include <esp_timer.h>
#include <usb/usb_host.h>

namespace {

constexpr int kMaxIfaces = 4;
constexpr int kInFlight = 4;  // IN transfers kept queued per interface
constexpr TickType_t kControlTimeout = pdMS_TO_TICKS(100);

usb_host_client_handle_t g_client = nullptr;
usb_device_handle_t g_dev = nullptr;
volatile uint8_t g_new_addr = 0;
volatile bool g_gone = false;
volatile uint32_t g_dropped = 0;  // reports lost to a full queue
QueueHandle_t g_reports = nullptr;
SemaphoreHandle_t g_ctrl_done = nullptr;
usb_transfer_t* g_ctrl = nullptr;
uint16_t g_vid = 0, g_pid = 0;

struct Iface {
  uint8_t number;
  uint8_t ep;
  uint16_t mps;
  usb_transfer_t* xfer[kInFlight];
};
Iface g_ifaces[kMaxIfaces];
int g_n_ifaces = 0;

void client_event(const usb_host_client_event_msg_t* msg, void*) {
  printf("usb: client event %d\n", (int)msg->event);
  if (msg->event == USB_HOST_CLIENT_EVENT_NEW_DEV) {
    g_new_addr = msg->new_dev.address;
  } else if (msg->event == USB_HOST_CLIENT_EVENT_DEV_GONE) {
    g_gone = true;
  }
}

void host_lib_task(void*) {
  usb_host_config_t cfg = {};
  cfg.intr_flags = ESP_INTR_FLAG_LEVEL1;
  cfg.peripheral_map = 0;  // the default: the high-speed peripheral on the P4
  const esp_err_t err = usb_host_install(&cfg);
  printf("usb: host install: %s\n", esp_err_to_name(err));
  if (err != ESP_OK) vTaskDelete(nullptr);
  while (true) {
    uint32_t flags = 0;
    usb_host_lib_handle_events(portMAX_DELAY, &flags);
    if (flags & USB_HOST_LIB_EVENT_FLAGS_NO_CLIENTS) usb_host_device_free_all();
  }
}

void client_task(void*) {
  usb_host_client_config_t cfg = {};
  cfg.is_synchronous = false;
  cfg.max_num_event_msg = 8;
  cfg.async.client_event_callback = client_event;
  cfg.async.callback_arg = nullptr;
  while (usb_host_client_register(&cfg, &g_client) != ESP_OK) vTaskDelay(pdMS_TO_TICKS(10));
  while (true) usb_host_client_handle_events(g_client, portMAX_DELAY);
}

void in_done(usb_transfer_t* t) {
  if (t->status == USB_TRANSFER_STATUS_COMPLETED && t->actual_num_bytes > 0) {
    TrackerReport r;
    r.us = esp_timer_get_time();
    r.iface = static_cast<uint8_t>(reinterpret_cast<uintptr_t>(t->context));
    r.len = static_cast<uint8_t>(t->actual_num_bytes > sizeof(r.data) ? sizeof(r.data) : t->actual_num_bytes);
    memcpy(r.data, t->data_buffer, r.len);
    if (xQueueSend(g_reports, &r, 0) != pdTRUE) g_dropped++;  // drop when full: the kernel copes with gaps
  }
  if (t->status == USB_TRANSFER_STATUS_COMPLETED || t->status == USB_TRANSFER_STATUS_TIMED_OUT) {
    usb_host_transfer_submit(t);
  }
}

void ctrl_done(usb_transfer_t* t) { xSemaphoreGive(g_ctrl_done); }

// Claims every HID interface and records its interrupt-IN endpoint.
bool claim_hid(const usb_config_desc_t* cfg) {
  g_n_ifaces = 0;
  int offset = 0;
  const usb_standard_desc_t* d = reinterpret_cast<const usb_standard_desc_t*>(cfg);
  int iface = -1;
  while ((d = usb_parse_next_descriptor(d, cfg->wTotalLength, &offset)) != nullptr) {
    if (d->bDescriptorType == USB_B_DESCRIPTOR_TYPE_INTERFACE) {
      auto* id = reinterpret_cast<const usb_intf_desc_t*>(d);
      iface = (id->bInterfaceClass == USB_CLASS_HID && id->bAlternateSetting == 0) ? id->bInterfaceNumber : -1;
    } else if (d->bDescriptorType == USB_B_DESCRIPTOR_TYPE_ENDPOINT && iface >= 0 && g_n_ifaces < kMaxIfaces) {
      auto* ep = reinterpret_cast<const usb_ep_desc_t*>(d);
      if ((ep->bEndpointAddress & 0x80) && (ep->bmAttributes & 0x03) == USB_BM_ATTRIBUTES_XFER_INT) {
        if (usb_host_interface_claim(g_client, g_dev, iface, 0) == ESP_OK) {
          g_ifaces[g_n_ifaces++] = {static_cast<uint8_t>(iface), ep->bEndpointAddress,
                                    static_cast<uint16_t>(USB_EP_DESC_GET_MPS(ep)), {}};
        }
        iface = -1;  // one IN endpoint per interface
      }
    }
  }
  return g_n_ifaces > 0;
}

}  // namespace

extern "C" void p4_delay_ms(uint32_t ms) { vTaskDelay(pdMS_TO_TICKS(ms ? ms : 1)); }

extern "C" int64_t p4_now_us() { return esp_timer_get_time(); }

extern "C" uint32_t p4_cycles() { return esp_cpu_get_cycle_count(); }

#ifdef LH_DUMP
static constexpr const char* kLogPrefix = "# ";
#else
static constexpr const char* kLogPrefix = "";
#endif

extern "C" void p4_log(const uint8_t* msg, size_t len) { printf("%s%.*s\n", kLogPrefix, (int)len, (const char*)msg); }

static void dump_hex(const uint8_t* data, size_t len) {
  static const char kHex[] = "0123456789abcdef";
  char line[2 * 64 + 2];
  size_t n = 0;
  for (size_t i = 0; i < len && i < 64; i++) {
    line[n++] = kHex[data[i] >> 4];
    line[n++] = kHex[data[i] & 15];
  }
  line[n++] = '\n';
  fwrite(line, 1, n, stdout);
}

void tracker_dump_feature(const char* kind, int rtn, const uint8_t* data, size_t len) {
  printf("F %s %lld %d ", kind, (long long)esp_timer_get_time(), rtn);
  dump_hex(data, len);
}

void tracker_dump_report(const TrackerReport& r) {
  printf("R %u %lld ", r.iface, (long long)r.us);
  dump_hex(r.data, r.len);
}

void tracker_usb_start(QueueHandle_t reports, int prio) {
  g_reports = reports;
  g_ctrl_done = xSemaphoreCreateBinary();
  xTaskCreatePinnedToCore(host_lib_task, "usb_host", 4096, nullptr, prio, nullptr, 0);
  xTaskCreatePinnedToCore(client_task, "usb_client", 4096, nullptr, prio, nullptr, 0);
}

bool tracker_usb_open(uint16_t* vid, uint16_t* pid) {
  if (g_dev != nullptr || g_new_addr == 0 || g_client == nullptr) return false;
  const uint8_t addr = g_new_addr;
  g_new_addr = 0;
  g_gone = false;
  if (usb_host_device_open(g_client, addr, &g_dev) != ESP_OK) return false;
  const usb_device_desc_t* dd = nullptr;
  const usb_config_desc_t* cd = nullptr;
  usb_host_get_device_descriptor(g_dev, &dd);
  usb_host_get_active_config_descriptor(g_dev, &cd);
  g_vid = dd->idVendor;
  g_pid = dd->idProduct;
  *vid = g_vid;
  *pid = g_pid;
  usb_device_info_t info;
  usb_host_device_info(g_dev, &info);
  printf("usb: device %04x:%04x at addr %u, %s speed\n", g_vid, g_pid, addr,
         info.speed == USB_SPEED_HIGH ? "high" : info.speed == USB_SPEED_FULL ? "full" : "low");
  if (g_ctrl == nullptr) usb_host_transfer_alloc(sizeof(usb_setup_packet_t) + 64, 0, &g_ctrl);
  if (!claim_hid(cd)) {
    printf("usb: no HID interrupt-IN interfaces\n");
    return true;
  }
  for (int i = 0; i < g_n_ifaces; i++) {
    printf("usb: HID interface %u, IN ep 0x%02x, mps %u\n", g_ifaces[i].number, g_ifaces[i].ep, g_ifaces[i].mps);
  }
  return true;
}

void tracker_usb_stream() {
  for (int i = 0; i < g_n_ifaces; i++) {
    for (int k = 0; k < kInFlight; k++) {
      usb_transfer_t* t = g_ifaces[i].xfer[k];
      if (t == nullptr) {
        usb_host_transfer_alloc(g_ifaces[i].mps, 0, &t);
        g_ifaces[i].xfer[k] = t;
      }
      t->device_handle = g_dev;
      t->bEndpointAddress = g_ifaces[i].ep;
      t->num_bytes = g_ifaces[i].mps;
      t->callback = in_done;
      t->context = reinterpret_cast<void*>(static_cast<uintptr_t>(g_ifaces[i].number));
      t->timeout_ms = 0;
      usb_host_transfer_submit(t);
    }
  }
}

bool tracker_usb_gone() { return g_gone; }

uint32_t tracker_usb_dropped() { return g_dropped; }

void tracker_usb_debug() {
  // The high-speed DWC OTG core's host port register (HPRT, offset 0x440).
  const uint32_t hprt = *reinterpret_cast<volatile uint32_t*>(0x50000440);
  auto reg = [](uint32_t off) { return *reinterpret_cast<volatile uint32_t*>(0x50000000 + off); };
  static int n = 0;
  if (n++ % 5 == 0) {
    printf("usb: GSNPSID 0x%08lx GOTGCTL 0x%08lx GUSBCFG 0x%08lx GINTSTS 0x%08lx HCFG 0x%08lx\n",
           (unsigned long)reg(0x40), (unsigned long)reg(0x0), (unsigned long)reg(0xC), (unsigned long)reg(0x14),
           (unsigned long)reg(0x400));
  }
  if (n == 4) {
    printf("usb: cycling root port power\n");
    usb_host_lib_set_root_port_power(false);
    vTaskDelay(pdMS_TO_TICKS(200));
    usb_host_lib_set_root_port_power(true);
  }
  usb_host_lib_info_t info = {};
  usb_host_lib_info(&info);
  printf("usb: HPRT 0x%08lx (connected %lu, enabled %lu, power %lu, speed %lu, line %lu); %d devices, %d clients\n",
         (unsigned long)hprt, (unsigned long)(hprt & 1), (unsigned long)((hprt >> 2) & 1),
         (unsigned long)((hprt >> 12) & 1), (unsigned long)((hprt >> 17) & 3), (unsigned long)((hprt >> 10) & 3),
         info.num_devices, info.num_clients);
}

void tracker_usb_close() {
  if (g_dev == nullptr) return;
  for (int i = 0; i < g_n_ifaces; i++) {
    usb_host_endpoint_halt(g_dev, g_ifaces[i].ep);
    usb_host_endpoint_flush(g_dev, g_ifaces[i].ep);
    usb_host_interface_release(g_client, g_dev, g_ifaces[i].number);
  }
  usb_host_device_close(g_client, g_dev);
  g_dev = nullptr;
  g_n_ifaces = 0;
}

// HID class requests on interface 0. 0x03 << 8 = feature report.
static int control(uint8_t bm_request_type, uint8_t request, uint8_t report_id, const uint8_t* out, uint8_t* in,
                   size_t len) {
  if (g_dev == nullptr || g_gone) return -2;
  if (len > 64) len = 64;
  auto* setup = reinterpret_cast<usb_setup_packet_t*>(g_ctrl->data_buffer);
  setup->bmRequestType = bm_request_type;
  setup->bRequest = request;
  setup->wValue = (0x03 << 8) | report_id;
  setup->wIndex = 0;
  setup->wLength = static_cast<uint16_t>(len);
  if (out != nullptr) memcpy(g_ctrl->data_buffer + sizeof(usb_setup_packet_t), out, len);
  g_ctrl->num_bytes = sizeof(usb_setup_packet_t) + len;
  g_ctrl->device_handle = g_dev;
  g_ctrl->bEndpointAddress = 0;
  g_ctrl->callback = ctrl_done;
  g_ctrl->context = nullptr;
  g_ctrl->timeout_ms = 100;
  if (usb_host_transfer_submit_control(g_client, g_ctrl) != ESP_OK) return -1;
  if (xSemaphoreTake(g_ctrl_done, kControlTimeout) != pdTRUE) return -1;
  if (g_ctrl->status != USB_TRANSFER_STATUS_COMPLETED) return -1;  // STALL = NAK: not ready yet
  const int n = g_ctrl->actual_num_bytes - static_cast<int>(sizeof(usb_setup_packet_t));
  if (in != nullptr && n > 0) memcpy(in, g_ctrl->data_buffer + sizeof(usb_setup_packet_t), n);
  return n < 0 ? 0 : n;
}

extern "C" int p4_tracker_get_feature(uint8_t report_id, uint8_t* buf, size_t len) {
  // GET_REPORT: bmRequestType 0xA1 (IN, class, interface), bRequest 0x01.
  int n = control(0xA1, 0x01, report_id, nullptr, buf, len);
  if (n > 0 && buf[0] != report_id) {
    // A device that omits the id: put it first, like hidapi does.
    const int m = n < static_cast<int>(len) ? n : static_cast<int>(len) - 1;
    memmove(buf + 1, buf, m);
    buf[0] = report_id;
    n = m + 1;
  }
#ifdef LH_DUMP
  tracker_dump_feature("GET", n, buf, n > 0 ? n : 1);
#endif
  return n;
}

extern "C" int p4_tracker_set_feature(const uint8_t* data, size_t len) {
  // SET_REPORT: bmRequestType 0x21 (OUT, class, interface), bRequest 0x09; the id is data[0].
  if (len == 0) return -1;
  int n = control(0x21, 0x09, data[0], data, nullptr, len);
#ifdef LH_DUMP
  // hidapi's convention, which the recordings carry: a SET returns its length.
  tracker_dump_feature("SET", n >= 0 ? static_cast<int>(len) : n, data, len);
#endif
  return n;
}
