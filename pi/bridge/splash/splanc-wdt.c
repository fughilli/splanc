/*
 * splanc-wdt: arms the hardware watchdog at the very start of stage 1, so a boot
 * that stalls before systemd takes the watchdog over resets the board
 * (pi/bridge/README.md, "Safe boots"). With the Raspberry Pi's tryboot, a
 * reset during a trial boot brings the old system back.
 *
 * Before this, nothing reset a board that stalled without panicking between
 * the kernel and systemd (the initrd, the root mount, stage 2's activation):
 * systemd only opens the watchdog once it runs as PID 1.
 *
 *   splanc-wdt start    (the initrd's first command, image/nix/boot-watchdog.nix)
 *   splanc-wdt test <device> <deadline s> <cmdline file>   (foreground, for tests)
 *
 * forks a pinger that keeps the boot alive while it makes progress:
 *
 *   - opens /dev/watchdog0 (waits up to WAIT_DEVICE_S for it), sets its timeout
 *     (15 s: the bcm2835 maximum; splanc.wdt_timeout=) and pets it every
 *     timeout/3;
 *   - its argv[0] starts with '@', so stage 1's kill loop spares it and it lives
 *     on across switch_root;
 *   - as soon as PID 1 is systemd, it pets once more and closes the device
 *     WITHOUT the magic close: the watchdog stays armed, and systemd opens it
 *     early in its start-up (or, had it tried while we still held the device,
 *     again every RuntimeWatchdogSec/2 from its main loop). Releasing at once
 *     leaves only systemd's own start-up up to its watchdog set-up uncovered by
 *     a fresh pet, well under the timeout;
 *   - if PID 1 is still not systemd at the deadline (splanc.boot_deadline=,
 *     default DEADLINE_S seconds since boot; first boot, which loads the Nix
 *     database and grows the root partition, gets FIRST_BOOT_EXTRA_S more), it
 *     stops petting and exits: the board resets within the watchdog's timeout.
 *
 * Off with splanc.wdt=0, or when systemd is told to use another watchdog device
 * (systemd.watchdog_device=..., e.g. the QEMU rig's /dev/nonexistent). No
 * watchdog device: logs it and exits (the generic VM without one).
 *
 * Logs to the kernel log ("splanc-wdt: ...").
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/watchdog.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#define DEADLINE_S 180.0
#define FIRST_BOOT_EXTRA_S 600.0
#define WAIT_DEVICE_S 10.0
#define TIMEOUT_S 15
#define POLL_NS 200000000L

static int kmsg_fd = -1, proc_fd = -1, foreground;

static void logmsg(int level, const char *fmt, ...)
{
	char buf[256];
	va_list ap;
	int n = snprintf(buf, sizeof buf, "<%d>splanc-wdt: ", level);
	va_start(ap, fmt);
	n += vsnprintf(buf + n, sizeof buf - n, fmt, ap);
	va_end(ap);
	if (n >= (int)sizeof buf - 1)
		n = sizeof buf - 2;
	buf[n++] = '\n';
	if (kmsg_fd >= 0 && !foreground)
		(void)!write(kmsg_fd, buf, n);
	else
		(void)!write(2, buf + 3, n - 3);
}
#define LOG(...) logmsg(6, __VA_ARGS__)
#define WARN(...) logmsg(4, __VA_ARGS__)

static double uptime(void)
{
	struct timespec ts;
	clock_gettime(CLOCK_BOOTTIME, &ts);
	return ts.tv_sec + ts.tv_nsec / 1e9;
}

static void nap(long ns)
{
	struct timespec ts = {ns / 1000000000L, ns % 1000000000L};
	while (nanosleep(&ts, &ts) < 0 && errno == EINTR) {
	}
}

/* PID 1 is systemd (read through the /proc we opened before switch_root moved it). */
static int pid1_is_systemd(void)
{
	char exe[512];
	ssize_t n = readlinkat(proc_fd, "1/exe", exe, sizeof exe - 1);
	if (n <= 0)
		return 0;
	exe[n] = 0;
	const char *base = strrchr(exe, '/');
	base = base ? base + 1 : exe;
	return !strcmp(base, "systemd");
}

static int first_boot(void)
{
	/* nixos sd-image: present on the new root until stage 2 has loaded it. */
	return faccessat(proc_fd, "1/root/nix-path-registration", F_OK, 0) == 0;
}

struct opts {
	int enabled, timeout;
	double deadline;
	const char *device;
};

