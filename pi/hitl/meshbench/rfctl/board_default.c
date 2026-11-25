/* Default board table: the starter conducted bench with ONE attenuator per DUT
 * (docs/design/mesh-hitl-rig.md §2.1, §5.2), N = 4 nodes, growing to 6.
 *
 * Owner decision (overrides desk D-241): no PE4302 DSAs. Each DUT has its own
 * Jeanoko 0-6 GHz attenuator (0-31.75 dB, 0.25 dB steps, UART text commands)
 * between its pigtail and its node splitter, so a pair's path loss is
 * F_ij + a_i + a_j. The pair chains keep only the HMC849 cut switch (+ pad); the
 * HMC7992 delay bank stays on pair 01. Switch lines are 74HC595 outputs latched
 * together; the attenuators are PIO UARTs whose commands start right after the
 * latch edge and land milliseconds later (§5.4).
 *
 *   chain bits  0..5    delay bank A: in switch V1 V2 EN, out switch V1 V2 EN
 *   chain bits  6..11   delay bank B: same
 *   chain bits 12..23   cut switch of pair p (01 02 03 12 13 23): base 12+2p, VCTL EN
 *   chain bits 24..41   N = 6 growth: pairs 04 05 14 15 24 25 34 35 45 (board_jeanoko_n6)
 *   chain bits 42..47   spare
 *   GPIO 8              camera-visible sync LED
 *   GPIO 22 26 27 28    UART attenuators att0..att3 (headers ATT U0..U3, unit 0..3)
 *   GPIO 23 24          att4, att5 at N = 6 (U4, U5)
 *   GPIO 29             attx: the spare / monitor-path unit (U6)
 *   GPIO 9              shared acknowledge line (every unit's TX, diode wired-AND)
 *
 * Every chain line has a pull-up on the board, and spare_high drives the bits no
 * device owns high too, so an unlisted cut header (N = 6 growth) reads "cut".
 * THE SWITCH TRUTH TABLES ARE PROVISIONAL (desk D-152: check the modules that
 * arrived before the first power-up). HMC849: EN high = both throws isolated;
 * through = VCTL 0, EN 0 (wire the pair path to the throw VCTL = 0 selects).
 * HMC7992: EN high = all throws off; V1 = bit 0, V2 = bit 1 of the arm.
 */
#include "rfctl_core.h"

#define CH(b) ((uint16_t)(b))
#define GPIO(g) ((uint16_t)(RFCTL_DIRECT | (g)))

/* value 0 = cut (EN high; also the pulled state), 1 = through */
#define CUT(nm, base)                                                                 \
  {                                                                                   \
    .name = nm, .kind = RFCTL_SWITCH, .nlines = 2, .ncodes = 2, .max_value = 1,        \
    .safe_value = 0, .line = {CH(base), CH(base + 1)}, .code = {0x3, 0x0},             \
    .note = "HMC849 0=cut 1=through"                                                  \
  }
#define CUTP(pair, p) CUT("cut" pair, 12 + 2 * (p))

/* value k (0..3) = arm k on both switches of the bank; 4 = both all-off */
#define DLY(nm, base, note_)                                                          \
  {                                                                                   \
    .name = nm, .kind = RFCTL_SWITCH, .nlines = 6, .ncodes = 5, .max_value = 4,        \
    .safe_value = 0,                                                                  \
    .line = {CH(base), CH(base + 1), CH(base + 2), CH(base + 3), CH(base + 4), CH(base + 5)}, \
    .code = {0x00, 0x09, 0x12, 0x1b, 0x3f}, .note = note_                             \
  }

/* Jeanoko UART attenuator: value in 0.25 dB steps, safe = 31.75 dB (max) */
#define ATT(nm, unit, gpio, note_)                                                    \
  {                                                                                   \
    .name = nm, .kind = RFCTL_ATTEN_UART, .nlines = 1, .max_value = 127,               \
    .safe_value = 127, .line = {GPIO(gpio)}, .aux = (unit), .note = note_             \
  }

#define COMMON                                                                        \
  DLY("dlyA", 0, "pair 01 bank A: 0..3 = +0/25/50/75 cm, 4 = off"),                   \
  DLY("dlyB", 6, "pair 01 bank B: 0..3 = +0/100/200/300 cm, 4 = off"),                \
  CUTP("01", 0), CUTP("02", 1), CUTP("03", 2), CUTP("12", 3), CUTP("13", 4), CUTP("23", 5), \
  ATT("att0", 0, 22, "node 0 attenuator (ATT U0), 0-31.75 dB"),                       \
  ATT("att1", 1, 26, "node 1 attenuator (ATT U1), 0-31.75 dB"),                       \
  ATT("att2", 2, 27, "node 2 attenuator (ATT U2), 0-31.75 dB"),                       \
  ATT("att3", 3, 28, "node 3 attenuator (ATT U3), 0-31.75 dB")

#define SYNCLED                                                                       \
  {.name = "syncled", .kind = RFCTL_SWITCH, .nlines = 1, .ncodes = 2, .max_value = 1,  \
   .safe_value = 0, .line = {GPIO(8)}, .code = {0, 1}, .note = "camera-visible LED"}

static const rfctl_device kDevicesN4[] = {
    COMMON,
    ATT("attx", 6, 29, "spare / monitor-path attenuator (ATT U6)"),
    SYNCLED,
};

static const rfctl_device kDevicesN6[] = {
    COMMON,
    CUTP("04", 6), CUTP("05", 7), CUTP("14", 8), CUTP("15", 9), CUTP("24", 10),
    CUTP("25", 11), CUTP("34", 12), CUTP("35", 13), CUTP("45", 14),
    ATT("att4", 4, 23, "node 4 attenuator (ATT U4), 0-31.75 dB"),
    ATT("att5", 5, 24, "node 5 attenuator (ATT U5), 0-31.75 dB"),
    ATT("attx", 6, 29, "spare / monitor-path attenuator (ATT U6)"),
    SYNCLED,
};

const rfctl_board rfctl_default_board = {
    .name = "jeanoko-n4",
    .chain_bits = 48,
    .ndevices = (uint8_t)(sizeof kDevicesN4 / sizeof kDevicesN4[0]),
    .dev = kDevicesN4,
    .spare_high = 1,
};

const rfctl_board rfctl_board_jeanoko_n6 = {
    .name = "jeanoko-n6",
    .chain_bits = 48,
    .ndevices = (uint8_t)(sizeof kDevicesN6 / sizeof kDevicesN6[0]),
    .dev = kDevicesN6,
    .spare_high = 1,
};
