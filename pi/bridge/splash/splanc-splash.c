/*
 * splanc-splash: the Splanc bridge's early boot splash (pi/bridge/README.md,
 * "Boot splash").
 *
 * Started from the NixOS initrd (image/nix/splash.nix) as soon as the SPI
 * controller and spidev are loaded, it plays the boot animation on the
 * Waveshare OLED HAT (SH1106 over /dev/spidev0.0, DC/RST through the GPIO
 * character device; the same frames splanc-display plays: boot_frames.bin,
 * baked in as splash_assets.h) and on HDMI (/dev/fb0: the same animation in
 * colour, SPLH from tools/gen_boot_frames.py --hdmi-out, embedded, scaled up),
 * with a stage hint under the logo ("Starting…", "Connecting…", ...; after a
 * failed system update "Recovering…" / "Rolled back to <version>").
 *
 * It survives the switch to the real root (argv[0] starts with '@', which
 * stage 1 and systemd leave alone) and listens on the abstract unix socket
 * @splanc-splash. splanc-display, once it's loaded and the system has calmed
 * down, sends "stop hdmi=<0|1> [page=<file>]": with a page (splanc-display's
 * first HDMI frame, in the framebuffer's format) the splash first opens HDMI
 * into it (the outro: a circle growing from the logo's mark) while the OLED
 * keeps animating; then it stops drawing, closes spidev and the framebuffer,
 * replies "ok t0=<CLOCK_MONOTONIC ns> stage=<i> oled=<0|1> frame=<n> fps=<f>
 * [ver=<version>]" with its GPIO line request (DC + RST, still held so the
 * panel is not reset) attached, and exits. splanc-display continues the OLED
 * animation from t0 (splanc_display/splash.py).
 *
 * Smoothness: nice -10, mlockall, everything in RAM (the binary is static,
 * the frames are compiled in, at SPL_FPS: 60), deadline pacing on
 * CLOCK_MONOTONIC with TIMER_ABSTIME (late frames are skipped, never
 * drifted), and only the SH1106 pages / HDMI canvas pixels that changed are
 * written. SCHED_FIFO (priority 10, pinned to the last core on 4-core boards)
 * is opt-in: splanc.splash_rt=1.
 *
 * Never blocks boot: `start` forks and returns at once; every device is
 * optional (no HAT, no HDMI, no spidev: it just draws less); it exits on its own
 * after splanc.splash_max seconds (default 600).
 *
 * HDMI: only the KMS driver's framebuffer (vc4) is drawn on, never simpledrm's
 * (the firmware framebuffer that vc4 removes, from under its users, when it
 * loads in the initrd; the VT is taken only then too). splanc.splash_fb=early
 * draws on simpledrm's as well, splanc.splash_fb=0 leaves HDMI alone.
 *
 * Kernel command line: splanc.splash=0 (off), splanc.splash_oled=0,
 * splanc.splash_fb=0|early, splanc.splash_max=<s>, splanc.splash_rt=1,
 * splanc.splash_cpu=<n|-1> (with rt), splanc.splash_stats=1 (frame timing to
 * the kernel log every 10 s; a summary is always logged at exit).
 *
 * Usage:
 *   splanc-splash start             daemonize (the initrd)
 *   splanc-splash run [opts]        in the foreground
 *   splanc-splash stop [hdmi=0|1 [page=PATH]]
 *                                   ask a running splash to hand over (prints its reply)
 *   splanc-splash bench <seconds> [opts]
 *                                   pace + compose frames with no device, print timing
 *   splanc-splash hdmi-dump <frame> <text> <out>
 *                                   the HDMI canvas at a frame, with a stage text (tests)
 * opts: --oled=<spidev path|none|file:PATH> --fb=<path|none|file:WxH:PATH> --rt --no-rt
 *       --cpu=<n> --max=<s> --stats  (the file: forms are for tests: the SH1106 page
 *       stream, and a 32 bpp "framebuffer" in a file)
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/fb.h>
#include <linux/gpio.h>
#include <linux/kd.h>
#include <linux/spi/spidev.h>
#include <linux/vt.h>
#include <math.h>
#include <poll.h>
#include <sched.h>
#include <signal.h>
#include <stdarg.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

#include "splash_assets.h"

#define FRAME_BYTES (SPL_W * SPL_H / 8)
#define PIN_DC 24
#define PIN_RST 25
#define SPI_HZ 8000000 /* as luma (pi/bridge/display/splanc_display/hat.py) */
#define CONTRAST 0xCF  /* splanc-display's CONTRAST_NORMAL */
#define VT_NUM 8       /* splanc-display's SPLANC_DISPLAY_VT */
#define SOCK_NAME "splanc-splash"
#define HOUSEKEEP_NS 250000000LL

static const char *const gpio_labels[] = {"pinctrl-bcm2835", "pinctrl-bcm2711", "pinctrl-rp1", NULL};

/* ---- options ---------------------------------------------------------------- */

static struct {
	const char *oled; /* NULL: /dev/spidev0.0 */
	const char *fb;   /* NULL: /dev/fb0 */
	int rt, cpu, stats;
	double max_s;
	int bench;
	double bench_s;
	int enabled;
	int fb_early; /* also draw on simpledrm's (firmware) framebuffer */
} opt = {.rt = 0, .cpu = -2, .max_s = 600.0, .enabled = 1};

/* ---- logging ---------------------------------------------------------------- */

static int kmsg_fd = -1;
static int foreground;

static void logmsg(int level, const char *fmt, ...)
{
	char buf[512];
	va_list ap;
	int n = snprintf(buf, sizeof buf, "<%d>splanc-splash: ", level);
	va_start(ap, fmt);
	n += vsnprintf(buf + n, sizeof buf - n, fmt, ap);
	va_end(ap);
	if (n >= (int)sizeof buf - 1)
		n = sizeof buf - 2;
	buf[n++] = '\n';
	if (kmsg_fd >= 0 && !foreground)
		(void)!write(kmsg_fd, buf, n);
	else
		(void)!write(2, buf + 3, n - 3); /* without the "<6>" */
}
#define LOG(...) logmsg(6, __VA_ARGS__)
#define WARN(...) logmsg(4, __VA_ARGS__)

/* ---- time ------------------------------------------------------------------- */

static int64_t now_ns(void)
{
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return (int64_t)ts.tv_sec * 1000000000LL + ts.tv_nsec;
}

static void sleep_until(int64_t t)
{
	struct timespec ts = {t / 1000000000LL, t % 1000000000LL};
	while (clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &ts, NULL) == EINTR) {
	}
}

/* ---- frame timing stats ----------------------------------------------------- */

#define HIST_BUCKETS 200 /* 0.5 ms buckets, 0-100 ms */
struct stats {
	int64_t n, skipped, sum_int, max_int, sum_late, max_late;
	uint32_t hist_int[HIST_BUCKETS + 1], hist_late[HIST_BUCKETS + 1];
	int64_t last;
};

static void stats_add(struct stats *s, int64_t t, int64_t late)
{
	if (s->last) {
		int64_t d = t - s->last;
		s->sum_int += d;
		if (d > s->max_int)
			s->max_int = d;
		int b = (int)(d / 500000);
		s->hist_int[b > HIST_BUCKETS ? HIST_BUCKETS : b]++;
	}
	s->last = t;
	s->n++;
	if (late < 0)
		late = 0;
	s->sum_late += late;
	if (late > s->max_late)
		s->max_late = late;
	int b = (int)(late / 500000);
	s->hist_late[b > HIST_BUCKETS ? HIST_BUCKETS : b]++;
}

static double pct(const uint32_t *h, int64_t n, double p)
{
	int64_t want = (int64_t)(n * p + 0.999), acc = 0;
	for (int i = 0; i <= HIST_BUCKETS; i++) {
		acc += h[i];
		if (acc >= want)
			return (i + 1) * 0.5;
	}
	return HIST_BUCKETS * 0.5;
}

