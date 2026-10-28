//! The one-shot trial entry (docs/design/max-ota.md "Trial boot").
//!
//! NixOS's extlinux builder (generic-extlinux-compatible) copies each
//! generation's kernel, initrd and device trees into `/boot/nixos/<clean name>`
//! and writes `/boot/extlinux/extlinux.conf` with `DEFAULT nixos-default`. The
//! updater leaves that file alone until the new system has proven healthy: the
//! trial gets its own `/boot/extlinux/splanc-trial.conf`, in the builder's format
//! with the builder's file names, which U-Boot boots only when the one-shot flag
//! says so. Any later `switch-to-configuration` deletes boot files no generation
//! uses, so a stale trial can only disappear, never linger as a default.

/// `/nix/store/<hash>-<name>/file` -> `<hash>-<name>-file` (the builder's cleanName).
pub fn clean_name(path: &str) -> String {
    path.trim_start_matches("/nix/store/").replace('/', "-")
}

/// A system's boot inputs, resolved (`readlink -f`) from its toplevel.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BootFiles {
    pub kernel: String,
    pub initrd: String,
    /// The dtbs directory, when the system has one.
    pub dtbs: Option<String>,
    /// `<toplevel>/kernel-params`, verbatim (one line).
    pub params: String,
}

/// Whether the builder put an FDTDIR/FDT line in the default entry (it doesn't
/// when the firmware provides the device tree, as on the U-Boot Pis). The trial
/// mirrors it, so it boots with the same device-tree source as every generation.
pub fn uses_fdt(conf: &str) -> bool {
    let mut in_default = false;
    for line in conf.lines() {
        let t = line.trim();
        if let Some(label) = t.strip_prefix("LABEL ") {
            in_default = label.trim() == "nixos-default";
        } else if in_default && (t.starts_with("FDTDIR ") || t.starts_with("FDT ")) {
            return true;
        }
    }
    false
}

/// The kernel parameter that marks a trial boot (read back from /proc/cmdline).
pub const TRIAL_PARAM: &str = "splanc.ota=trial";

/// The trial conf: one entry, no menu, booted at once.
pub fn trial_conf(toplevel: &str, f: &BootFiles, fdt: bool, version_label: &str) -> String {
    let base = |p: &str| clean_name(p);
    let mut s = String::new();
    s.push_str("# Splanc MAX OTA trial boot (docs/design/max-ota.md). Booted ONCE, only when\n");
    s.push_str("# the one-shot flag on the firmware partition says so; never the default.\n");
    s.push_str("DEFAULT splanc-trial\n\nTIMEOUT 1\n\n");
    s.push_str("LABEL splanc-trial\n");
    s.push_str(&format!("  MENU LABEL Splanc MAX trial {version_label}\n"));
    s.push_str(&format!("  LINUX ../nixos/{}\n", base(&f.kernel)));
    s.push_str(&format!("  INITRD ../nixos/{}\n", base(&f.initrd)));
    s.push_str(&format!("  APPEND init={toplevel}/init {} {TRIAL_PARAM}\n", f.params.trim()));
    if fdt {
        if let Some(d) = &f.dtbs {
            s.push_str(&format!("  FDTDIR ../nixos/{}\n", base(d)));
        }
    }
    s
}

/// The files the trial needs under /boot/nixos: (store source, file name).
pub fn boot_copies(f: &BootFiles, fdt: bool) -> Vec<(String, String)> {
    let mut v = vec![(f.kernel.clone(), clean_name(&f.kernel)), (f.initrd.clone(), clean_name(&f.initrd))];
    if fdt {
        if let Some(d) = &f.dtbs {
            v.push((d.clone(), clean_name(d)));
        }
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    const CONF: &str = "# Generated file\nDEFAULT nixos-default\n\nTIMEOUT 10\n\nLABEL nixos-default\n  MENU LABEL NixOS - Default\n  LINUX ../nixos/aaa-linux-6.6-Image\n  INITRD ../nixos/bbb-initrd-initrd\n  APPEND init=/nix/store/ccc-nixos-system/init loglevel=4\n\nLABEL nixos-3-default\n  FDTDIR ../nixos/ddd-dtbs\n";

    #[test]
    fn mirrors_the_builder() {
        assert_eq!(clean_name("/nix/store/aaa-linux-6.6/Image"), "aaa-linux-6.6-Image");
        // FDTDIR only counts inside the default entry.
        assert!(!uses_fdt(CONF));
        assert!(uses_fdt(&CONF.replace("  APPEND init", "  FDTDIR ../nixos/x\n  APPEND init")));
        let f = BootFiles {
            kernel: "/nix/store/aaa-linux-6.6/Image".into(),
            initrd: "/nix/store/bbb-initrd/initrd".into(),
            dtbs: Some("/nix/store/eee-dtbs".into()),
            params: "console=tty1 loglevel=4\n".into(),
        };
        let c = trial_conf("/nix/store/fff-nixos-system", &f, false, "1.10.0");
        assert!(c.contains("DEFAULT splanc-trial"));
        assert!(c.contains("  LINUX ../nixos/aaa-linux-6.6-Image\n"));
        assert!(c.contains("  INITRD ../nixos/bbb-initrd-initrd\n"));
        assert!(c.contains("  APPEND init=/nix/store/fff-nixos-system/init console=tty1 loglevel=4 splanc.ota=trial\n"));
        assert!(!c.contains("FDTDIR"));
        assert!(trial_conf("/nix/store/fff", &f, true, "x").contains("  FDTDIR ../nixos/eee-dtbs\n"));
        assert_eq!(boot_copies(&f, false).len(), 2);
        assert_eq!(boot_copies(&f, true)[2].1, "eee-dtbs");
    }
}
