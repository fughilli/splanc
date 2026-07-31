# The HITL test container image (nix dockerTools). sshd + an ESP32 toolbox.
#
# The manager runs this per reservation with the ESP32 attached and the holder's
# key mounted at /run/hitl/authorized_keys; the entrypoint installs the key and
# starts sshd. Toolbox is MVP (flash + serial); BLE/JTAG tools are added as they
# get exercised (just more packages in `toolbox`).
{ pkgs }:
let
  # esptool pulls python-ecdsa, which nixpkgs currently flags insecure. Permit it
  # just for this image by re-importing nixpkgs with the allowance, so the caller
  # needn't set it globally.
  p = import pkgs.path {
    inherit (pkgs.stdenv.hostPlatform) system;
    config = (pkgs.config or { }) // {
      permittedInsecurePackages = [ "python3.12-ecdsa-0.19.1" ];
    };
  };

  sshUser = "agent";

  # nixpkgs esptool ships esptool.py/espefuse.py/espsecure.py; add no-suffix
  # aliases so `esptool` etc. (what agents reflexively type) also work.
  espAliases = p.runCommand "esp-aliases" { } ''
    mkdir -p $out/bin
    ln -s ${p.esptool}/bin/esptool.py   $out/bin/esptool
    ln -s ${p.esptool}/bin/espefuse.py  $out/bin/espefuse
    ln -s ${p.esptool}/bin/espsecure.py $out/bin/espsecure
  '';

  toolbox = with p; [
    bashInteractive
    coreutils
    openssh
    # ESP flashing + serial (MVP):
    esptool
    espAliases
    picocom
    python3
    python3Packages.pyserial
    # --- next layers (add as exercised) ---
    # linuxPackages.usbip           # attach the dev board inside the container
    # openocd gdb                   # JTAG debug port
    # bluez python3Packages.bleak   # BLE scan/connect/commands
  ];
  toolPath = p.lib.makeBinPath toolbox;

  sshdConfig = p.writeText "sshd_config" ''
    Port 22
    PermitRootLogin no
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    UsePAM no
    AuthorizedKeysFile /home/${sshUser}/.ssh/authorized_keys
    Subsystem sftp ${p.openssh}/libexec/sftp-server
    PidFile /run/sshd.pid
    SetEnv PATH=${toolPath}:/bin:/usr/bin
  '';

  entrypoint = p.writeShellApplication {
    name = "hitl-entrypoint";
    runtimeInputs = [ p.openssh p.coreutils ];
    text = ''
      user="''${HITL_SSH_USER:-${sshUser}}"
      mkdir -p /run /etc/ssh
      ssh-keygen -A                 # host keys under /etc/ssh
      # Fix home ownership at runtime (root here); build-time chown isn't allowed.
      chown -R "$user":"$user" "/home/$user" 2>/dev/null || true
      install -d -m700 -o "$user" -g "$user" "/home/$user/.ssh"
      if [ -f /run/hitl/authorized_keys ]; then
        install -m600 -o "$user" -g "$user" /run/hitl/authorized_keys "/home/$user/.ssh/authorized_keys"
        echo "hitl: installed $(wc -l < "/home/$user/.ssh/authorized_keys") authorized key(s) for $user" >&2
      else
        echo "hitl: WARN no /run/hitl/authorized_keys mounted" >&2
      fi
      # Diagnostics for pubkey-auth issues (StrictModes checks these):
      ls -lad "/home/$user" "/home/$user/.ssh" "/home/$user/.ssh/authorized_keys" >&2 2>/dev/null || true
      # Make passed-through serial/JTAG nodes usable by the (non-root) agent —
      # they arrive with the host's root:dialout 660 perms. The container is
      # ephemeral + single-user, so opening them up is fine.
      for dev in /dev/ttyACM* /dev/ttyUSB*; do
        if [ -e "$dev" ]; then chmod a+rw "$dev" 2>/dev/null || true; fi
      done
      exec ${p.openssh}/bin/sshd -D -e -f ${sshdConfig}
    '';
  };
in
p.dockerTools.buildLayeredImage {
  name = "hitl-test";
  tag = "latest";
  contents = toolbox;
  # Minimal rootfs: the agent + sshd-privsep users, /tmp, a login profile that
  # puts the toolbox on PATH for interactive SSH shells.
  extraCommands = ''
    mkdir -p tmp var/empty home/${sshUser} run etc/profile.d
    chmod 1777 tmp
    cat > etc/passwd <<EOF
    root:x:0:0:root:/root:${p.bashInteractive}/bin/bash
    ${sshUser}:x:1000:1000:agent:/home/${sshUser}:${p.bashInteractive}/bin/bash
    sshd:x:74:74:sshd privsep:/var/empty:${p.shadow}/bin/nologin
    EOF
    cat > etc/group <<EOF
    root:x:0:
    ${sshUser}:x:1000:
    sshd:x:74:
    EOF
    printf 'export PATH=%s:/bin:/usr/bin\n' "${toolPath}" > etc/profile
    cp etc/profile etc/bashrc
  '';
  config = {
    Cmd = [ "${entrypoint}/bin/hitl-entrypoint" ];
    ExposedPorts = { "22/tcp" = { }; };
    Env = [ "PATH=${toolPath}:/bin:/usr/bin" ];
  };
}
