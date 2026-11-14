//! fx_sign: lower a `.fxb` to a native image and sign it as a `.fxn`
//! (firmware/fx_sig; docs/design/fx-native-aot.md, "Trust").
//!
//! ```text
//! fx_sign sign   --fxb in.fxb --out out.fxn [--key-file K --key-id N]
//!                [--epoch E] [--min-fw X.Y.Z|0] [--scope fleet|aa:bb:cc:dd:ee:ff]
//! fx_sign verify --fxn in.fxn --fxb in.fxb [--key-file K] [--fw X.Y.Z|0]
//! ```
//!
//! Without `--key-file` the public **dev key** (id 0) signs — what every device
//! accepts today, and what dev builds use automatically. A key file holds 32
//! raw bytes or 64 hex characters; its contents are never printed.

use std::process::exit;

use ledmapper_fx_aot as aot;
use ledmapper_fx_vm::Program;
use splanc_fx_sig as sig;

fn die(msg: &str) -> ! {
    eprintln!("fx_sign: {msg}");
    exit(2)
}

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).map(|i| {
        args.get(i + 1)
            .cloned()
            .unwrap_or_else(|| die(&format!("{name} needs a value")))
    })
}

fn read(path: &str) -> Vec<u8> {
    std::fs::read(path).unwrap_or_else(|e| die(&format!("read {path}: {e}")))
}

fn load_key(args: &[String]) -> (u8, Vec<u8>) {
    match arg(args, "--key-file") {
        None => (sig::DEV_KEY_ID, sig::DEV_KEY.to_vec()),
        Some(p) => {
            let raw = read(&p);
            let txt = String::from_utf8_lossy(&raw);
            let t = txt.trim();
            let key = if raw.len() == 32 {
                raw
            } else if t.len() == 64 && t.bytes().all(|c| c.is_ascii_hexdigit()) {
                (0..32)
                    .map(|i| u8::from_str_radix(&t[2 * i..2 * i + 2], 16).unwrap())
                    .collect()
            } else {
                die("key file must hold 32 raw bytes or 64 hex characters")
            };
            let id = arg(args, "--key-id")
                .map(|s| s.parse().unwrap_or_else(|_| die("bad --key-id")))
                .unwrap_or_else(|| die("--key-file needs --key-id"));
            if id == sig::DEV_KEY_ID {
                die("key id 0 is reserved for the public dev key");
            }
            (id, key)
        }
    }
}

fn fw(s: &str) -> u32 {
    if s == "0" {
        0
    } else {
        sig::parse_fw_version(s).unwrap_or_else(|| die(&format!("bad version {s:?} (X.Y.Z or 0)")))
    }
}

fn scope(s: &str) -> [u8; 8] {
    if s == "fleet" {
        return sig::SCOPE_FLEET;
    }
    let mut out = [0u8; 8];
    let parts: Vec<&str> = s.split(':').collect();
    if parts.is_empty() || parts.len() > 8 {
        die("bad --scope");
    }
    for (i, p) in parts.iter().enumerate() {
        out[i] = u8::from_str_radix(p, 16).unwrap_or_else(|_| die("bad --scope"));
    }
    out
}

fn sign(args: &[String]) {
    let fxb_path = arg(args, "--fxb").unwrap_or_else(|| die("--fxb required"));
    let out_path = arg(args, "--out").unwrap_or_else(|| die("--out required"));
    let fxb = read(&fxb_path);
    let prog = Program::parse(&fxb).unwrap_or_else(|e| die(&format!("parse .fxb: {e:?}")));
    let img =
        aot::lower(&prog).unwrap_or_else(|| die("not lowerable (the effect stays on the VM)"));
    if let Some(e) = img.verify() {
        die(&format!(
            "the sandbox verifier rejected the lowered image: {e:?}"
        ));
    }
    let (key_id, key) = load_key(args);
    let entry = |o: Option<usize>| o.map(|v| v as u16).unwrap_or(sig::NO_ENTRY);
    let header = sig::Header {
        key_id,
        key_epoch: arg(args, "--epoch")
            .map(|s| s.parse().unwrap_or_else(|_| die("bad --epoch")))
            .unwrap_or(0),
        abi: aot::NATIVE_ABI,
        flags: 0,
        min_fw: arg(args, "--min-fw").map(|s| fw(&s)).unwrap_or(0),
        scope: arg(args, "--scope")
            .map(|s| scope(&s))
            .unwrap_or(sig::SCOPE_FLEET),
        code_words: 0,
        op_code_len: 0,
        update_off: entry(img.update_off),
        shade_off: img.shade_off as u16,
        prep_off: entry(img.prep_off),
        tag: [0; sig::TAG_LEN],
    };
    let mut out = vec![0u8; sig::HEADER_LEN + 4 * img.code.len() + img.op_code.len()];
    let n = sig::build_into(&mut out, &key, header, &img.code, &img.op_code, &fxb)
        .unwrap_or_else(|| die("image too large for a .fxn"));
    out.truncate(n);
    std::fs::write(&out_path, &out).unwrap_or_else(|e| die(&format!("write {out_path}: {e}")));
    let h = sig::Header::decode(&out).unwrap();
    println!(
        "signed {out_path}: {} bytes, {} code words, key_id={} epoch={} abi={} min_fw={} tag={}",
        n,
        img.code.len(),
        h.key_id,
        h.key_epoch,
        h.abi,
        h.min_fw,
        h.tag.iter().map(|b| format!("{b:02x}")).collect::<String>()
    );
}

fn verify(args: &[String]) {
    let blob = read(&arg(args, "--fxn").unwrap_or_else(|| die("--fxn required")));
    let fxb = read(&arg(args, "--fxb").unwrap_or_else(|| die("--fxb required")));
    let fxn = sig::Fxn::parse(&blob).unwrap_or_else(|e| die(&format!("container: {}", e.as_str())));
    let mut ring = sig::KeyRing::with_dev_key(sig::SoftSha256::new);
    if arg(args, "--key-file").is_some() {
        let (id, key) = load_key(args);
        ring.install(id, &key, sig::SoftSha256::new);
    }
    let dev = sig::Device {
        fw_version: arg(args, "--fw").map(|s| fw(&s)).unwrap_or(u32::MAX),
        abis: &[aot::NATIVE_ABI],
        device_id: fxn.header.scope,
    };
    let mut lim = sig::Limiter::default();
    match sig::verify(
        &fxn,
        &fxb,
        &ring,
        &sig::Policy::default(),
        &dev,
        &mut lim,
        0,
        sig::SoftSha256::new,
    ) {
        Ok(()) => println!(
            "ok: key_id={} abi={} min_fw={}",
            fxn.header.key_id, fxn.header.abi, fxn.header.min_fw
        ),
        Err(e) => {
            println!("rejected: {}", e.as_str());
            exit(1)
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("sign") => sign(&args[1..]),
        Some("verify") => verify(&args[1..]),
        _ => die("usage: fx_sign sign|verify ... (see the module docs)"),
    }
}
