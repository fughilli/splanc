/* rfctl on a Raspberry Pi Pico 2 (RP2350A): the HAL for rfctl_core over pico-sdk.
 * Pin map: docs/design/mesh-hitl-rig.md §5.3.
 *
 *   GP2  SPI0 SCK  -> 74HC595 SRCLK (all chips)      GP5  RCLK (latch, all chips)
 *   GP3  SPI0 TX   -> SER of chip 0                   GP6  /OE (all chips; 10k pull-up)
 *   GP4  SPI0 RX   <- QH' of the last chip (selftest) GP7  SYNC out (toggles every commit)
 *   GP8  sync LED (board device "syncled")           GP10..GP21  FSTI inputs 0..11
 *   GP25 on-board LED (heartbeat; solid = fault)
 *   UART attenuators (board devices of kind atten_uart, default table): one PIO
 *   TX state machine per unit on the device's GPIO (GP22 26 27 28, 23 24, 29),
 *   115200 8N1; GP9 = the shared acknowledge line (UART1 RX), every unit's TX
 *   joined through a Schottky diode (wired-AND, 4.7k pull-up), read by `attcheck`.
 *
 * Boot: /OE is held high (outputs hi-Z, the external pull-ups/downs define the
 * lines) until the safe vector is shifted in and latched; only then are the 595
 * outputs enabled. So the RF hardware never sees random power-up states.
 * Commits run from a hardware-alarm IRQ that fires 20 us early and then spins to
 * the exact microsecond with interrupts off; RCLK, the direct GPIOs and SYNC move
 * in one SIO write.
 */
#include <stdio.h>
#include <string.h>

#include "hardware/clocks.h"
#include "hardware/gpio.h"
#include "hardware/irq.h"
#include "hardware/pio.h"
#include "hardware/spi.h"
#include "hardware/sync.h"
#include "hardware/timer.h"
#include "hardware/uart.h"
#include "hardware/watchdog.h"
#include "pico/bootrom.h"
#include "pico/stdlib.h"
#include "rfctl_core.h"

#define PIN_SCK 2
#define PIN_TX 3
#define PIN_RX 4
#define PIN_RCLK 5
#define PIN_OE_N 6
#define PIN_SYNC 7
#define PIN_FSTI0 10
#define N_FSTI 12
#define PIN_LED 25
#define SPI_HZ (10 * 1000 * 1000)
#define PIN_ACK 9 /* UART1 RX */
#define UART_BAUD 115200
#define UART_BIT_US 9 /* 8.68 us, rounded up */
#define EARLY_US 20

static rfctl g_c;
static int g_alarm = -1;
static uint64_t g_alarm_t;
static uint32_t g_direct_mask; /* every GPIO a board device drives */
static uint32_t g_cap_mask, g_cap_holdoff;
static uint64_t g_last_edge[N_FSTI];

uint64_t rfctl_hal_now_us(void) { return time_us_64(); }

/* ---- UART attenuators: PIO transmitters ---------------------------------------
 * pico-examples uart_tx.pio, assembled: 8N1, LSB first, 8 PIO clocks per bit.
 *   .side_set 1 opt
 *   pull       side 1 [7]   ; stop bit / idle high, wait for a byte
 *   set x, 7   side 0 [7]   ; start bit
 *   bitloop: out pins, 1
 *   jmp x-- bitloop   [6]
 */
static const uint16_t kUartTxInsns[] = {0x9fa0, 0xf727, 0x6001, 0x0642};
static const struct pio_program kUartTxProgram = {
    .instructions = kUartTxInsns, .length = 4, .origin = -1};
static bool g_uart_ready[RFCTL_UART_MAX];

static PIO uart_pio(uint8_t unit) { return unit < 4 ? pio0 : pio1; }

