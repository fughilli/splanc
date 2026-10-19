//! `pbview-gen <descriptor_set.bin> <out.rs> [--crate-root] [--runtime PATH]`
//!
//! Reads a protoc `--descriptor_set_out` FileDescriptorSet and writes the
//! zero-copy view module for every file in it.

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut pos = Vec::new();
    let mut opts = pbview_gen::Options::default();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--crate-root" => opts.crate_root = true,
            "--runtime" => opts.runtime = it.next().cloned(),
            _ => pos.push(a.clone()),
        }
    }
    if pos.len() != 2 {
        eprintln!("usage: pbview-gen <descriptor_set.bin> <out.rs> [--crate-root] [--runtime PATH]");
        std::process::exit(2);
    }
    let fdset = std::fs::read(&pos[0]).unwrap_or_else(|e| {
        eprintln!("pbview-gen: read {}: {e}", pos[0]);
        std::process::exit(1)
    });
    match pbview_gen::generate(&fdset, &opts) {
        Ok(code) => {
            if let Err(e) = std::fs::write(&pos[1], code) {
                eprintln!("pbview-gen: write {}: {e}", pos[1]);
                std::process::exit(1);
            }
        }
        Err(e) => {
            eprintln!("pbview-gen: {e}");
            std::process::exit(1);
        }
    }
}