static void stats_line(const struct stats *s, const char *what, char *buf, size_t len)
{
	int64_t ni = s->n > 1 ? s->n - 1 : 1;
	snprintf(buf, len,
		 "%s: %lld frames, %lld skipped; interval mean %.2f p50 %.1f p99 %.1f max %.2f ms; "
		 "wake late mean %.3f p99 %.1f max %.2f ms",
		 what, (long long)s->n, (long long)s->skipped, s->sum_int / 1e6 / ni,
		 pct(s->hist_int, ni, 0.5), pct(s->hist_int, ni, 0.99), s->max_int / 1e6,
		 s->n ? s->sum_late / 1e6 / s->n : 0.0, pct(s->hist_late, s->n, 0.99), s->max_late / 1e6);
}

/* ---- /proc paths of the *current* root ----------------------------------------
 * After switch_root our own "/" is the emptied initramfs, so everything is
 * looked up through PID 1's root: /proc/1/root/... (proc_fd survives the move
 * of /proc). Before the switch that is the initramfs itself. */

static int proc_fd = -1;

static int open_root(const char *path, int flags)
{
	char p[256];
	if (proc_fd < 0)
		return open(path, flags | O_CLOEXEC);
	snprintf(p, sizeof p, "1/root%s", path);
	return openat(proc_fd, p, flags | O_CLOEXEC);
}

static int exists_root(const char *path)
{
	char p[256];
	if (proc_fd < 0)
		return access(path, F_OK) == 0;
	snprintf(p, sizeof p, "1/root%s", path);
	return faccessat(proc_fd, p, F_OK, 0) == 0;
}

static int read_file(int fd, char *buf, size_t len)
{
	if (fd < 0)
		return -1;
	ssize_t n = read(fd, buf, len - 1);
	close(fd);
	if (n < 0)
		return -1;
	buf[n] = 0;
	return (int)n;
}

/* ---- the OLED (SH1106 over spidev, DC/RST via GPIO v2 uAPI) ------------------ */

static struct {
	int on;       /* driving the panel */
	int spi_fd;   /* /dev/spidev0.0, or a file (file:PATH) */
	int is_file;
	int line_fd;  /* GPIO line request: DC = bit 0, RST = bit 1 */
	int dc;       /* current DC level (-1 unknown) */
	int rotate;   /* 2 (the default, 180 degrees) or 0 */
	uint8_t shown[8][SPL_W];
	int valid;
} oled = {.spi_fd = -1, .line_fd = -1, .dc = -1, .rotate = 2};

static int gpio_set(int dc, int rst)
{
	if (oled.line_fd < 0)
		return 0;
	struct gpio_v2_line_values v = {.bits = (uint64_t)(dc ? 1 : 0) | (rst ? 2 : 0), .mask = 3};
	return ioctl(oled.line_fd, GPIO_V2_LINE_SET_VALUES_IOCTL, &v);
}

static int spi_write(const uint8_t *buf, size_t len)
{
	if (oled.is_file)
		return write(oled.spi_fd, buf, len) == (ssize_t)len ? 0 : -1;
	struct spi_ioc_transfer tr;
	memset(&tr, 0, sizeof tr);
	tr.tx_buf = (uintptr_t)buf;
	tr.len = (uint32_t)len;
	tr.speed_hz = SPI_HZ;
	tr.bits_per_word = 8;
	return ioctl(oled.spi_fd, SPI_IOC_MESSAGE(1), &tr) < 0 ? -1 : 0;
}

static int oled_send(int dc, const uint8_t *buf, size_t len)
{
	if (oled.is_file) { /* test stream: records of DC level, u16 length, bytes */
		uint8_t h[3] = {(uint8_t)dc, (uint8_t)(len & 0xFF), (uint8_t)(len >> 8)};
		return write(oled.spi_fd, h, 3) == 3 ? spi_write(buf, len) : -1;
	}
	if (oled.dc != dc) {
		if (gpio_set(dc, 1) < 0)
			return -1;
		oled.dc = dc;
	}
	return spi_write(buf, len);
}

static int find_gpiochip(void)
{
	for (int i = 0; i < 16; i++) {
		char path[32];
		snprintf(path, sizeof path, "/dev/gpiochip%d", i);
		int fd = open_root(path, O_RDWR);
		if (fd < 0)
			continue;
		struct gpiochip_info info;
		if (ioctl(fd, GPIO_GET_CHIPINFO_IOCTL, &info) == 0) {
			for (int k = 0; gpio_labels[k]; k++)
				if (!strcmp(info.label, gpio_labels[k]) && info.lines > PIN_RST)
					return fd;
		}
		close(fd);
	}
	return -1;
}

static void oled_close(int keep_lines)
{
	if (oled.spi_fd >= 0)
		close(oled.spi_fd);
	oled.spi_fd = -1;
	if (!keep_lines && oled.line_fd >= 0) {
		close(oled.line_fd);
		oled.line_fd = -1;
	}
	oled.on = 0;
}

/* luma.oled's sh1106 init (128x64), then splanc-display's contrast, display on. */
static const uint8_t sh1106_init[] = {
    0xAE, 0x20, 0x10, 0xB0, 0xC8, 0x00, 0x10, 0x40, 0xA1, 0xA6, 0xA8, 0x3F, 0xA4, 0xD3, 0x00,
    0xD5, 0xF0, 0xD9, 0x22, 0xDA, 0x12, 0xDB, 0x20, 0x8D, 0x14, 0x81, CONTRAST,
};

static int oled_open(void)
{
	const char *path = opt.oled ? opt.oled : "/dev/spidev0.0";
	if (!strcmp(path, "none"))
		return -1;
	if (!strncmp(path, "file:", 5)) {
		oled.spi_fd = open(path + 5, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0644);
		oled.is_file = 1;
	} else {
		oled.spi_fd = open_root(path, O_RDWR);
	}
	if (oled.spi_fd < 0)
		return -1;
	if (!oled.is_file) {
		uint8_t mode = SPI_MODE_0, bits = 8;
		uint32_t hz = SPI_HZ;
		ioctl(oled.spi_fd, SPI_IOC_WR_MODE, &mode);
		ioctl(oled.spi_fd, SPI_IOC_WR_BITS_PER_WORD, &bits);
		ioctl(oled.spi_fd, SPI_IOC_WR_MAX_SPEED_HZ, &hz);
		int chip = find_gpiochip();
		if (chip < 0) {
			WARN("no Raspberry Pi GPIO chip: OLED off");
			oled_close(0);
			return -1;
		}
		struct gpio_v2_line_request req;
		memset(&req, 0, sizeof req);
		req.offsets[0] = PIN_DC;
		req.offsets[1] = PIN_RST;
		req.num_lines = 2;
		strcpy(req.consumer, "splanc-splash");
		req.config.flags = GPIO_V2_LINE_FLAG_OUTPUT;
		req.config.num_attrs = 1;
		req.config.attrs[0].attr.id = GPIO_V2_LINE_ATTR_ID_OUTPUT_VALUES;
		req.config.attrs[0].attr.values = 0; /* DC low, RST low: reset */
		req.config.attrs[0].mask = 3;
		int r = ioctl(chip, GPIO_V2_GET_LINE_IOCTL, &req);
		close(chip);
		if (r < 0) {
			WARN("GPIO %d/%d busy (%s): OLED off", PIN_DC, PIN_RST, strerror(errno));
			oled_close(0);
			return -1;
		}
		oled.line_fd = req.fd;
		struct timespec ms = {0, 2000000};
		nanosleep(&ms, NULL);
		gpio_set(0, 1); /* out of reset */
		nanosleep(&ms, NULL);
	}
	oled.dc = 0;
	if (oled_send(0, sh1106_init, sizeof sh1106_init) < 0) {
		WARN("SH1106 init failed: %s", strerror(errno));
		oled_close(0);
		return -1;
	}
	oled.on = 1;
	oled.valid = 0;
	return 0;
}

static int oled_display_on(void)
{
	static const uint8_t on[] = {0xAF};
	return oled_send(0, on, 1);
}

static inline int px(const uint8_t *img, int x, int y)
{
	return (img[y * (SPL_W / 8) + (x >> 3)] >> (7 - (x & 7))) & 1;
}

