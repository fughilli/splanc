use ledmapper_fx_vm as fxv;

/// Exercise raw words before RGB quantization can hide a mismatch. The live
/// prefix straddles the register/deep-frame boundary and survives every call.
pub fn raw_program(op: &[u8], pop: u8, push: u8, prefix: u8) -> Vec<u8> {
    use fxv::Op;
    let mut code = Vec::new();
    for slot in 0..prefix + pop {
        code.extend_from_slice(&[Op::LoadUniform as u8, slot, 1]);
    }
    code.extend_from_slice(op);
    code.extend_from_slice(&[Op::StoreState as u8, 0, prefix + push, Op::Ret as u8, 0]);
    let mut bytes = fxv::MAGIC.to_vec();
    bytes.extend_from_slice(&[1, 0, prefix + push, prefix + pop]);
    bytes.extend_from_slice(&0u16.to_le_bytes()); // manifest
    bytes.extend_from_slice(&0u16.to_le_bytes()); // constants
    bytes.extend_from_slice(&(code.len() as u16).to_le_bytes());
    bytes.extend_from_slice(&fxv::NO_ENTRY.to_le_bytes());
    bytes.extend_from_slice(&0u16.to_le_bytes()); // shade
    bytes.extend_from_slice(&code);
    bytes
}

pub const EDGES: &[u32] = &[
    0, 0x80000000, 1, 0x80000001, 0x007fffff, 0x807fffff, 0x00800000, 0x80800000, 0x3f800000,
    0xbf800000, 0x3f000000, 0x7f7fffff, 0xff7fffff, 0x7f800000, 0xff800000, 0x7fc12345, 0xffc54321,
    0x7f812345, 0xff854321, 0x4effffff, 0x4f000000, 0xcf000000, 0xcf000001, 0x7fffffff, 0xffffffff,
    0x3effffff,
];

pub fn cases() -> Vec<(Vec<u8>, u8, u8)> {
    use fxv::Op;
    let mut cases = Vec::new();
    for n in 1..=4 {
        for op in [Op::Add, Op::Sub, Op::Mul, Op::Div] {
            cases.push((vec![op as u8, n], 2 * n, n));
        }
        cases.push((vec![Op::Neg as u8, n], n, n));
        for f in 0..=fxv::F_TAN {
            cases.push((vec![Op::UnMath as u8, f, n], n, n));
        }
        for f in 0..=fxv::B_ATAN2 {
            cases.push((vec![Op::BinMath as u8, f, n], 2 * n, n));
        }
        for op in [Op::Clamp, Op::Smoothstep] {
            cases.push((vec![op as u8, n], 3 * n, n));
        }
    }
    for kind in 0..=5 {
        cases.push((vec![Op::Cmp as u8, kind], 2, 1));
    }
    for kind in 0..=2 {
        cases.push((
            vec![Op::Logic as u8, kind],
            if kind == 2 { 1 } else { 2 },
            1,
        ));
    }
    for op in [Op::I2F, Op::F2I, Op::Fix2F, Op::F2Fix, Op::Hash1] {
        cases.push((vec![op as u8], 1, 1));
    }
    // frac 31 faults in the VM (and is refused by the lowering): see
    // `frac_over_30_stays_on_vm` in diff.rs.
    for frac in [0, 1, 8, 16, 30] {
        for op in [Op::FixToF, Op::FixFromF] {
            cases.push((vec![op as u8, frac], 1, 1));
        }
    }
    cases.push((vec![Op::Hash3 as u8], 3, 1));
    cases.push((vec![Op::Hsv2Rgb as u8], 3, 3));
    for id in 0..=7 {
        cases.push((vec![Op::Palette as u8, id], 1, 3));
    }
    cases
}
