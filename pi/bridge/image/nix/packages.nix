# Packages for the Splanc bridge image.
#
#   agentBundle  the Splanc agent bundle pinned in ../agent-pin.json (version +
#                sha256 of a firmware-v* release asset), unpacked. The image's
#                fallback agent: the bridge self-updates newer bundles into
#                /var/lib/splanc-agent (see splanc_image/selfupdate.py).
#   pyEnv        Python for the display + appliance helpers: Pillow, segno,
#                luma.oled/luma.core, gpiozero + lgpio (Pi 5's RP1 GPIO), spidev,
#                smbus2, cbor2.
#   splancPy     pi/bridge/display/splanc_display + pi/bridge/image/splanc_image,
#                byte-compiled, as a PYTHONPATH entry, plus the OLED boot
#                animation rendered from web/public/icons/splanc.svg by
#                pi/bridge/tools/gen_boot_frames.py (Pillow only; as Bazel's
#                //pi/bridge:boot_frames does for the agent bundle).
#   fonts        the four DejaVu faces the screens draw with (not the whole family).
#
# luma.core / luma.oled / segno come from PyPI at exactly the versions + sha256
# in pi/bridge/display/requirements.lock (the Pi OS installer's lockfile), so the
# image and `install.sh` run the same display stack. lgpio (not in nixpkgs) is
# built from its PyPI sdist with the C library linked in statically.
{ lib, fetchurl, runCommand, stdenvNoCC, python3, swig, dejavu_fonts }:
let
  pin = lib.importJSON ../agent-pin.json;
  ps = python3.pkgs;

  # requirements.lock: "name==ver \<newline> --hash=sha256:<hex>" entries.
  lockText = builtins.replaceStrings [ "\\\n" ] [ " " ] (builtins.readFile ../../display/requirements.lock);
  lockEntries = lib.filter (m: m != null) (map
    (l: builtins.match "([A-Za-z0-9_.-]+)==([^ ]+)[ ]+--hash=sha256:([0-9a-f]{64})[ ]*" l)
    (lib.splitString "\n" lockText));
  locked = lib.listToAttrs (map
    (m: lib.nameValuePair (builtins.elemAt m 0) {
      version = builtins.elemAt m 1;
      sha256 = builtins.elemAt m 2;
    })
    lockEntries);

  # A pure-Python wheel from the lockfile.
  lockedWheel = name: { dependencies ? [ ], imports ? [ ] }:
    let
      e = locked.${name} or (throw "pi/bridge/display/requirements.lock has no ${name}");
      stem = builtins.replaceStrings [ "." "-" ] [ "_" "_" ] name;
      file = "${stem}-${e.version}-py3-none-any.whl";
    in
    ps.buildPythonPackage {
      pname = name;
      inherit (e) version;
      format = "wheel";
      src = fetchurl {
        url = "https://files.pythonhosted.org/packages/py3/${builtins.substring 0 1 name}/${name}/${file}";
        inherit (e) sha256;
      };
      inherit dependencies;
      # luma.core's other requirements are extras (rpi-lgpio, pyftdi) we don't use.
      dontCheckRuntimeDeps = true;
      pythonImportsCheck = imports;
    };

  segno = lockedWheel "segno" { imports = [ "segno" ]; };
  luma-core = lockedWheel "luma.core" {
    dependencies = [ ps.pillow ps.smbus2 ps.cbor2 ps.spidev ];
    imports = [ "luma.core.interface.serial" ];
  };
  luma-oled = lockedWheel "luma.oled" {
    dependencies = [ luma-core ];
    imports = [ "luma.oled.device" ];
  };

  lgpio = ps.buildPythonPackage rec {
    pname = "lgpio";
    version = "0.2.2.0";
    pyproject = true;
    src = fetchurl {
      url = "https://files.pythonhosted.org/packages/source/l/lgpio/lgpio-${version}.tar.gz";
      sha256 = "11372e653b200f76a0b3ef8a23a0735c85ec678a9f8550b9893151ed0f863fff";
    };
    build-system = [ ps.setuptools ];
    nativeBuildInputs = [ swig ];
    # setup.py: PYPI=1 compiles liblgpio into the extension (no system library).
    env.PYPI = "1";
    # Importing lgpio creates its notify FIFO in $LG_WD (default: the cwd, which
    # for pythonImportsCheck is $out), so check the import from $TMPDIR instead.
    postInstall = ''
      (cd "$TMPDIR" && LG_WD="$TMPDIR" PYTHONPATH="$out/${python3.sitePackages}:$PYTHONPATH" python3 -c "import lgpio")
    '';
    meta.license = lib.licenses.unlicense;
  };

  pyEnv = python3.withPackages (_: [
    ps.pillow
    segno
    luma-core
    luma-oled
    ps.gpiozero
    lgpio
    ps.spidev
    ps.smbus2
    ps.cbor2
  ]);

  splancPy = runCommand "splanc-bridge-py" { nativeBuildInputs = [ pyEnv ]; } ''
    mkdir -p $out
    cp -R ${lib.fileset.toSource {
      root = ../../display;
      fileset = lib.fileset.fileFilter (f: f.hasExt "py") ../../display/splanc_display;
    }}/splanc_display $out/
    cp -R ${lib.fileset.toSource {
      root = ../.;
      fileset = lib.fileset.fileFilter (f: f.hasExt "py") ../splanc_image;
    }}/splanc_image $out/
    chmod -R u+w $out
    python3 ${../../tools/gen_boot_frames.py} --svg ${../../../../web/public/icons/splanc.svg} \
      --out $out/splanc_display/boot_frames.bin
    python3 -m compileall -q $out
    # Smoke: the modules import with this exact environment.
    PYTHONPATH=$out python3 -c 'import splanc_display.main, splanc_display.hat, splanc_image.selfupdate, splanc_image.bootconfig; from splanc_display import boot; assert boot.load()'
  '';

  fonts = runCommand "splanc-bridge-fonts" { } ''
    mkdir -p $out
    for f in DejaVuSans DejaVuSans-Bold DejaVuSansMono DejaVuSansMono-Bold; do
      cp ${dejavu_fonts}/share/fonts/truetype/$f.ttf $out/
    done
  '';

  agentBundle = stdenvNoCC.mkDerivation {
    pname = "splanc-agent";
    inherit (pin) version;
    src = fetchurl { inherit (pin) url sha256; };
    nativeBuildInputs = [ python3 ];
    unpackPhase = ''
      mkdir unpack
      tar -xzf $src -C unpack --no-same-owner
    '';
    dontConfigure = true;
    dontBuild = true;
    installPhase = ''
      top=unpack/splanc-agent-${pin.version}
      test -f $top/mcp/splanc-agent.mjs
      python3 - $top/bundle.json ${lib.escapeShellArg pin.version} <<'EOF'
      import json, sys
      v = json.load(open(sys.argv[1])).get("version")
      assert v == sys.argv[2], f"bundle.json says {v}, agent-pin.json says {sys.argv[2]}"
      EOF
      cp -R $top $out
    '';
    dontFixup = true;
  };
in
{
  inherit agentBundle pyEnv splancPy fonts lgpio luma-core luma-oled segno pin;
}