/* Push ``img`` (rows, MSB = left) the way luma does: rotate, then 8 pages of
 * "B0+p, 02, 10" + 128 column bytes (bit i = row 8p+i). Only changed pages. */
static int oled_show(const uint8_t *img)
{
	int first = !oled.valid;
	for (int p = 0; p < SPL_H / 8; p++) {
		uint8_t col[SPL_W];
		for (int x = 0; x < SPL_W; x++) {
			uint8_t b = 0;
			for (int i = 0; i < 8; i++) {
				int y = p * 8 + i;
				int v = oled.rotate == 2 ? px(img, SPL_W - 1 - x, SPL_H - 1 - y) : px(img, x, y);
				b |= (uint8_t)(v << i);
			}
			col[x] = b;
		}
		if (oled.valid && !memcmp(col, oled.shown[p], SPL_W))
			continue;
		uint8_t cmd[3] = {(uint8_t)(0xB0 + p), 0x02, 0x10};
		if (oled_send(0, cmd, 3) < 0 || oled_send(1, col, SPL_W) < 0)
			return -1;
		memcpy(oled.shown[p], col, SPL_W);
	}
	oled.valid = 1;
	if (first && oled_display_on() < 0)
		return -1;
	return 0;
}

/* ---- HDMI: /dev/fb0 ------------------------------------------------------------ */

/* The colour animation (SPLH, tools/gen_boot_frames.py --hdmi-out), embedded
 * as is: palette-coded delta records, decoded frame by frame into ``canvas``. */
#ifndef SPL_HDMI_FILE
#error "SPL_HDMI_FILE: the SPLH file to embed (-DSPL_HDMI_FILE=\"...\")"
#endif
__asm__(".section .rodata\n"
	".balign 16\n"
	".global spl_hdmi_data\n"
	"spl_hdmi_data:\n"
	".incbin \"" SPL_HDMI_FILE "\"\n"
	".global spl_hdmi_end\n"
	"spl_hdmi_end:\n"
	".previous\n");
extern const uint8_t spl_hdmi_data[], spl_hdmi_end[];

#define HD_TEXT_BASE 240 /* palette 240..255: the stage text's 16 coverage levels */
#define OUTRO_NS 650000000LL

static struct {
	int ok, fps, w, h, n, loop, ncol, fx, fy;
	const uint8_t *pal;
	const uint8_t **rec; /* n + 1 delta records (the last: back to loop) */
	uint32_t *rec_len;
	uint8_t *canvas, *text, *shown;
	int cur; /* the decoded frame in canvas, -1: none yet */
} hd = {.cur = -1};

static uint16_t rd16(const uint8_t *p) { return (uint16_t)(p[0] | p[1] << 8); }

static void hdmi_load(void)
{
	const uint8_t *p = spl_hdmi_data, *end = spl_hdmi_end;
	if (end - p < 19 || memcmp(p, "SPLH", 4) || p[4] != 1) {
		WARN("HDMI animation: not an SPLH v1 file");
		return;
	}
	hd.fps = p[5];
	hd.w = rd16(p + 6);
	hd.h = rd16(p + 8);
	hd.n = rd16(p + 10);
	hd.loop = rd16(p + 12);
	hd.ncol = p[14];
	hd.fx = rd16(p + 15);
	hd.fy = rd16(p + 17);
	p += 19;
	hd.pal = p;
	p += hd.ncol * 3;
	hd.rec = calloc(hd.n + 1, sizeof *hd.rec);
	hd.rec_len = calloc(hd.n + 1, sizeof *hd.rec_len);
	size_t px = (size_t)hd.w * hd.h;
	hd.canvas = calloc(px, 1);
	hd.text = calloc(px, 1);
	hd.shown = calloc(px, 1);
	if (!hd.fps || !hd.n || hd.loop >= hd.n || !hd.rec || !hd.rec_len || !hd.canvas || !hd.text || !hd.shown)
		return;
	for (int i = 0; i <= hd.n; i++) {
		if (end - p < 4)
			return;
		uint32_t len = (uint32_t)(p[0] | p[1] << 8 | p[2] << 16 | (uint32_t)p[3] << 24);
		p += 4;
		if ((size_t)(end - p) < len)
			return;
		hd.rec[i] = p;
		hd.rec_len[i] = len;
		p += len;
	}
	hd.ok = 1;
}

static int leb(const uint8_t **p, const uint8_t *end, uint32_t *v)
{
	uint32_t r = 0;
	for (int shift = 0; *p < end && shift < 32; shift += 7) {
		uint8_t b = *(*p)++;
		r |= (uint32_t)(b & 0x7F) << shift;
		if (!(b & 0x80)) {
			*v = r;
			return 0;
		}
	}
	return -1;
}

static void hdmi_apply(int r)
{
	const uint8_t *p = hd.rec[r], *end = p + hd.rec_len[r];
	size_t pos = 0, px = (size_t)hd.w * hd.h;
	while (p < end) {
		uint32_t skip, n;
		if (leb(&p, end, &skip) || leb(&p, end, &n) || pos + skip + n > px || (size_t)(end - p) < n)
			return;
		pos += skip;
		memcpy(hd.canvas + pos, p, n);
		p += n;
		pos += n;
	}
}

/* Decode up to the frame shown at ``fi`` frames into the animation (intro, then
 * the loop over and over). Every record in between is applied: deltas. */
static void hdmi_seek(int64_t fi)
{
	int want = fi < hd.loop ? (int)fi : hd.loop + (int)((fi - hd.loop) % (hd.n - hd.loop));
	for (int guard = 0; hd.cur != want && guard <= hd.n; guard++) {
		if (hd.cur == hd.n - 1) {
			hdmi_apply(hd.n);
			hd.cur = hd.loop;
		} else {
			hdmi_apply(hd.cur + 1);
			hd.cur++;
		}
	}
}

static struct {
	int fd, tty_fd;
	uint8_t *mem;
	size_t len;
	struct fb_var_screeninfo var;
	struct fb_fix_screeninfo fix;
	int *xs, *ys; /* canvas column/row -> first screen column/row (w + 1, h + 1 entries) */
	uint32_t pix[256];
	int valid;
	int64_t t0; /* the HDMI animation's clock: from the first framebuffer */
	int64_t next_check;
	int misses;
	ino_t ino;
	dev_t rdev;
	int skipped_simple;
	int text_shown;
} fb = {.fd = -1, .tty_fd = -1};

static void fb_close(void)
{
	if (fb.mem)
		munmap(fb.mem, fb.len);
	if (fb.fd >= 0)
		close(fb.fd);
	fb.mem = NULL;
	fb.fd = -1;
	fb.valid = 0;
}

/* VT 8 in graphics mode, in front: fbcon stops drawing the console over us
 * (splanc-display uses the same VT; it takes it over as it is). */
static void vt_take(void)
{
	if (fb.tty_fd >= 0)
		return;
	char path[32];
	snprintf(path, sizeof path, "/dev/tty%d", VT_NUM);
	int fd = open_root(path, O_RDWR | O_NOCTTY);
	if (fd < 0)
		return;
	ioctl(fd, VT_ACTIVATE, VT_NUM);
	ioctl(fd, KDSETMODE, KD_GRAPHICS);
	fb.tty_fd = fd;
}

static void vt_release(int keep)
{
	if (fb.tty_fd < 0)
		return;
	if (!keep) {
		ioctl(fb.tty_fd, KDSETMODE, KD_TEXT);
		ioctl(fb.tty_fd, VT_ACTIVATE, 1);
	}
	close(fb.tty_fd);
	fb.tty_fd = -1;
}

static void fb_fill(int x0, int y0, int w, int h, uint32_t c)
{
	int bpp = fb.var.bits_per_pixel / 8;
	for (int y = y0; y < y0 + h; y++) {
		uint8_t *row = fb.mem + (size_t)(y + fb.var.yoffset) * fb.fix.line_length +
			       (size_t)(x0 + fb.var.xoffset) * bpp;
		if (bpp == 4) {
			uint32_t *p = (uint32_t *)row;
			for (int x = 0; x < w; x++)
				p[x] = c;
		} else if (bpp == 2) {
			uint16_t *p = (uint16_t *)row;
			for (int x = 0; x < w; x++)
				p[x] = (uint16_t)c;
		}
	}
}