static void uart_tx_init(uint8_t unit, uint8_t gpio) {
  static int offset[2] = {-1, -1};
  PIO pio = uart_pio(unit);
  uint sm = unit & 3u, k = unit < 4 ? 0 : 1;
  if (offset[k] < 0) offset[k] = (int)pio_add_program(pio, &kUartTxProgram);
  pio_sm_set_pins_with_mask(pio, sm, 1u << gpio, 1u << gpio); /* idle high */
  pio_sm_set_pindirs_with_mask(pio, sm, 1u << gpio, 1u << gpio);
  pio_gpio_init(pio, gpio);
  pio_sm_config c = pio_get_default_sm_config();
  sm_config_set_wrap(&c, (uint)offset[k], (uint)offset[k] + 3);
  sm_config_set_sideset(&c, 2, true, false);
  sm_config_set_out_shift(&c, true, false, 32);
  sm_config_set_out_pins(&c, gpio, 1);
  sm_config_set_sideset_pins(&c, gpio);
  sm_config_set_fifo_join(&c, PIO_FIFO_JOIN_TX); /* 8 deep: one whole command */
  sm_config_set_clkdiv(&c, (float)clock_get_hz(clk_sys) / (8.0f * UART_BAUD));
  pio_sm_init(pio, sm, (uint)offset[k], &c);
  pio_sm_set_enabled(pio, sm, true);
  g_uart_ready[unit] = true;
}

bool __not_in_flash_func(rfctl_hal_uart_send)(uint8_t unit, uint8_t gpio, const char *cmd,
                                              uint8_t n) {
  (void)gpio;
  if (unit >= RFCTL_UART_MAX || !g_uart_ready[unit]) return true; /* no such unit: drop */
  PIO pio = uart_pio(unit);
  uint sm = unit & 3u;
  uint32_t irq = save_and_disable_interrupts(); /* commit IRQ vs main loop: whole commands */
  bool ok = 8u - pio_sm_get_tx_fifo_level(pio, sm) >= n;
  if (ok)
    for (uint8_t i = 0; i < n; i++) pio_sm_put(pio, sm, (uint8_t)cmd[i]);
  restore_interrupts(irq);
  return ok;
}

int rfctl_hal_uart_txn(uint8_t unit, uint8_t gpio, const char *cmd, uint8_t n, uint32_t timeout_us,
                       uint32_t *latency_us) {
  if (unit >= RFCTL_UART_MAX || !g_uart_ready[unit]) return -2;
  PIO pio = uart_pio(unit);
  uint sm = unit & 3u;
  /* wait for the unit's own transmitter to drain, then for an idle (high) bus */
  uint64_t t = time_us_64();
  while (!pio_sm_is_tx_fifo_empty(pio, sm) && time_us_64() - t < 5000) tight_loop_contents();
  busy_wait_us(2 * 10 * UART_BIT_US);
  t = time_us_64();
  while (!gpio_get(PIN_ACK)) {
    if (time_us_64() - t > 2000) return -1; /* an unpowered unit holds the bus low */
  }
  while (uart_is_readable(uart1)) (void)uart_getc(uart1);
  if (!rfctl_hal_uart_send(unit, gpio, cmd, n)) return 0;
  uint64_t t_end = time_us_64() + (uint64_t)n * 10u * UART_BIT_US;
  int state = 0; /* 0 nothing, 1 saw 'o' */
  while (time_us_64() < t_end + timeout_us) {
    watchdog_update();
    if (!uart_is_readable(uart1)) continue;
    char ch = (char)uart_getc(uart1);
    if (ch == 'o' || ch == 'O') {
      state = 1;
    } else if (state == 1 && (ch == 'k' || ch == 'K')) {
      uint64_t now = time_us_64();
      *latency_us = now > t_end ? (uint32_t)(now - t_end) : 0;
      return 1;
    } else {
      state = 0;
    }
  }
  return 0;
}

static void shift_bytes(const uint8_t *bytes, uint16_t nbits, uint8_t *rx) {
  /* farthest chip first, MSB first: chip k output Qj = bit j of bytes[k] */
  uint16_t n = nbits / 8;
  for (uint16_t i = n; i-- > 0;) {
    uint8_t in = 0;
    spi_write_read_blocking(spi0, &bytes[i], &in, 1);
    if (rx) rx[n - 1 - i] = in; /* send order */
  }
}

