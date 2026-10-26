//! Userspace real-time setup for the output thread (no kernel driver, no
//! PREEMPT_RT): SCHED_FIFO for this thread only, CPU pinning, mlockall.
//!
//! Priorities: Linux threaded IRQ handlers run at SCHED_FIFO 50 and the SPI
//! controller's message pump (`spi0` kthread) is raised to 46 by the unit's
//! ExecStartPre (apps.nix), so the output thread defaults to **45**: above all
//! normal work (the WSS server, the FX render pool), below the IRQ threads and
//! the SPI pump it blocks on, so it can never starve the interrupts that
//! complete its own transfer.
//!
//! Needs CAP_SYS_NICE (FIFO, affinity) and CAP_IPC_LOCK (mlockall beyond
//! RLIMIT_MEMLOCK); the systemd unit grants both as ambient capabilities. Each
//! step reports failure and the player carries on without it.

use std::io;

pub const DEFAULT_OUTPUT_PRIO: i32 = 45;

/// SCHED_FIFO at `prio` for the CALLING thread. The raw syscall: on Linux,
/// sched_setscheduler(0) is per-thread, and musl's libc wrapper is a stub
/// returning ENOSYS.
pub fn set_thread_fifo(prio: i32) -> io::Result<()> {
    // The kernel's struct sched_param is a single int (musl's libc struct adds
    // SCHED_SPORADIC fields the syscall never reads).
    let param: libc::c_int = prio;
    // SAFETY: valid kernel sched_param; tid 0 = calling thread.
    let rc = unsafe {
        libc::syscall(libc::SYS_sched_setscheduler, 0 as libc::pid_t, libc::SCHED_FIFO, &param)
    };
    if rc < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// The calling thread's scheduling policy (for the start-up log).
pub fn thread_policy() -> i32 {
    // SAFETY: tid 0 = calling thread.
    unsafe { libc::syscall(libc::SYS_sched_getscheduler, 0 as libc::pid_t) as i32 }
}

/// Pin the calling thread to one CPU.
pub fn pin_thread_to_cpu(cpu: usize) -> io::Result<()> {
    // SAFETY: zeroed cpu_set_t is the empty set; CPU_SET bounds-checks.
    unsafe {
        let mut set: libc::cpu_set_t = std::mem::zeroed();
        libc::CPU_SET(cpu, &mut set);
        if libc::sched_setaffinity(0, std::mem::size_of::<libc::cpu_set_t>(), &set) < 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

/// Number of online CPUs.
pub fn online_cpus() -> usize {
    // SAFETY: sysconf has no preconditions.
    let n = unsafe { libc::sysconf(libc::_SC_NPROCESSORS_ONLN) };
    if n < 1 {
        1
    } else {
        n as usize
    }
}

/// The default output CPU: the last one (`isolcpus` in apps.nix isolates the
/// same CPU), or None on a single-core board where pinning buys nothing.
pub fn default_output_cpu(ncpu: usize) -> Option<usize> {
    if ncpu > 1 {
        Some(ncpu - 1)
    } else {
        None
    }
}

const CAP_IPC_LOCK: u32 = 14;

/// Whether `CapEff:` (hex, from /proc/self/status) holds CAP_IPC_LOCK.
pub fn capeff_has_ipc_lock(status: &str) -> bool {
    status
        .lines()
        .find_map(|l| l.strip_prefix("CapEff:"))
        .and_then(|h| u64::from_str_radix(h.trim(), 16).ok())
        .is_some_and(|caps| caps & (1 << CAP_IPC_LOCK) != 0)
}

/// Locking is only safe when it can't hit RLIMIT_MEMLOCK later: with
/// MCL_FUTURE, every later mapping (e.g. a tokio worker's 8 MiB stack) counts
/// against the limit, and a capped limit would make thread creation fail.
pub fn can_lock_unbounded() -> bool {
    let mut lim = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
    // SAFETY: valid out-pointer.
    let unlimited = unsafe { libc::getrlimit(libc::RLIMIT_MEMLOCK, &mut lim) } == 0
        && lim.rlim_cur == libc::RLIM_INFINITY;
    unlimited
        || std::fs::read_to_string("/proc/self/status").is_ok_and(|s| capeff_has_ipc_lock(&s))
}

/// mlockall(MCL_CURRENT | MCL_FUTURE): no page faults (and no swap-in) on the
/// output path. Process-wide; call once before spawning threads. Refuses
/// (EPERM) without CAP_IPC_LOCK or an unlimited RLIMIT_MEMLOCK; see
/// `can_lock_unbounded`.
pub fn lock_all_memory() -> io::Result<()> {
    if !can_lock_unbounded() {
        return Err(io::Error::from_raw_os_error(libc::EPERM));
    }
    // SAFETY: plain syscall wrapper.
    if unsafe { libc::mlockall(libc::MCL_CURRENT | libc::MCL_FUTURE) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// Parse a `--rt-cpu` value: `auto` (last CPU), `none`/`-1` (don't pin), or N.
pub fn parse_cpu(spec: &str, ncpu: usize) -> Result<Option<usize>, String> {
    match spec {
        "auto" => Ok(default_output_cpu(ncpu)),
        "none" | "-1" => Ok(None),
        n => match n.parse::<usize>() {
            Ok(c) if c < ncpu => Ok(Some(c)),
            Ok(c) => Err(format!("--rt-cpu {c}: only {ncpu} CPUs online")),
            Err(_) => Err(format!("--rt-cpu {n:?}: expected auto, none or a CPU number")),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cpu_spec() {
        assert_eq!(parse_cpu("auto", 4), Ok(Some(3)));
        assert_eq!(parse_cpu("auto", 1), Ok(None));
        assert_eq!(parse_cpu("none", 4), Ok(None));
        assert_eq!(parse_cpu("-1", 4), Ok(None));
        assert_eq!(parse_cpu("2", 4), Ok(Some(2)));
        assert!(parse_cpu("4", 4).is_err());
        assert!(parse_cpu("x", 4).is_err());
    }

    #[test]
    fn capeff_parsing() {
        assert!(capeff_has_ipc_lock("Name:\tx\nCapEff:\t000001ffffffffff\n"));
        assert!(capeff_has_ipc_lock("CapEff:\t0000000000004000\n"));
        assert!(!capeff_has_ipc_lock("CapEff:\t0000000000800000\n")); // CAP_SYS_NICE only
        assert!(!capeff_has_ipc_lock("CapPrm:\t0000000000004000\n"));
    }

    #[test]
    fn pinning_to_cpu0_works_unprivileged() {
        // Affinity within the allowed set needs no capability; run on a thread
        // so the test harness's own thread keeps its mask.
        std::thread::spawn(|| pin_thread_to_cpu(0).unwrap()).join().unwrap();
    }

    #[test]
    fn fifo_either_applies_or_reports_eperm() {
        std::thread::spawn(|| match set_thread_fifo(DEFAULT_OUTPUT_PRIO) {
            Ok(()) => assert_eq!(thread_policy(), libc::SCHED_FIFO),
            Err(e) => assert_eq!(e.raw_os_error(), Some(libc::EPERM), "{e}"),
        })
        .join()
        .unwrap();
    }
}