static void cmdline(struct opts *o, const char *path)
{
	static char buf[4096];
	int fd = open(path, O_RDONLY | O_CLOEXEC);
	if (fd < 0)
		return;
	ssize_t n = read(fd, buf, sizeof buf - 1);
	close(fd);
	if (n <= 0)
		return;
	buf[n] = 0;
	for (char *t = strtok(buf, " \n"); t; t = strtok(NULL, " \n")) {
		if (!strcmp(t, "splanc.wdt=0") || !strcmp(t, "splanc.wdt=off"))
			o->enabled = 0;
		else if (!strncmp(t, "splanc.boot_deadline=", 21))
			o->deadline = atof(t + 21);
		else if (!strncmp(t, "splanc.wdt_timeout=", 19))
			o->timeout = atoi(t + 19);
		else if (!strncmp(t, "systemd.watchdog_device=", 24) && strcmp(t + 24, "/dev/watchdog0") &&
			 strcmp(t + 24, "/dev/watchdog")) {
			LOG("systemd uses %s: not arming /dev/watchdog0", t + 24);
			o->enabled = 0;
		}
	}
}

static int run(struct opts *o)
{
	int fd = -1;
	double t0 = uptime();
	while ((fd = open(o->device, O_WRONLY | O_CLOEXEC)) < 0) {
		if (errno != ENOENT || uptime() - t0 > WAIT_DEVICE_S) {
			LOG("no watchdog (%s: %s): stage 1 runs unguarded", o->device, strerror(errno));
			return 0;
		}
		nap(POLL_NS);
	}
	int timeout = o->timeout;
	if (ioctl(fd, WDIOC_SETTIMEOUT, &timeout) < 0 && ioctl(fd, WDIOC_GETTIMEOUT, &timeout) < 0)
		timeout = o->timeout;
	if (timeout < 3)
		timeout = 3;
	double pet = timeout / 3.0, last_pet = -1e9, deadline = o->deadline;
	int extended = 0;
	LOG("armed %s (%d s): pets it until systemd takes over, at most until %.0f s after boot", o->device,
	    timeout, deadline);
	for (;;) {
		double now = uptime();
		if (!extended && proc_fd >= 0 && first_boot()) {
			extended = 1;
			deadline += FIRST_BOOT_EXTRA_S;
			LOG("first boot: deadline %.0f s", deadline);
		}
		if (proc_fd >= 0 && pid1_is_systemd()) {
			ioctl(fd, WDIOC_KEEPALIVE, 0);
			close(fd); /* no magic close: stays armed for systemd */
			LOG("systemd is up at %.1f s: handing the watchdog over", now);
			return 0;
		}
		if (now >= deadline) {
			close(fd);
			WARN("the boot did not reach systemd within %.0f s: the watchdog resets the board", deadline);
			return 1;
		}
		if (now - last_pet >= pet) {
			if (ioctl(fd, WDIOC_KEEPALIVE, 0) < 0)
				(void)!write(fd, "\0", 1);
			last_pet = now;
		}
		nap(POLL_NS);
	}
}

int main(int argc, char **argv)
{
	const char *cmd = argc > 1 ? argv[1] : "";
	struct opts o = {.enabled = 1, .timeout = TIMEOUT_S, .deadline = DEADLINE_S, .device = "/dev/watchdog0"};
	if (!strcmp(cmd, "test")) {
		/* Foreground: test <device> <deadline: s from now> <cmdline file> */
		foreground = 1;
		if (argc > 2)
			o.device = argv[2];
		cmdline(&o, argc > 4 ? argv[4] : "/proc/cmdline");
		if (argc > 3) /* here: seconds from now */
			o.deadline = uptime() + atof(argv[3]);
	} else if (!strcmp(cmd, "start")) {
		cmdline(&o, "/proc/cmdline");
		if (!o.enabled)
			return 0;
		/* Never hold up the initrd: fork, and let the child carry on as
		 * "@splanc-wdt" ('@' first in argv[0]: stage 1's kill loop spares it). */
		pid_t pid = fork();
		if (pid != 0)
			return pid < 0 ? 1 : 0;
		setsid();
		char *nargv[] = {"@splanc-wdt", "daemon", NULL};
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
	} else if (!strcmp(cmd, "daemon")) {
		cmdline(&o, "/proc/cmdline");
	} else {
		fprintf(stderr, "usage: splanc-wdt start | test <device> <deadline s> <cmdline file>\n");
		return 2;
	}
	if (!o.enabled)
		return 0;
	kmsg_fd = open("/dev/kmsg", O_WRONLY | O_CLOEXEC);
	proc_fd = open("/proc", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
	(void)!chdir("/");
	return run(&o);
}
