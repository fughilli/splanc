/*
 * splanc-splash: the Splanc bridge's early boot splash (pi/bridge/README.md,
 * "Boot splash").
 *
 * Started from the NixOS initrd (image/nix/splash.nix) as soon as the SPI
 * controller and spidev are loaded, it plays the boot animation (the same
 * frames splanc-display plays: boot_frames.bin, baked in as splash_assets.h)
 * on the Waveshare OLED HAT (SH1106 over /dev/spidev0.0, DC/RST through the GPIO
 * character device) and on HDMI (/dev/fb0, scaled up), with a stage hint under
 * the logo ("Starting…", "Connecting…", ...).
 *
 * It survives the switch to the real root (argv[0] starts with '@', which
 * stage 1 and systemd leave alone) and listens on the abstract unix socket
 * @splanc-splash. splanc-display, once it's loaded and the system has calmed
 * down, sends "stop hdmi=<0|1>": the splash stops drawing, closes spidev and
 * the framebuffer, replies "ok t0=<CLOCK_MONOTONIC ns> stage=<i> oled=<0|1>
 * frame=<n>" with its GPIO line request (DC + RST, still held so the panel is
 * not reset) attached, and exits. splanc-display continues the animation from
 * t0 (splanc_display/splash.py).
 *
 * Smoothness: SCHED_FIFO (priority 10), mlockall, everything in RAM (the
 * binary is static, the frames are compiled in), deadline pacing on
 * CLOCK_MONOTONIC with TIMER_ABSTIME (late frames are skipped, never
 * drifted), only the SH1106 pages / framebuffer cells that changed are
 * written, and on 4-core boards it runs on the last core. A frame costs well
 * under a millisecond; the kernel's RT throttling (95%) bounds it anyway.
 *
 * Never blocks boot: `start` forks and returns at once; every device is
 * optional (no HAT, no HDMI, no spidev: it just draws less); it exits on its own
 * after splanc.splash_max seconds (default 600).
 *
 * Kernel command line: splanc.splash=0 (off), splanc.splash_max=<s>,
 * splanc.splash_cpu=<n|-1>, splanc.splash_rt=0, splanc.splash_stats=1 (frame
 * timing to the kernel log every 10 s; a summary is always logged at exit).
 *
 * Usage:
 *   splanc-splash start             daemonize (the initrd)
 *   splanc-splash run [opts]        in the foreground
 *   splanc-splash stop [hdmi=0|1]   ask a running splash to hand over (prints its reply)
 *   splanc-splash bench <seconds> [opts]
 *                                   pace + compose frames with no device, print timing
 * opts: --oled=<spidev path|none|file:PATH> --fb=<path|none> --no-rt --cpu=<n>
 *       --max=<s> --stats  (file:PATH writes the SH1106 page stream, for tests)
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/fb.h>
#include <linux/gpio.h>
#include <linux/kd.h>
#include <linux/spi/spidev.h>
#include <linux/vt.h>
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
} opt = {.rt = 1, .cpu = -2, .max_s = 600.0, .enabled = 1};

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

static struct {
	int fd, tty_fd;
	uint8_t *mem;
	size_t len;
	struct fb_var_screeninfo var;
	struct fb_fix_screeninfo fix;
	int scale, ox, oy;
	uint8_t shown[FRAME_BYTES];
	int valid;
	int64_t next_check;
	int misses;
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

/* (Re)open /dev/fb0 when it appears or changes: simpledrm's early framebuffer is
 * replaced by vc4's when the KMS driver loads. */
static void fb_check(int64_t now)
{
	if (now < fb.next_check)
		return;
	fb.next_check = now + 500000000LL;
	const char *path = opt.fb ? opt.fb : "/dev/fb0";
	if (!strcmp(path, "none"))
		return;
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
	if (ioctl(fd, FBIOGET_FSCREENINFO, &fix) < 0 || ioctl(fd, FBIOGET_VSCREENINFO, &var) < 0) {
		close(fd);
		return;
	}
	if (fb.fd >= 0 && !strncmp(fix.id, fb.fix.id, sizeof fix.id) && fix.smem_start == fb.fix.smem_start &&
	    fix.smem_len == fb.fix.smem_len && var.xres == fb.var.xres && var.yres == fb.var.yres &&
	    var.bits_per_pixel == fb.var.bits_per_pixel) {
		close(fd);
		return;
	}
	fb_close();
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
	fb.mem = mem;
	fb.len = len;
	fb.fix = fix;
	fb.var = var;
	int s = (int)(var.xres * 6 / 10 / SPL_W);
	int s2 = (int)(var.yres * 6 / 10 / SPL_H);
	fb.scale = s < s2 ? s : s2;
	if (fb.scale < 1)
		fb.scale = 1;
	fb.ox = ((int)var.xres - SPL_W * fb.scale) / 2;
	fb.oy = ((int)var.yres - SPL_H * fb.scale) / 2;
	if (fb.ox < 0)
		fb.ox = 0;
	if (fb.oy < 0)
		fb.oy = 0;
	vt_take();
	fb_fill(0, 0, (int)var.xres, (int)var.yres, 0);
	LOG("HDMI framebuffer %s %ux%u %u bpp, scale %d", fix.id, var.xres, var.yres, var.bits_per_pixel,
	    fb.scale);
}

