# The HITL test container image (nix dockerTools). sshd + an ESP32 toolbox.
#
# The manager runs this per reservation with the ESP32 attached and the holder's
# key mounted at /run/hitl/authorized_keys; the entrypoint installs the key and
# starts sshd. Toolbox is MVP (flash + serial); BLE/JTAG tools are commented in
# as they get exercised (they're just more packages in `contents`).
#
# NOTE: sshd-in-a-container has known sharp edges (privsep user, host keys, no
# PAM); this is a reasonable skeleton but wants a real on-rig smoke test.
{ pkgs }:
let
  sshUser = "agent";

  sshdConfig = pkgs.writeText "sshd_config" ''
    Port 22
    PermitRootLogin no
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    UsePAM no
    AuthorizedKeysFile /home/${sshUser}/.ssh/authorized_keys
    Subsystem sftp ${pkgs.openssh}/libexec/sftp-server
    PidFile /run/sshd.pid
  '';

  entrypoint = pkgs.writeShellApplication {
    name = "hitl-entrypoint";
    runtimeInputs = [ pkgs.openssh pkgs.coreutils ];
    text = ''
      user="''${HITL_SSH_USER:-${sshUser}}"
      mkdir -p /run /etc/ssh
      ssh-keygen -A                 # host keys under /etc/ssh
      install -d -m700 -o "$user" -g "$user" "/home/$user/.ssh"
      if [ -f /run/hitl/authorized_keys ]; then
        install -m600 -o "$user" -g "$user" /run/hitl/authorized_keys "/home/$user/.ssh/authorized_keys"
      else
        echo "WARN: no /run/hitl/authorized_keys mounted" >&2
      fi
      exec ${pkgs.openssh}/bin/sshd -D -e -f ${sshdConfig}
    '';
  };

  toolbox = with pkgs; [
    bashInteractive
    coreutils
    openssh
    # ESP flashing + serial (MVP):
    esptool
    picocom
    python3
    python3Packages.pyserial
    # --- next layers (add as exercised) ---
    # linuxPackages.usbip           # attach the dev board inside the container
    # openocd gdb                   # JTAG debug port
    # bluez python3Packages.bleak   # BLE scan/connect/commands
  ];
in
pkgs.dockerTools.buildLayeredImage {
  name = "hitl-test";
  tag = "latest";
  contents = toolbox;
  # Seed a minimal rootfs: the agent + sshd-privsep users, /tmp, /var/empty.
  extraCommands = ''
    mkdir -p tmp var/empty home/${sshUser} run
    chmod 1777 tmp
    cat > etc/passwd <<EOF
    root:x:0:0:root:/root:${pkgs.bashInteractive}/bin/bash
    ${sshUser}:x:1000:1000:agent:/home/${sshUser}:${pkgs.bashInteractive}/bin/bash
    sshd:x:74:74:sshd privsep:/var/empty:/run/current-system/sw/bin/nologin
    EOF
    cat > etc/group <<EOF
    root:x:0:
    ${sshUser}:x:1000:
    sshd:x:74:
    EOF
    chown -R 1000:1000 home/${sshUser}
  '';
  config = {
    Cmd = [ "${entrypoint}/bin/hitl-entrypoint" ];
    ExposedPorts = { "22/tcp" = { }; };
    Env = [ "PATH=/bin:/usr/bin:/run/current-system/sw/bin" ];
  };
}
