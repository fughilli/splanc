//! Who runs, and when an app counts as healthy (docs/design/ota.md "Boot
//! flow"). Pure decision functions; the firmware feeds them what it reads from
//! otadata, NVS, RTC memory and the reset reason, and does what they say.
//!
//! The stock IDF bootloader does the first half (app rollback is enabled in the
//! prebuilt bootloader): it boots the app slot when otadata selects it, and a
//! freshly installed app boots *pending verify*; if that app resets before it
//! marks itself valid, the bootloader marks it aborted and boots the loader.

/// The app slot as the loader sees it (`esp_ota_get_state_partition` plus an
/// image check).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AppState {
    /// No valid app image in the slot (erased, half-written, bad hash).
    Missing,
    /// Valid image; otadata says nothing against it (valid, undefined, or no
    /// entry — e.g. the app selected the loader, which erases otadata).
    Bootable,
    /// The bootloader rolled it back: it reset while pending verify.
    Aborted,
    /// The app itself gave up (failed its health check) and asked to roll back.
    Invalid,
}

/// Why the chip reset (`esp_reset_reason`, folded).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reset {
    PowerOn,
    Brownout,
    Software,
    Panic,
    Watchdog,
    Other,
}

impl Reset {
    /// A reset the code didn't ask for and didn't cause: the power went away.
    pub fn is_power_loss(self) -> bool {
        matches!(self, Reset::PowerOn | Reset::Brownout)
    }

    pub fn is_crash(self) -> bool {
        matches!(self, Reset::Panic | Reset::Watchdog)
    }
}

/// What the app asked for when it restarted into the loader (NVS, one-shot).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Handoff {
    None,
    /// An update is coming: wait for the client, then return to the app if it
    /// never shows up.
    Update,
    /// Stay in recovery (ota_reboot{target: LOADER}).
    Stay,
    /// The app's crash-loop guard tripped.
    CrashLoop,
}

impl Handoff {
    pub fn to_u8(self) -> u8 {
        match self {
            Handoff::None => 0,
            Handoff::Update => 1,
            Handoff::Stay => 2,
            Handoff::CrashLoop => 3,
        }
    }

    pub fn from_u8(v: u8) -> Handoff {
        match v {
            1 => Handoff::Update,
            2 => Handoff::Stay,
            3 => Handoff::CrashLoop,
            _ => Handoff::None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LoaderInputs {
    pub app: AppState,
    /// A resume record exists: the slot holds part of an image.
    pub update_incomplete: bool,
    pub handoff: Handoff,
    pub reset: Reset,
    /// The power-loss retry was already spent on the pending image.
    pub retry_spent: bool,
}

/// Why the loader stays up (`ota_status.loader_reason`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    /// The app handed over for an update.
    Update,
    /// Asked to stay (ota_reboot to the loader).
    Requested,
    /// Power or connection lost mid-transfer: the slot holds part of an image.
    Incomplete,
    NoApp,
    /// The new app crashed, hung or failed its health check before it proved
    /// healthy; the bootloader (or the app) rolled it back.
    RolledBack,
    CrashLoop,
}

impl Reason {
    pub fn code(self) -> &'static str {
        match self {
            Reason::Update => "update",
            Reason::Requested => "requested",
            Reason::Incomplete => "incomplete",
            Reason::NoApp => "no_app",
            Reason::RolledBack => "rolled_back",
            Reason::CrashLoop => "crash_loop",
        }
    }

    /// How long recovery waits with no update session before it gives the app
    /// another go (None: until an update or an explicit ota_reboot). Only a
    /// handoff whose client never arrived returns by itself; a failed app
    /// stays failed.
    pub fn idle_timeout_ms(self) -> Option<u32> {
        match self {
            Reason::Update => Some(5 * 60 * 1000),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LoaderAction {
    BootApp,
    /// Boot the aborted app once more: it was rolled back by a power cut
    /// during its verify window, not by anything it did.
    RetryApp,
    Recover(Reason),
}

pub fn loader_decide(i: &LoaderInputs) -> LoaderAction {
    if i.update_incomplete {
        return LoaderAction::Recover(Reason::Incomplete);
    }
    match i.handoff {
        Handoff::Update => return LoaderAction::Recover(Reason::Update),
        Handoff::Stay => return LoaderAction::Recover(Reason::Requested),
        Handoff::CrashLoop => return LoaderAction::Recover(Reason::CrashLoop),
        Handoff::None => {}
    }
    match i.app {
        AppState::Missing => LoaderAction::Recover(Reason::NoApp),
        AppState::Invalid => LoaderAction::Recover(Reason::RolledBack),
        AppState::Aborted if i.reset.is_power_loss() && !i.retry_spent => LoaderAction::RetryApp,
        AppState::Aborted => LoaderAction::Recover(Reason::RolledBack),
        AppState::Bootable => LoaderAction::BootApp,
    }
}

// -- app side: crash-loop guard ------------------------------------------------

/// Consecutive crash resets (each within [`STABLE_UPTIME_MS`] of boot) after
/// which a validated app hands itself to the loader. Rollback only covers an
/// app that fails *before* it proves healthy; this covers one that fails after.
pub const CRASH_LOOP_LIMIT: u32 = 3;
/// Uptime after which a boot counts as stable (the counter clears).
pub const STABLE_UPTIME_MS: u32 = 60_000;

/// The crash counter for this boot, from the RTC no-init copy (`prev`, valid
/// only when `magic_ok`) and the reset reason. The firmware clears it to 0
/// once the boot has been up [`STABLE_UPTIME_MS`].
pub fn crash_count(prev: u32, magic_ok: bool, reset: Reset) -> u32 {
    if !magic_ok || !reset.is_crash() {
        return 0;
    }
    prev.saturating_add(1)
}

pub fn crash_loop(count: u32) -> bool {
    count >= CRASH_LOOP_LIMIT
}

// -- app side: health ------------------------------------------------------------

/// An app is healthy once it has been up this long with every check passing.
pub const HEALTHY_AFTER_MS: u32 = 20_000;
/// A pending app that isn't healthy by now rolls itself back; the RTC watchdog
/// (armed for [`WATCHDOG_MS`]) backs that up if the app is too wedged to.
pub const HEALTH_DEADLINE_MS: u32 = 120_000;
pub const WATCHDOG_MS: u32 = 150_000;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Health {
    pub uptime_ms: u32,
    /// The render task advanced recently.
    pub render_alive: bool,
    /// The TLS identity is ready (the :443 listener may come up).
    pub tls_ready: bool,
    /// The loader was on the network when it booted this app, so the app must
    /// get there too: credentials restored and a DHCP lease held. Without it
    /// (no credentials, or the AP was down) the network can't be held against
    /// the image — an AP outage must not roll back a good update.
    pub network_required: bool,
    pub leased: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    Wait,
    Healthy,
    /// Give up; the code names the first unmet check.
    Failed(&'static str),
}

fn first_unmet(h: &Health) -> Option<&'static str> {
    if !h.render_alive {
        return Some("render");
    }
    if !h.tls_ready {
        return Some("tls");
    }
    if h.network_required && !h.leased {
        return Some("network");
    }
    None
}

pub fn health(h: &Health) -> Verdict {
    match first_unmet(h) {
        None if h.uptime_ms >= HEALTHY_AFTER_MS => Verdict::Healthy,
        Some(why) if h.uptime_ms >= HEALTH_DEADLINE_MS => Verdict::Failed(why),
        _ => Verdict::Wait,
    }
}