static void fb_show(const uint8_t *img)
{
	if (!fb.mem)
		return;
	uint32_t white = fb.var.bits_per_pixel == 16 ? 0xFFFF : 0x00FFFFFF;
	int s = fb.scale;
	for (int y = 0; y < SPL_H; y++)
		for (int xb = 0; xb < SPL_W / 8; xb++) {
			int i = y * (SPL_W / 8) + xb;
			uint8_t diff = fb.valid ? (uint8_t)(img[i] ^ fb.shown[i]) : 0xFF;
			if (!diff)
				continue;
			for (int b = 0; b < 8; b++)
				if (diff & (0x80 >> b)) {
					int x = xb * 8 + b;
					fb_fill(fb.ox + x * s, fb.oy + y * s, s, s, (img[i] & (0x80 >> b)) ? white : 0);
				}
		}
	memcpy(fb.shown, img, FRAME_BYTES);
	fb.valid = 1;
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

static void stage_detect(void)
{
	struct stat st;
	if (!switched && proc_fd >= 0 && fstatat(proc_fd, "1/root/", &st, 0) == 0 &&
	    (st.st_dev != initrd_root.st_dev || st.st_ino != initrd_root.st_ino)) {
		switched = 1;
		LOG("root switched");
	}
	int s = 0;
	if (switched) {
		s = 1;
		if (exists_root("/run/splanc-bridge/status.json"))
			s = 4;
		else if (default_route())
			s = 3;
		else if (exists_root("/run/NetworkManager"))
			s = 2;
		if (!env_read)
			read_env();
	}
	if (s > stage) {
		stage = s;
		LOG("stage %d: %s", stage, spl_stage_names[stage]);
	}
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

/* Returns a connected client that asked us to stop (and its hdmi flag), or -1. */
static int sock_poll(int *hdmi)
{
	if (listen_fd < 0)
		return -1;
	for (;;) {
		int c = accept4(listen_fd, NULL, NULL, SOCK_CLOEXEC);
		if (c < 0)
			return -1;
		char buf[64] = {0};
		struct pollfd p = {c, POLLIN, 0};
		ssize_t n = 0;
		if (poll(&p, 1, 50) > 0)
			n = read(c, buf, sizeof buf - 1);
		if (n > 0 && !strncmp(buf, "stop", 4) && peer_allowed(c)) {
			*hdmi = strstr(buf, "hdmi=1") != NULL;
			return c;
		}
		close(c); /* a probe (splash.alive) or junk */
	}
}

static void sock_reply(int c, int64_t t0, int64_t frame, int with_oled)
{
	char msg[128];
	int n = snprintf(msg, sizeof msg, "ok t0=%lld stage=%d oled=%d frame=%lld\n", (long long)t0, stage,
			 with_oled, (long long)frame);
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
		else if (!strcmp(t, "splanc.splash_stats=1"))
			opt.stats = 1;
	}
}

static void realtime(void)
{
	if (mlockall(MCL_CURRENT | MCL_FUTURE) < 0)
		WARN("mlockall: %s", strerror(errno));
	long ncpu = sysconf(_SC_NPROCESSORS_ONLN);
	int cpu = opt.cpu;
	if (cpu == -2) /* default: the last core on boards with 4 */
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
			out[i] |= spl_stage_text[stage][i];
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
	realtime();

	int64_t t0 = now_ns(), next = t0, housekeep = 0, stats_at = t0 + 10000000000LL;
	int64_t end = t0 + (int64_t)((opt.bench ? opt.bench_s : opt.max_s) * 1e9);
	int64_t last_fi = -1, fi = 0;
	int client = -1, hdmi_keep = 0;
	LOG("started (%s)", opt.bench ? "bench" : "boot");
	while (!quit) {
		int64_t now = now_ns();
		if (now >= end)
			break;
		if (!opt.bench && now >= housekeep) {
			housekeep = now + HOUSEKEEP_NS;
			stage_detect();
			fb_check(now);
			if ((client = sock_poll(&hdmi_keep)) >= 0)
				break;
		}
		fi = (now - t0) / period;
		if (fi != last_fi) {
			if (last_fi >= 0 && fi > last_fi + 1)
				st.skipped += fi - last_fi - 1, win.skipped += fi - last_fi - 1;
			compose(frame, fi);
			if (oled.on && oled_show(frame) < 0) {
				WARN("OLED write failed (%s): OLED off", strerror(errno));
				oled_close(0);
			}
			fb_show(frame);
			int64_t late = now - (t0 + fi * period);
			stats_add(&st, now, late);
			stats_add(&win, now, late);
			last_fi = fi;
		}
		if (opt.stats && now >= stats_at) {
			char line[256];
			stats_line(&win, "last 10 s", line, sizeof line);
			LOG("%s", line);
			memset(&win, 0, sizeof win);
			stats_at = now + 10000000000LL;
		}
		next = t0 + (fi + 1) * period;
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

static int client_stop(int hdmi)
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
	char req[32];
	int n = snprintf(req, sizeof req, "stop hdmi=%d\n", hdmi);
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
		else if (!strncmp(a, "--cpu=", 6))
			opt.cpu = atoi(a + 6);
		else if (!strncmp(a, "--max=", 6))
			opt.max_s = atof(a + 6);
		else if (!strcmp(a, "--stats"))
			opt.stats = 1;
	}
}

int main(int argc, char **argv)
{
	const char *cmd = argc > 1 ? argv[1] : "";
	if (!strcmp(cmd, "stop"))
		return client_stop(argc > 2 && !strcmp(argv[2], "hdmi=1"));
	if (!strcmp(cmd, "bench") && argc > 2) {
		foreground = 1;
		opt.bench = 1;
		opt.bench_s = atof(argv[2]);
		opt.cpu = -1;
		parse_opts(argc, argv, 3);
		return run();
	}
	if (strcmp(cmd, "start") && strcmp(cmd, "run")) {
		fprintf(stderr, "usage: splanc-splash start | run [opts] | stop [hdmi=0|1] | bench <s> [opts]\n");
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