static uint32_t fb_rgb(int r, int g, int b)
{
	const struct fb_var_screeninfo *v = &fb.var;
	return (uint32_t)(r >> (8 - v->red.length)) << v->red.offset |
	       (uint32_t)(g >> (8 - v->green.length)) << v->green.offset |
	       (uint32_t)(b >> (8 - v->blue.length)) << v->blue.offset;
}

/* Where the canvas goes: centred, 3/4 of the screen (whichever side binds),
 * nearest-neighbour; the palette in the framebuffer's pixel format. */
static int fb_layout(void)
{
	free(fb.xs);
	free(fb.ys);
	fb.xs = calloc(hd.w + 1, sizeof *fb.xs);
	fb.ys = calloc(hd.h + 1, sizeof *fb.ys);
	if (!fb.xs || !fb.ys)
		return -1;
	double fx = fb.var.xres * 0.75 / hd.w, fy = fb.var.yres * 0.75 / hd.h, f = fx < fy ? fx : fy;
	int ox = (int)(fb.var.xres - hd.w * f) / 2, oy = (int)(fb.var.yres - hd.h * f) / 2;
	for (int i = 0; i <= hd.w; i++)
		fb.xs[i] = ox + (int)(i * f);
	for (int i = 0; i <= hd.h; i++)
		fb.ys[i] = oy + (int)(i * f);
	for (int i = 0; i < 256; i++)
		fb.pix[i] = 0;
	for (int i = 0; i < hd.ncol; i++)
		fb.pix[i] = fb_rgb(hd.pal[3 * i], hd.pal[3 * i + 1], hd.pal[3 * i + 2]);
	static const int text_rgb[3] = {SPL_HDMI_TEXT_RGB};
	for (int l = 1; l < 16; l++)
		fb.pix[HD_TEXT_BASE + l] = fb_rgb(text_rgb[0] * l / 15, text_rgb[1] * l / 15, text_rgb[2] * l / 15);
	return 0;
}