void rfctl_hal_chain_shift(const uint8_t *bytes, uint16_t nbits) { shift_bytes(bytes, nbits, NULL); }

bool rfctl_hal_chain_loopback(const uint8_t *out, uint8_t *in, uint16_t nbits) {
  uint8_t rx[RFCTL_CHAIN_BITS / 8];
  uint16_t n = nbits / 8;
  shift_bytes(out, nbits, NULL);
  shift_bytes(out, nbits, rx); /* what comes back is the first pass */
  for (uint16_t i = 0; i < n; i++) in[n - 1 - i] = rx[i];
  return true;
}

/* The commit instant: one SIO write moves RCLK high, the direct lines and SYNC. */
static void __not_in_flash_func(commit_outputs)(rfctl *c) {
  const uint8_t *chain;
  uint64_t mask, val;
  rfctl_staged_outputs(c, &chain, &mask, &val);
  uint32_t m = (uint32_t)mask | (1u << PIN_RCLK) | (1u << PIN_SYNC);
  uint32_t v = (uint32_t)val | (1u << PIN_RCLK) | ((gpio_get_out_level(PIN_SYNC) ? 0u : 1u) << PIN_SYNC);
  gpio_put_masked(m, v);
  gpio_put(PIN_RCLK, 0);
}

static void __not_in_flash_func(alarm_cb)(uint alarm) {
  (void)alarm;
  uint32_t irq = save_and_disable_interrupts();
  while (time_us_64() < g_alarm_t) tight_loop_contents();
  if (g_c.staged == 1) {
    commit_outputs(&g_c);
    uint64_t t = time_us_64();
    rfctl_serial_words(&g_c, false);
    rfctl_committed(&g_c, t);
  }
  restore_interrupts(irq);
}

void rfctl_hal_arm_commit(struct rfctl *c, uint64_t t_us) {
  (void)c;
  g_alarm_t = t_us;
  uint64_t fire = t_us > EARLY_US ? t_us - EARLY_US : 0;
  if (hardware_alarm_set_target((uint)g_alarm, from_us_since_boot(fire))) {
    alarm_cb((uint)g_alarm); /* already past: commit now (counted late) */
  }
}

void rfctl_hal_commit_now(struct rfctl *c) {
  uint32_t irq = save_and_disable_interrupts();
  commit_outputs(c);
  uint64_t t = time_us_64();
  rfctl_serial_words(c, false);
  restore_interrupts(irq);
  rfctl_committed(c, t);
}

void rfctl_hal_serial_atten(uint8_t clk, uint8_t data, uint8_t le, uint8_t word6) {
  for (int i = 5; i >= 0; i--) {
    gpio_put(data, (word6 >> i) & 1u);
    busy_wait_at_least_cycles(15);
    gpio_put(clk, 1);
    busy_wait_at_least_cycles(15);
    gpio_put(clk, 0);
  }
  gpio_put(le, 1);
  busy_wait_at_least_cycles(15);
  gpio_put(le, 0);
}

static void __not_in_flash_func(fsti_cb)(uint gpio, uint32_t events) {
  (void)events;
  uint64_t t = time_us_64();
  uint line = gpio - PIN_FSTI0;
  if (line >= N_FSTI || !((g_cap_mask >> line) & 1u)) return;
  if (g_last_edge[line] && t - g_last_edge[line] < g_cap_holdoff) return;
  g_last_edge[line] = t;
  rfctl_edge_push(&g_c, (uint8_t)line, t);
}

void rfctl_hal_cap_config(uint32_t mask, uint32_t holdoff_us) {
  g_cap_holdoff = holdoff_us;
  g_cap_mask = mask;
  for (uint i = 0; i < N_FSTI; i++) {
    g_last_edge[i] = 0;
    gpio_set_irq_enabled(PIN_FSTI0 + i, GPIO_IRQ_EDGE_RISE, (mask >> i) & 1u);
  }
}

void rfctl_hal_bootsel(void) {
  sleep_ms(50); /* let the reply drain */
  rom_reset_usb_boot(0, 0);
}

