/* Default board table: the starter conducted bench, N = 4 nodes
 * (/workspace RF-BENCH.md §2, docs/design/mesh-hitl-rig.md §5.2).
 *
 * Six pair chains (01 02 03 12 13 23), each: cut switch + 3 x PE4302 in parallel
 * mode. The delay bank (two SP4T pairs, banks A and B) sits in series on pair 01.
 * All control lines are 74HC595 outputs: 18 chips, 144 bits, latched together.
 *
 *   chain bits   0..107  DSA (pair p, stage s): base (p*3+s)*6, line i = C(0.5*2^i) dB
 *   chain bits 108..125  cut switch of pair p: base 108+p*3, lines V1 V2 EN
 *   chain bits 126..131  delay bank A (in switch V1 V2 EN, out switch V1 V2 EN)
 *   chain bits 132..137  delay bank B (same)
 *   chain bits 138..143  spare
 *   GPIO 8               camera-visible sync LED (a plain 0/1 device)
 *
 * THE SWITCH TRUTH TABLE IS PROVISIONAL. It assumes an HMC7992-class absorptive
 * SP4T with two select lines (V1 = bit 0, V2 = bit 1) and an all-off line (bit 2,
 * high = every throw isolated and terminated). Check the parts that arrived and
 * edit the codes here (mesh-hitl-rig.md §11, question Q2) before the first power-up:
 * the safe state is only safe if these codes are right.
 */
#include "rfctl_core.h"

#define CH(b) ((uint16_t)(b))
#define GPIO(g) ((uint16_t)(RFCTL_DIRECT | (g)))

#define DSA(nm, base)                                                                 \
  {                                                                                   \
    .name = nm, .kind = RFCTL_ATTEN_PARALLEL, .nlines = 6, .max_value = 63,            \
    .safe_value = 63,                                                                 \
    .line = {CH(base), CH(base + 1), CH(base + 2), CH(base + 3), CH(base + 4), CH(base + 5)}, \
    .note = "PE4302 parallel, 0-31.5 dB"                                              \
  }

#define DSA3(pair, p) DSA("att" pair "a", (p * 3 + 0) * 6), DSA("att" pair "b", (p * 3 + 1) * 6), \
                      DSA("att" pair "c", (p * 3 + 2) * 6)

/* value 0 = cut (all off), 1 = through (RF1) */
#define CUT(nm, base)                                                                 \
  {                                                                                   \
    .name = nm, .kind = RFCTL_SWITCH, .nlines = 3, .ncodes = 2, .max_value = 1,        \
    .safe_value = 0, .line = {CH(base), CH(base + 1), CH(base + 2)},                    \
    .code = {0x4, 0x0}, .note = "0=cut 1=through"                                     \
  }

/* value k (0..3) = arm k on both switches of the bank; 4 = both all-off (pair cut) */
#define DLY(nm, base, note_)                                                          \
  {                                                                                   \
    .name = nm, .kind = RFCTL_SWITCH, .nlines = 6, .ncodes = 5, .max_value = 4,        \
    .safe_value = 0,                                                                  \
    .line = {CH(base), CH(base + 1), CH(base + 2), CH(base + 3), CH(base + 4), CH(base + 5)}, \
    .code = {0x00, 0x09, 0x12, 0x1b, 0x24}, .note = note_                             \
  }

static const rfctl_device kDevices[] = {
    DSA3("01", 0), DSA3("02", 1), DSA3("03", 2), DSA3("12", 3), DSA3("13", 4), DSA3("23", 5),
    CUT("cut01", 108), CUT("cut02", 111), CUT("cut03", 114),
    CUT("cut12", 117), CUT("cut13", 120), CUT("cut23", 123),
    DLY("dlyA", 126, "pair 01 bank A: 0..3 = +0/25/50/75 cm, 4 = off"),
    DLY("dlyB", 132, "pair 01 bank B: 0..3 = +0/100/200/300 cm, 4 = off"),
    {.name = "syncled", .kind = RFCTL_SWITCH, .nlines = 1, .ncodes = 2, .max_value = 1,
     .safe_value = 0, .line = {GPIO(8)}, .code = {0, 1}, .note = "camera-visible LED"},
};

const rfctl_board rfctl_default_board = {
    .name = "starter-n4",
    .chain_bits = 144,
    .ndevices = (uint8_t)(sizeof kDevices / sizeof kDevices[0]),
    .dev = kDevices,
};