/* Tests: --fb=file:<W>x<H>:<path>, a 32 bpp XRGB "framebuffer" in a file. */
static void fb_file(const char *spec, int64_t now)
{
	unsigned w, h;
	char path[256];
	if (sscanf(spec, "%ux%u:%255s", &w, &h, path) != 3 || !w || !h)
		return;
	int fd = open(path, O_RDWR | O_CREAT | O_TRUNC | O_CLOEXEC, 0644);
	size_t len = (size_t)w * h * 4;
	if (fd < 0 || ftruncate(fd, (off_t)len) < 0) {
		if (fd >= 0)
			close(fd);
		return;
	}
	void *mem = mmap(NULL, len, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
	if (mem == MAP_FAILED) {
		close(fd);
		return;
	}
	memset(&fb.var, 0, sizeof fb.var);
	memset(&fb.fix, 0, sizeof fb.fix);
	fb.var.xres = fb.var.xres_virtual = w;
	fb.var.yres = fb.var.yres_virtual = h;
	fb.var.bits_per_pixel = 32;
	fb.var.red = (struct fb_bitfield){16, 8, 0};
	fb.var.green = (struct fb_bitfield){8, 8, 0};
	fb.var.blue = (struct fb_bitfield){0, 8, 0};
	fb.fix.line_length = w * 4;
	fb.fix.smem_len = (uint32_t)len;
	snprintf(fb.fix.id, sizeof fb.fix.id, "file");
	fb.fd = fd;
	fb.mem = mem;
	fb.len = len;
	if (fb_layout() < 0) {
		fb_close();
		return;
	}
	if (!fb.t0)
		fb.t0 = now;
	LOG("HDMI file %ux%u (%s)", w, h, path);
}

/* (Re)open /dev/fb0 when it appears or changes: simpledrm's early framebuffer is
 * replaced by vc4's when the KMS driver loads. */
static void fb_check(int64_t now)
{
	if (now < fb.next_check || !hd.ok)
		return;
	fb.next_check = now + 500000000LL;
	const char *path = opt.fb ? opt.fb : "/dev/fb0";
	if (!strcmp(path, "none"))
		return;
	if (!strncmp(path, "file:", 5)) {
		if (!fb.mem)
			fb_file(path + 5, now);
		return;
	}
	if (!opt.fb_early && !strcmp(path, "/dev/fb0")) {
		/* Don't even open simpledrm's framebuffer (see below): its name is in sysfs. */
		char name[64];
		if (read_file(open_root("/sys/class/graphics/fb0/name", O_RDONLY), name, sizeof name) > 0 &&
		    !strncmp(name, "simple", 6)) {
			if (fb.fd >= 0 && ++fb.misses >= 4)
				fb_close();
			if (!fb.skipped_simple) {
				LOG("HDMI: waiting for the KMS framebuffer (fb0 is the firmware's: %.*s)",
				    (int)strcspn(name, "\n"), name);
				fb.skipped_simple = 1;
			}
			return;
		}
	}
	int fd = open_root(path, O_RDWR);
	if (fd < 0) {
		/* Gone for good (2 s), or just a moment of the root switch? */
		if (fb.fd >= 0 && ++fb.misses >= 4)
			fb_close();
		return;
	}
	fb.misses = 0;
	struct fb_fix_screeninfo fix;
	struct fb_var_screeninfo var;
	struct stat st;
	if (fstat(fd, &st) < 0 || ioctl(fd, FBIOGET_FSCREENINFO, &fix) < 0 ||
	    ioctl(fd, FBIOGET_VSCREENINFO, &var) < 0) {
		close(fd);
		return;
	}
	/* The same device node (devtmpfs makes a new one when a driver replaces
	 * the framebuffer) with the same mode: keep drawing. */
	if (fb.fd >= 0 && st.st_ino == fb.ino && st.st_rdev == fb.rdev && !strncmp(fix.id, fb.fix.id, sizeof fix.id) &&
	    fix.smem_start == fb.fix.smem_start && fix.smem_len == fb.fix.smem_len && var.xres == fb.var.xres &&
	    var.yres == fb.var.yres && var.bits_per_pixel == fb.var.bits_per_pixel) {
		close(fd);
		return;
	}
	fb_close();
	if (!opt.fb_early && !strncmp(fix.id, "simple", 6)) {
		/* simpledrm: the firmware's framebuffer, which the KMS driver (vc4)
		 * unregisters when it loads, moments later, in the initrd. Leave it
		 * (and the console) alone; draw once vc4's framebuffer is there. */
		if (!fb.skipped_simple) {
			LOG("HDMI: waiting for the KMS framebuffer (%s is the firmware's)", fix.id);
			fb.skipped_simple = 1;
		}
		close(fd);
		return;
	}
	if (var.bits_per_pixel != 16 && var.bits_per_pixel != 32) {
		WARN("framebuffer %s: %u bpp unsupported", fix.id, var.bits_per_pixel);
		close(fd);
		return;
	}
	size_t len = fix.smem_len ? fix.smem_len : (size_t)fix.line_length * var.yres_virtual;
	void *mem = mmap(NULL, len, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
	if (mem == MAP_FAILED) {
		close(fd);
		return;
	}
	munlock(mem, len); /* device memory / fbdev deferred I/O: not ours to pin */
	fb.fd = fd;
	fb.ino = st.st_ino;
	fb.rdev = st.st_rdev;
	fb.mem = mem;
	fb.len = len;
	fb.fix = fix;
	fb.var = var;
	if (fb_layout() < 0) {
		fb_close();
		return;
	}
	if (!fb.t0)
		fb.t0 = now; /* HDMI plays its intro from the start when it first appears */
	vt_take();
	fb_fill(0, 0, (int)var.xres, (int)var.yres, 0);
	LOG("HDMI framebuffer %s %ux%u %u bpp: %dx%d animation at %dx%d", fix.id, var.xres, var.yres,
	    var.bits_per_pixel, hd.w, hd.h, fb.xs[hd.w] - fb.xs[0], fb.ys[hd.h] - fb.ys[0]);
}

/* Draw the HDMI frame for ``now``: the animation's frame, the stage text over it
 * (once the logo is complete), only the canvas pixels that changed. */
static void fb_show(int64_t now)
{
	if (!fb.mem || !hd.ok)
		return;
	int64_t fi = (now - fb.t0) * hd.fps / 1000000000LL;
	hdmi_seek(fi);
	int text = fi >= hd.loop;
	for (int y = 0; y < hd.h; y++) {
		const uint8_t *c = hd.canvas + (size_t)y * hd.w, *t = hd.text + (size_t)y * hd.w;
		uint8_t *sh = hd.shown + (size_t)y * hd.w;
		int y0 = fb.ys[y], ny = fb.ys[y + 1] - y0;
		if (ny <= 0)
			continue;
		for (int x = 0; x < hd.w; x++) {
			uint8_t v = text && t[x] ? (uint8_t)(HD_TEXT_BASE + t[x]) : c[x];
			if (fb.valid && v == sh[x])
				continue;
			sh[x] = v;
			int x0 = fb.xs[x], nx = fb.xs[x + 1] - x0;
			if (nx > 0)
				fb_fill(x0, y0, nx, ny, fb.pix[v]);
		}
	}
	fb.valid = 1;
}

/* ---- stage texts: the display's own glyphs (gen_splash_assets.py) ----------- */

static uint8_t oled_text[FRAME_BYTES];

static int glyph_of(const char **s)
{
	unsigned char c = (unsigned char)**s;
	if (c >= 0x20 && c < 0x7F) {
		(*s)++;
		return c - 0x20;
	}
	if (!strncmp(*s, "\xe2\x80\xa6", 3)) { /* "…" */
		*s += 3;
		return 95;
	}
	/* Anything else: skip one UTF-8 sequence, draw nothing. */
	do
		(*s)++;
	while ((**s & 0xC0) == 0x80);
	return -1;
}

/* ``text`` centred on the panel's bottom rows, exactly as splash.draw_stage. */
static void text_oled(const char *text)
{
	memset(oled_text, 0, sizeof oled_text);
	int width = 0;
	for (const char *s = text; *s;) {
		int g = glyph_of(&s);
		if (g >= 0)
			width += spl_oled_glyph[g].adv;
	}
	int x = width < SPL_W ? (SPL_W - width) / 2 : 0;
	for (const char *s = text; *s;) {
		int g = glyph_of(&s);
		if (g < 0)
			continue;
		const struct spl_glyph *gl = &spl_oled_glyph[g];
		const uint8_t *bits = spl_oled_glyph_bits + gl->off;
		for (int yy = 0; yy < gl->h; yy++)
			for (int xx = 0; xx < gl->w; xx++) {
				int px = x + gl->dx + xx, py = SPL_OLED_TEXT_Y + gl->dy + yy;
				if (bits[yy * gl->w + xx] && px >= 0 && px < SPL_W && py >= 0 && py < SPL_H)
					oled_text[py * (SPL_W / 8) + (px >> 3)] |= (uint8_t)(0x80 >> (px & 7));
			}
		x += gl->adv;
	}
}

/* The same text on the HDMI canvas, anti-aliased (coverage levels 1..15). */
static void text_hdmi(const char *text)
{
	if (!hd.ok)
		return;
	memset(hd.text, 0, (size_t)hd.w * hd.h);
	int width = 0; /* 1/64 px */
	for (const char *s = text; *s;) {
		int g = glyph_of(&s);
		if (g >= 0)
			width += spl_hdmi_glyph[g].adv;
	}
	int x = (hd.w * 64 - width) / 2, base = hd.h - hd.h / 32 - 2;
	if (x < 0)
		x = 0;
	for (const char *s = text; *s;) {
		int g = glyph_of(&s);
		if (g < 0)
			continue;
		const struct spl_glyph *gl = &spl_hdmi_glyph[g];
		const uint8_t *cov = spl_hdmi_glyph_bits + gl->off;
		int gx = (x + 32) / 64 + gl->dx;
		for (int yy = 0; yy < gl->h; yy++)
			for (int xx = 0; xx < gl->w; xx++) {
				int px = gx + xx, py = base + gl->dy + yy;
				if (px >= 0 && px < hd.w && py >= 0 && py < hd.h) {
					uint8_t *d = &hd.text[(size_t)py * hd.w + px];
					if (cov[yy * gl->w + xx] > *d)
						*d = cov[yy * gl->w + xx];
				}
			}
		x += gl->adv;
	}
}

/* ---- stages + bridge.env ---------------------------------------------------- */

static struct stat initrd_root;
static int stage, switched, env_read;

static int default_route(void)
{
	char buf[4096];
	int fd = proc_fd >= 0 ? openat(proc_fd, "net/route", O_RDONLY | O_CLOEXEC) : open("/proc/net/route", O_RDONLY);
	if (read_file(fd, buf, sizeof buf) < 0)
		return 0;
	for (char *l = strchr(buf, '\n'); l && l[1]; l = strchr(l + 1, '\n')) {
		char ifn[32];
		unsigned dst;
		if (sscanf(l + 1, "%31s %x", ifn, &dst) == 2 && dst == 0)
			return 1;
	}
	return 0;
}

/* OLED=off|i2c / OLED_ROTATE from the flasher's settings (written early in
 * stage 2 by splanc-flash-config). The initrd can't see them: until then the
 * defaults (SPI, rotated 180 degrees) apply. */
static void read_env(void)
{
	char buf[2048];
	if (read_file(open_root("/run/splanc-flash/bridge.env", O_RDONLY), buf, sizeof buf) < 0)
		return;
	env_read = 1;
	for (char *l = buf, *nl; l && *l; l = nl ? nl + 1 : NULL) {
		nl = strchr(l, '\n');
		if (!strncmp(l, "OLED=", 5) && (!strncmp(l + 5, "off", 3) || !strncmp(l + 5, "i2c", 3))) {
			if (oled.on) {
				LOG("OLED=%.3s: leaving the panel alone", l + 5);
				static const uint8_t off[] = {0xAE};
				oled_send(0, off, 1);
				oled_close(0);
			}
		} else if (!strncmp(l, "OLED_ROTATE=", 12)) {
			int r = atoi(l + 12) & 3;
			if (oled.on && r != oled.rotate) {
				if (r == 0) {
					oled.rotate = 0;
					oled.valid = 0;
				} else if (r != 2) { /* portrait: no art for it, blank instead */
					static const uint8_t off[] = {0xAE};
					oled_send(0, off, 1);
					oled_close(0);
				}
			}
		}
	}
}

/* A system update that didn't come up (image/splanc_image/sysupdate.py writes
 * these for us, root-only, in its state directory):
 *   trial         the toplevel of an update being tried; booted something else:
 *                 the trial failed and this boot rolls it back ("Recovering…");
 *   splash-notice "rolled_back <version>\n<boot id|next>\n": the update was
 *                 rolled back ("Rolled back to <version>"), shown on the boot it
 *                 names (sysupdate's confirm ages it out). */
#define SYSUPDATE_DIR "/var/lib/splanc-system-update"
#define STAGE_RECOVERING 5
#define STAGE_ROLLED_BACK 6
static char version[40];
static int64_t recovery_check;

static void recovery_detect(int64_t now)
{
	if (now < recovery_check || stage == STAGE_ROLLED_BACK)
		return;
	recovery_check = now + 1000000000LL;
	char buf[512];
	if (read_file(open_root(SYSUPDATE_DIR "/splash-notice", O_RDONLY), buf, sizeof buf) > 0 &&
	    !strncmp(buf, "rolled_back", 11)) {
		char ver[sizeof version] = "", boot[64] = "", cur[64] = "";
		sscanf(buf, "rolled_back %39s %63s", ver, boot);
		if (!strcmp(ver, "-"))
			ver[0] = 0;
		int fd = proc_fd >= 0 ? openat(proc_fd, "sys/kernel/random/boot_id", O_RDONLY | O_CLOEXEC) : -1;
		if (read_file(fd, cur, sizeof cur) > 0)
			cur[strcspn(cur, "\n")] = 0;
		if (!boot[0] || !strcmp(boot, "next") || !strcmp(boot, cur)) {
			snprintf(version, sizeof version, "%s", ver);
			stage = STAGE_ROLLED_BACK;
			LOG("stage %d: %s %s", stage, spl_stage_names[stage], version);
			return;
		}
	}
	if (stage == STAGE_RECOVERING)
		return;
	char trial[512], booted[512];
	if (read_file(open_root(SYSUPDATE_DIR "/trial", O_RDONLY), trial, sizeof trial) <= 0)
		return;
	trial[strcspn(trial, "\n")] = 0;
	ssize_t n = proc_fd >= 0 ? readlinkat(proc_fd, "1/root/run/booted-system", booted, sizeof booted - 1) : -1;
	if (n <= 0)
		return; /* not activated yet */
	booted[n] = 0;
	if (trial[0] && strcmp(trial, booted)) {
		stage = STAGE_RECOVERING;
		LOG("stage %d: %s (booted %s, the update was %s)", stage, spl_stage_names[stage], booted, trial);
	}
}

static void stage_detect(int64_t now)
{
	struct stat st;
	if (!switched && proc_fd >= 0 && fstatat(proc_fd, "1/root/", &st, 0) == 0 &&
	    (st.st_dev != initrd_root.st_dev || st.st_ino != initrd_root.st_ino)) {
		switched = 1;
		LOG("root switched");
	}
	if (switched) {
		if (!env_read)
			read_env();
		recovery_detect(now);
	}
	if (stage >= STAGE_RECOVERING)
		return; /* the recovery stages stay for the rest of the boot */
	int s = 0;
	if (switched) {
		s = 1;
		if (exists_root("/run/splanc-bridge/status.json"))
			s = 4;
		else if (default_route())
			s = 3;
		else if (exists_root("/run/NetworkManager"))
			s = 2;
	}
	if (s > stage) {
		stage = s;
		LOG("stage %d: %s", stage, spl_stage_names[stage]);
	}
}

/* The text for the current stage (both screens), redrawn when it changes. */
static void stage_text_update(void)
{
	static int drawn_stage = -1;
	static char drawn_version[sizeof version];
	if (stage == drawn_stage && !strcmp(version, drawn_version))
		return;
	char text[96];
	if (stage == STAGE_ROLLED_BACK && version[0])
		snprintf(text, sizeof text, "%s to %s", spl_stage_names[stage], version);
	else
		snprintf(text, sizeof text, "%s", spl_stage_names[stage]);
	text_oled(text);
	text_hdmi(text); /* (fb_show compares every pixel: no full redraw needed) */
	drawn_stage = stage;
	snprintf(drawn_version, sizeof drawn_version, "%s", version);
}

/* ---- the hand-off socket ------------------------------------------------------ */

static int listen_fd = -1;

static int sock_listen(void)
{
	struct sockaddr_un a;
	memset(&a, 0, sizeof a);
	a.sun_family = AF_UNIX;
	memcpy(a.sun_path + 1, SOCK_NAME, strlen(SOCK_NAME));
	socklen_t alen = (socklen_t)(offsetof(struct sockaddr_un, sun_path) + 1 + strlen(SOCK_NAME));
	int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
	if (fd < 0)
		return -1;
	if (bind(fd, (struct sockaddr *)&a, alen) < 0 || listen(fd, 4) < 0) {
		close(fd);
		return -1;
	}
	return fd;
}

/* Who may stop us: root (or our own user), or the owner of /run/splanc-display
 * (the display service's RuntimeDirectory, i.e. its user). */
static int peer_allowed(int fd)
{
	struct ucred cr;
	socklen_t l = sizeof cr;
	if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &cr, &l) < 0)
		return 0;
	if (cr.uid == 0 || cr.uid == geteuid())
		return 1;
	struct stat st;
	if (proc_fd >= 0 && fstatat(proc_fd, "1/root/run/splanc-display", &st, 0) == 0 && st.st_uid == cr.uid)
		return 1;
	WARN("stop from uid %u refused", (unsigned)cr.uid);
	return 0;
}