void rfctl_hal_reset(void) {
  sleep_ms(50);
  watchdog_reboot(0, 0, 0);
}

static void write_usb(void *ctx, const char *s, size_t n) {
  (void)ctx;
  stdio_put_string(s, (int)n, false, false);
  stdio_flush();
}

static void init_pins(void) {
  gpio_init(PIN_OE_N);
  gpio_set_dir(PIN_OE_N, GPIO_OUT);
  gpio_put(PIN_OE_N, 1); /* outputs off until the safe vector is latched */
  gpio_init(PIN_RCLK);
  gpio_set_dir(PIN_RCLK, GPIO_OUT);
  gpio_put(PIN_RCLK, 0);
  gpio_init(PIN_SYNC);
  gpio_set_dir(PIN_SYNC, GPIO_OUT);
  gpio_put(PIN_SYNC, 0);
  gpio_init(PIN_LED);
  gpio_set_dir(PIN_LED, GPIO_OUT);
  spi_init(spi0, SPI_HZ);
  spi_set_format(spi0, 8, SPI_CPOL_0, SPI_CPHA_0, SPI_MSB_FIRST);
  gpio_set_function(PIN_SCK, GPIO_FUNC_SPI);
  gpio_set_function(PIN_TX, GPIO_FUNC_SPI);
  gpio_set_function(PIN_RX, GPIO_FUNC_SPI);
  /* direct device lines: outputs, driven low until the safe state is applied */
  const rfctl_board *b = &rfctl_default_board;
  for (unsigned i = 0; i < b->ndevices; i++) {
    if (b->dev[i].kind == RFCTL_ATTEN_UART) {
      uart_tx_init(b->dev[i].aux, (uint8_t)(b->dev[i].line[0] & 0xff)); /* idles high */
      continue;
    }
    for (unsigned k = 0; k < b->dev[i].nlines; k++)
      if (b->dev[i].line[k] & RFCTL_DIRECT) g_direct_mask |= 1u << (b->dev[i].line[k] & 0xff);
  }
  /* the shared acknowledge line of the UART units (only `attcheck` reads it) */
  uart_init(uart1, UART_BAUD);
  gpio_set_function(PIN_ACK, GPIO_FUNC_UART);
  gpio_pull_up(PIN_ACK);
  for (uint g = 0; g < 30; g++) {
    if (!((g_direct_mask >> g) & 1u)) continue;
    gpio_init(g);
    gpio_set_dir(g, GPIO_OUT);
    gpio_put(g, 0);
  }
  for (uint i = 0; i < N_FSTI; i++) {
    gpio_init(PIN_FSTI0 + i);
    gpio_set_dir(PIN_FSTI0 + i, GPIO_IN);
    gpio_pull_down(PIN_FSTI0 + i); /* an unplugged tap reads idle-low */
  }
  gpio_set_irq_callback(fsti_cb);
  irq_set_enabled(IO_IRQ_BANK0, true);
  irq_set_priority(IO_IRQ_BANK0, PICO_LOWEST_IRQ_PRIORITY);
}

int main(void) {
  init_pins();
  g_alarm = hardware_alarm_claim_unused(true);
  hardware_alarm_set_callback((uint)g_alarm, alarm_cb);
  stdio_init_all();
  rfctl_init(&g_c, &rfctl_default_board, write_usb, NULL); /* shifts + latches safe */
  gpio_put(PIN_OE_N, 0);                                   /* now drive the outputs */
  watchdog_enable(500, true); /* a hung loop resets into the safe state */
  uint64_t next_blink = 0;
  for (;;) {
    watchdog_update();
    int ch;
    while ((ch = stdio_getchar_timeout_us(0)) != PICO_ERROR_TIMEOUT) {
      char b = (char)ch;
      rfctl_feed(&g_c, &b, 1);
    }
    uint64_t now = time_us_64();
    rfctl_poll(&g_c, now);
    if (now >= next_blink) {
      gpio_put(PIN_LED, g_c.faults ? 1 : !gpio_get_out_level(PIN_LED));
      next_blink = now + (g_c.playing ? 100000 : 500000);
    }
  }
}