/* Returns a connected client that asked us to stop (its hdmi flag, and the path
 * of the first app page to open HDMI into: page=<path>), or -1. */
static int sock_poll(int *hdmi, char *page, size_t page_len)
{
	if (listen_fd < 0)
		return -1;
	for (;;) {
		int c = accept4(listen_fd, NULL, NULL, SOCK_CLOEXEC);
		if (c < 0)
			return -1;
		char buf[512] = {0};
		struct pollfd p = {c, POLLIN, 0};
		ssize_t n = 0;
		if (poll(&p, 1, 50) > 0)
			n = read(c, buf, sizeof buf - 1);
		if (n > 0 && !strncmp(buf, "stop", 4) && peer_allowed(c)) {
			*hdmi = strstr(buf, "hdmi=1") != NULL;
			const char *pg = strstr(buf, " page=");
			page[0] = 0;
			if (pg && page_len)
				snprintf(page, page_len, "%.*s", (int)strcspn(pg + 6, " \n"), pg + 6);
			return c;
		}
		close(c); /* a probe (splash.alive) or junk */
	}
}

static void sock_reply(int c, int64_t t0, int64_t frame, int with_oled)
{
	char msg[192];
	int n = snprintf(msg, sizeof msg, "ok t0=%lld stage=%d oled=%d frame=%lld fps=%d%s%s\n", (long long)t0,
			 stage, with_oled, (long long)frame, SPL_FPS, stage == STAGE_ROLLED_BACK && version[0] ? " ver=" : "",
			 stage == STAGE_ROLLED_BACK ? version : "");
	struct iovec io = {msg, (size_t)n};
	union {
		char buf[CMSG_SPACE(sizeof(int))];
		struct cmsghdr align;
	} u;
	struct msghdr m;
	memset(&m, 0, sizeof m);
	m.msg_iov = &io;
	m.msg_iovlen = 1;
	if (with_oled && oled.line_fd >= 0) {
		m.msg_control = u.buf;
		m.msg_controllen = sizeof u.buf;
		struct cmsghdr *cm = CMSG_FIRSTHDR(&m);
		cm->cmsg_level = SOL_SOCKET;
		cm->cmsg_type = SCM_RIGHTS;
		cm->cmsg_len = CMSG_LEN(sizeof(int));
		memcpy(CMSG_DATA(cm), &oled.line_fd, sizeof(int));
	}
	if (sendmsg(c, &m, MSG_NOSIGNAL) < 0)
		WARN("hand-off reply: %s", strerror(errno));
	close(c);
}

/* ---- setup ----------------------------------------------------------------------- */

static volatile sig_atomic_t quit;
static void on_signal(int s)
{
	(void)s;
	quit = 1;
}

static void cmdline_opts(void)
{
	char buf[4096];
	if (read_file(open("/proc/cmdline", O_RDONLY | O_CLOEXEC), buf, sizeof buf) < 0)
		return;
	for (char *t = strtok(buf, " \n"); t; t = strtok(NULL, " \n")) {
		if (!strcmp(t, "splanc.splash=0") || !strcmp(t, "splanc.splash=off"))
			opt.enabled = 0;
		else if (!strncmp(t, "splanc.splash_max=", 18))
			opt.max_s = atof(t + 18);
		else if (!strncmp(t, "splanc.splash_cpu=", 18))
			opt.cpu = atoi(t + 18);
		else if (!strcmp(t, "splanc.splash_rt=0"))
			opt.rt = 0;
		else if (!strcmp(t, "splanc.splash_rt=1"))
			opt.rt = 1;
		else if (!strcmp(t, "splanc.splash_oled=0"))
			opt.oled = "none";
		else if (!strcmp(t, "splanc.splash_fb=0"))
			opt.fb = "none";
		else if (!strcmp(t, "splanc.splash_fb=early"))
			opt.fb_early = 1;
		else if (!strcmp(t, "splanc.splash_stats=1"))
			opt.stats = 1;
	}
}

static void realtime(void)
{
	if (mlockall(MCL_CURRENT | MCL_FUTURE) < 0)
		WARN("mlockall: %s", strerror(errno));
	if (!opt.rt) {
		/* The default: ahead of ordinary boot work, but never able to starve it. */
		if (setpriority(PRIO_PROCESS, 0, -10) < 0)
			WARN("nice -10: %s", strerror(errno));
		return;
	}
	long ncpu = sysconf(_SC_NPROCESSORS_ONLN);
	int cpu = opt.cpu;
	if (cpu == -2) /* with RT, by default: the last core on boards with 4 */
		cpu = ncpu >= 4 ? (int)ncpu - 1 : -1;
	if (cpu >= 0 && cpu < ncpu) {
		cpu_set_t set;
		CPU_ZERO(&set);
		CPU_SET(cpu, &set);
		if (sched_setaffinity(0, sizeof set, &set) < 0)
			WARN("pin to CPU %d: %s", cpu, strerror(errno));
	}
	if (opt.rt) {
		/* The raw syscall: musl's sched_setscheduler() is a stub (ENOSYS). */
		struct sched_param sp = {.sched_priority = 10};
		if (syscall(SYS_sched_setscheduler, 0, SCHED_FIFO | SCHED_RESET_ON_FORK, &sp) < 0)
			WARN("SCHED_FIFO: %s", strerror(errno));
	}
}

/* ---- the loop ------------------------------------------------------------------ */

static void compose(uint8_t *out, int64_t fi)
{
	int idx = fi < SPL_LOOP_START ? (int)fi
				       : SPL_LOOP_START + (int)((fi - SPL_LOOP_START) % (SPL_FRAMES - SPL_LOOP_START));
	memcpy(out, spl_frames[idx], FRAME_BYTES);
	if (fi >= SPL_LOOP_START) /* the stage text shows once the logo is complete */
		for (int i = 0; i < FRAME_BYTES; i++)
			out[i] |= oled_text[i];
}

/* ---- the outro: HDMI opens into the app's first page --------------------------
 * splanc-display renders its first HDMI page into a file in the framebuffer's
 * own format and size ("stop hdmi=1 page=<path>"); the splash reveals it in a
 * circle growing from the mark, over OUTRO_NS, while the OLED keeps animating,
 * then hands over. splanc-display's first frame is that same page. */

static struct {
	int on;
	int64_t start;
	const uint8_t *page;
	size_t len;
	int cx, cy;
	double rmax;
	int *l, *r; /* per screen row: the revealed span [l, r) */
} outro;

static int outro_begin(const char *path, int64_t now)
{
	if (!fb.mem || !path[0] || !hd.ok)
		return -1;
	int fd = open_root(path, O_RDONLY);
	struct stat st;
	size_t need = (size_t)fb.fix.line_length * fb.var.yres;
	if (fd < 0 || fstat(fd, &st) < 0 || (size_t)st.st_size < need) {
		WARN("outro: %s: %s", path, fd < 0 ? strerror(errno) : "not this framebuffer's size");
		if (fd >= 0)
			close(fd);
		return -1;
	}
	void *m = mmap(NULL, need, PROT_READ, MAP_PRIVATE, fd, 0);
	close(fd);
	if (m == MAP_FAILED)
		return -1;
	outro.l = calloc(fb.var.yres, sizeof *outro.l);
	outro.r = calloc(fb.var.yres, sizeof *outro.r);
	if (!outro.l || !outro.r) {
		munmap(m, need);
		return -1;
	}
	outro.page = m;
	outro.len = need;
	int sw = fb.xs[hd.w] - fb.xs[0], shh = fb.ys[hd.h] - fb.ys[0];
	outro.cx = fb.xs[0] + hd.fx * sw / hd.w;
	outro.cy = fb.ys[0] + hd.fy * shh / hd.h;
	double dx = outro.cx > (int)fb.var.xres / 2 ? outro.cx : (int)fb.var.xres - outro.cx;
	double dy = outro.cy > (int)fb.var.yres / 2 ? outro.cy : (int)fb.var.yres - outro.cy;
	outro.rmax = sqrt(dx * dx + dy * dy) + 2;
	for (unsigned y = 0; y < fb.var.yres; y++)
		outro.l[y] = outro.r[y] = outro.cx;
	outro.start = now;
	outro.on = 1;
	return 0;
}

static void outro_copy(int y, int x0, int x1)
{
	if (x1 <= x0)
		return;
	int bpp = fb.var.bits_per_pixel / 8;
	size_t src = (size_t)y * fb.fix.line_length + (size_t)x0 * bpp;
	size_t dst = (size_t)(y + fb.var.yoffset) * fb.fix.line_length + (size_t)(x0 + fb.var.xoffset) * bpp;
	memcpy(fb.mem + dst, outro.page + src, (size_t)(x1 - x0) * bpp);
}

/* One step; 1 once the whole page is on screen. */
static int outro_step(int64_t now)
{
	double t = (double)(now - outro.start) / OUTRO_NS;
	if (t > 1)
		t = 1;
	double e = t < 0.5 ? 4 * t * t * t : 1 - pow(-2 * t + 2, 3) / 2;
	double rad = t >= 1 ? outro.rmax : e * outro.rmax;
	int ylo = (int)(outro.cy - rad), yhi = (int)(outro.cy + rad);
	if (ylo < 0)
		ylo = 0;
	if (yhi >= (int)fb.var.yres)
		yhi = (int)fb.var.yres - 1;
	for (int y = ylo; y <= yhi; y++) {
		double d = y - outro.cy, hw2 = rad * rad - d * d;
		if (hw2 < 0)
			continue;
		int hw = (int)sqrt(hw2);
		int nl = outro.cx - hw, nr = outro.cx + hw + 1;
		if (nl < 0)
			nl = 0;
		if (nr > (int)fb.var.xres)
			nr = (int)fb.var.xres;
		if (outro.l[y] >= outro.r[y]) {
			outro_copy(y, nl, nr);
		} else {
			outro_copy(y, nl, outro.l[y]);
			outro_copy(y, outro.r[y], nr);
		}
		if (nl < outro.l[y] || outro.l[y] >= outro.r[y])
			outro.l[y] = nl;
		if (nr > outro.r[y])
			outro.r[y] = nr;
	}
	if (t < 1)
		return 0;
	for (unsigned y = 0; y < fb.var.yres; y++) /* (rounding at the edges) */
		outro_copy((int)y, 0, (int)fb.var.xres);
	return 1;
}

static void outro_end(void)
{
	if (outro.page)
		munmap((void *)outro.page, outro.len);
	free(outro.l);
	free(outro.r);
	memset(&outro, 0, sizeof outro);
}

static int run(void)
{
	const int64_t period = 1000000000LL / SPL_FPS;
	struct stats st, win;
	memset(&st, 0, sizeof st);
	memset(&win, 0, sizeof win);
	uint8_t frame[FRAME_BYTES];

	if (!opt.bench) {
		if (oled_open() == 0)
			LOG("OLED on %s", opt.oled ? opt.oled : "/dev/spidev0.0");
		listen_fd = sock_listen();
		if (listen_fd < 0)
			WARN("hand-off socket: %s (another splash running?)", strerror(errno));
	}
	hdmi_load();
	realtime();

	int64_t t0 = now_ns(), next = t0, housekeep = 0, stats_at = t0 + 10000000000LL;
	int64_t end = t0 + (int64_t)((opt.bench ? opt.bench_s : opt.max_s) * 1e9);
	int64_t last_fi = -1, fi = 0;
	int client = -1, hdmi_keep = 0;
	char page[256] = "";
	if (opt.bench && hd.ok)
		fb.t0 = t0;
	stage_text_update();
	LOG("started (%s)", opt.bench ? "bench" : "boot");
	while (!quit) {
		int64_t now = now_ns();
		if (now >= end && !outro.on)
			break;
		if (!opt.bench && now >= housekeep && !outro.on) {
			housekeep = now + HOUSEKEEP_NS;
			stage_detect(now);
			stage_text_update();
			fb_check(now);
			if ((client = sock_poll(&hdmi_keep, page, sizeof page)) >= 0) {
				if (!hdmi_keep || outro_begin(page, now) < 0)
					break;
				LOG("outro into the app's first page (%s)", page);
			}
		}
		if (outro.on && (outro_step(now) || now - outro.start > 4 * OUTRO_NS))
			break;
		fi = (now - t0) / period;
		if (fi != last_fi) {
			if (last_fi >= 0 && fi > last_fi + 1)
				st.skipped += fi - last_fi - 1, win.skipped += fi - last_fi - 1;
			compose(frame, fi);
			if (oled.on && oled_show(frame) < 0) {
				WARN("OLED write failed (%s): OLED off", strerror(errno));
				oled_close(0);
			}
			if (!outro.on)
				fb_show(now);
			int64_t late = now - (t0 + fi * period);
			stats_add(&st, now, late);
			stats_add(&win, now, late);
			last_fi = fi;
		}
		if (opt.bench && !fb.mem && hd.ok)
			hdmi_seek((now - fb.t0) * hd.fps / 1000000000LL); /* the decode cost, no screen */
		if (opt.stats && now >= stats_at) {
			char line[256];
			stats_line(&win, "last 10 s", line, sizeof line);
			LOG("%s", line);
			memset(&win, 0, sizeof win);
			stats_at = now + 10000000000LL;
		}
		next = t0 + (fi + 1) * period;
		if (outro.on && next > now + period / 2)
			next = now + period / 2; /* the outro at ~2x the frame rate */
		sleep_until(next);
	}

	char line[256];
	stats_line(&st, opt.bench ? "bench" : "frames", line, sizeof line);
	if (opt.bench) {
		printf("%s\n", line);
		return 0;
	}
	LOG("%s", line);
	int oled_ok = oled.on;
	oled_close(client >= 0 && oled_ok); /* hand over: keep the line request for the reply */
	outro_end();
	fb_close();
	vt_release(client >= 0 && hdmi_keep);
	if (client >= 0) {
		sock_reply(client, t0, fi, oled_ok);
		LOG("handed over at %.2f s (stage %d, frame %lld)", (now_ns() - t0) / 1e9, stage, (long long)fi);
	} else {
		LOG("%s after %.0f s without a hand-off", quit ? "stopped" : "gave up", (now_ns() - t0) / 1e9);
	}
	if (oled.line_fd >= 0)
		close(oled.line_fd);
	return 0;
}

/* ---- client: `splanc-splash stop` ----------------------------------------------- */

static int client_stop(int hdmi, const char *page)
{
	struct sockaddr_un a;
	memset(&a, 0, sizeof a);
	a.sun_family = AF_UNIX;
	memcpy(a.sun_path + 1, SOCK_NAME, strlen(SOCK_NAME));
	socklen_t alen = (socklen_t)(offsetof(struct sockaddr_un, sun_path) + 1 + strlen(SOCK_NAME));
	int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
	if (fd < 0 || connect(fd, (struct sockaddr *)&a, alen) < 0) {
		fprintf(stderr, "splanc-splash: not running\n");
		return 1;
	}
	char req[320];
	int n = snprintf(req, sizeof req, "stop hdmi=%d%s%.256s\n", hdmi, page ? " page=" : "", page ? page : "");
	if (write(fd, req, n) != n)
		return 1;
	char buf[256];
	ssize_t r = read(fd, buf, sizeof buf - 1); /* any passed fd is closed with the socket */
	if (r <= 0)
		return 1;
	buf[r] = 0;
	fputs(buf, stdout);
	return 0;
}

/* ---- main ------------------------------------------------------------------------ */

static void parse_opts(int argc, char **argv, int from)
{
	for (int i = from; i < argc; i++) {
		const char *a = argv[i];
		if (!strncmp(a, "--oled=", 7))
			opt.oled = a + 7;
		else if (!strncmp(a, "--fb=", 5))
			opt.fb = a + 5;
		else if (!strcmp(a, "--no-rt"))
			opt.rt = 0;
		else if (!strcmp(a, "--rt"))
			opt.rt = 1;
		else if (!strncmp(a, "--cpu=", 6))
			opt.cpu = atoi(a + 6);
		else if (!strncmp(a, "--max=", 6))
			opt.max_s = atof(a + 6);
		else if (!strcmp(a, "--stats"))
			opt.stats = 1;
	}
}

/* Tests: the HDMI canvas (palette indices, stage text included as
 * 240 + level) at animation frame <fi> with stage text <text>, to <path>. */
static int hdmi_dump(int64_t fi, const char *text, const char *path)
{
	foreground = 1;
	hdmi_load();
	if (!hd.ok)
		return 1;
	hdmi_seek(fi);
	text_hdmi(text);
	int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0644);
	if (fd < 0)
		return 1;
	for (size_t i = 0; i < (size_t)hd.w * hd.h; i++) {
		uint8_t v = fi >= hd.loop && hd.text[i] ? (uint8_t)(HD_TEXT_BASE + hd.text[i]) : hd.canvas[i];
		if (write(fd, &v, 1) != 1)
			return 1;
	}
	close(fd);
	text_oled(text);
	printf("%dx%d frame %d of %d (loop %d)\n", hd.w, hd.h, hd.cur, hd.n, hd.loop);
	return 0;
}

int main(int argc, char **argv)
{
	const char *cmd = argc > 1 ? argv[1] : "";
	if (!strcmp(cmd, "hdmi-dump") && argc > 4)
		return hdmi_dump(atoll(argv[2]), argv[3], argv[4]);
	if (!strcmp(cmd, "stop"))
		return client_stop(argc > 2 && !strcmp(argv[2], "hdmi=1"),
				   argc > 3 && !strncmp(argv[3], "page=", 5) ? argv[3] + 5 : NULL);
	if (!strcmp(cmd, "bench") && argc > 2) {
		foreground = 1;
		opt.bench = 1;
		opt.bench_s = atof(argv[2]);
		opt.cpu = -1;
		parse_opts(argc, argv, 3);
		return run();
	}
	if (strcmp(cmd, "start") && strcmp(cmd, "run")) {
		fprintf(stderr, "usage: splanc-splash start | run [opts] | stop [hdmi=0|1 [page=PATH]] | bench <s> [opts] | hdmi-dump <frame> <text> <out>\n");
		return 2;
	}
	cmdline_opts();
	parse_opts(argc, argv, 2);
	if (!opt.enabled)
		return 0;

	if (!strcmp(cmd, "start")) {
		/* Never hold up the initrd: fork, and let the child carry on. */
		pid_t pid = fork();
		if (pid != 0)
			return pid < 0 ? 1 : 0;
		setsid();
		if (argv[0][0] != '@') {
			/* '@' first in argv[0]: stage 1's kill loop and systemd spare us. */
			char *nargv[] = {"@splanc-splash", "run", NULL};
			char *nenv[] = {NULL};
			int devnull = open("/dev/null", O_RDWR);
			if (devnull >= 0) {
				dup2(devnull, 0);
				dup2(devnull, 1);
				dup2(devnull, 2);
				if (devnull > 2)
					close(devnull);
			}
			execve("/proc/self/exe", nargv, nenv);
			_exit(1);
		}
	} else {
		foreground = isatty(2) || getenv("SPLASH_FOREGROUND");
	}

	kmsg_fd = open("/dev/kmsg", O_WRONLY | O_CLOEXEC);
	proc_fd = open("/proc", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
	if (proc_fd >= 0 && fstatat(proc_fd, "1/root/", &initrd_root, 0) < 0)
		memset(&initrd_root, 0, sizeof initrd_root);
	(void)!chdir("/");
	struct sigaction sa;
	memset(&sa, 0, sizeof sa);
	sa.sa_handler = on_signal;
	sigaction(SIGTERM, &sa, NULL);
	sigaction(SIGINT, &sa, NULL);
	signal(SIGPIPE, SIG_IGN);
	signal(SIGHUP, SIG_IGN);
	return run();
}
