//! Verifier tests. Each sandbox-escape proof of concept from the #351 review
//! (A–F in `verifier_poc.rs`), plus variants of each hole, must be REJECTED.
//! The positive side is that canonical images, and every image the lowerer
//! emits for the corpus (tests/diff.rs, fx_perf_bench host test), verify.

use super::*;
use crate::{ctx, direct, enc};

const LIM: VerifyLimits = VerifyLimits::DEFAULT;
/// Word index of the first budget check (the loop header) in [`skel`].
const HDR: usize = PROLOGUE_LEN;
/// No-ops between the header check and the body, so the check's `bge +8`
/// target is never inside a helper window a test body starts with.
const PAD: usize = 8;
/// Word index of the first body word in [`skel`].
const BODY: usize = PROLOGUE_LEN + 3 + PAD;
const GP: u32 = 3;
const TP: u32 = 4;
const A5: u32 = 15;

/// A canonical function around `body`: prologue, a budget check (the loop
/// header at [`HDR`]), the body, exit stub, epilogue. The body falls through
/// into the stub.
fn skel(body: &[u32]) -> Vec<u32> {
    let mut c = prologue_words(LIM.budget).to_vec();
    c.extend_from_slice(&budget_check_head(1));
    let jal_at = c.len();
    c.push(0);
    c.extend_from_slice(&[enc::addi(ZERO, ZERO, 0); PAD]);
    c.extend_from_slice(body);
    let stub = c.len();
    c[jal_at] = enc::jal(ZERO, ((stub - jal_at) * 4) as i32);
    c.extend_from_slice(&exit_stub_words());
    c.extend_from_slice(&epilogue_words());
    c
}
fn check(body: &[u32]) -> Option<VerifyErr> {
    verify(&skel(body), &[0], &LIM)
}
/// Byte offset from body word `from` to absolute word `to`.
fn rel(from: usize, to: usize) -> i32 {
    (to as i32 - (BODY + from) as i32) * 4
}
fn generic_call() -> [u32; 8] {
    [
        enc::addi(A0, S0, 0),
        enc::addi(A1, S1, WIN_BYTE),
        enc::lui(A2, 0),
        enc::addi(A2, A2, 7),
        enc::lui(A3, 0),
        enc::addi(A3, A3, 9),
        enc::lw(T0, S0, ctx::HELPER_OFF),
        enc::jalr(RA, T0, 0),
    ]
}
fn direct_off(id: direct::Id) -> i32 {
    ctx::DIRECT_OFF + id as i32 * direct::STRIDE
}
fn auipc(rd: u32, imm20: u32) -> u32 {
    (imm20 << 12) | (rd << 7) | 0x17
}
fn with_f3(w: u32, f3: u32) -> u32 {
    (w & !(7 << 12)) | (f3 << 12)
}

// --- positive ----------------------------------------------------------------

#[test]
fn canonical_images_verify() {
    assert_eq!(check(&[]), None);
    // A budgeted loop: back edge to the header's budget check.
    assert_eq!(
        check(&[enc::branch(enc::F3_BNE, A0, ZERO, rel(0, HDR))]),
        None
    );
    assert_eq!(check(&[enc::jal(ZERO, rel(0, HDR))]), None);
    // Every helper-call form the lowerer emits.
    assert_eq!(check(&generic_call()), None);
    for i in 0..direct::COUNT {
        let off = ctx::DIRECT_OFF + i as i32 * direct::STRIDE;
        let call = [
            enc::addi(A3, S1, WIN_BYTE),
            enc::lw(T0, S0, off),
            enc::jalr(RA, T0, 0),
        ];
        assert_eq!(check(&call), None, "direct entry {i}");
    }
    // Region edges are inclusive of the last word only.
    let f = LIM.frame_bytes as i32;
    let s = LIM.state_bytes as i32;
    assert_eq!(check(&[enc::sw(A0, S1, f - 4), enc::lw(A0, S1, 0)]), None);
    assert_eq!(check(&[enc::sw(A0, S11, s - 4), enc::lw(A0, S11, 0)]), None);
    for off in [0, 4, 8, 12, 16] {
        assert_eq!(check(&[enc::sw(A0, S0, off)]), None);
    }
    // Two functions (update + shade): the second entry follows a `ret`.
    let mut two = skel(&[]);
    let second = two.len();
    two.extend(skel(&[]));
    assert_eq!(verify(&two, &[0, second], &LIM), None);
}

// --- hole 1: ra ----------------------------------------------------------------

#[test]
fn poc_a_ret_to_arbitrary_ra() {
    // PoC A: `lui ra, X; ret`.
    assert_eq!(
        check(&[enc::lui(RA, 0x40800), RET]),
        Some(VerifyErr::WriteReservedReg)
    );
    // `ret` is only legal as the epilogue's last word.
    assert_eq!(check(&[RET]), Some(VerifyErr::BadJalr));
    // Other ways to put a chosen value in ra.
    for w in [
        enc::addi(RA, A0, 0),
        enc::add(RA, A0, ZERO),
        enc::lw(RA, S1, 0),
        enc::lw(RA, S11, 0),
        enc::jal(RA, 8),
        auipc(RA, 0),
    ] {
        assert!(check(&[w]).is_some(), "{w:08x}");
    }
    // jalr variants other than the pinned helper call.
    for w in [
        enc::jalr(ZERO, A0, 0),
        enc::jalr(ZERO, RA, 4),
        enc::jalr(RA, A0, 0),
        enc::jalr(ZERO, T0, 0),
    ] {
        assert_eq!(check(&[w]), Some(VerifyErr::BadJalr), "{w:08x}");
    }
    // Overwrite the saved ra slot, then return normally.
    assert_eq!(check(&[enc::sw(A0, SP, 0)]), Some(VerifyErr::BadMemBase));
    // Skip the epilogue's `lw ra` by jumping into its middle.
    let mut c = skel(&[enc::jal(ZERO, 0)]);
    let epi = c.len() - EPILOGUE_LEN;
    let j = BODY;
    c[j] = enc::jal(ZERO, ((epi + 1 - j) * 4) as i32);
    assert_eq!(verify(&c, &[0], &LIM), Some(VerifyErr::BranchIntoFixedSeq));
    // ...and straight at the final `ret`.
    c[j] = enc::jal(ZERO, ((epi + EPILOGUE_LEN - 1 - j) * 4) as i32);
    assert_eq!(verify(&c, &[0], &LIM), Some(VerifyErr::BranchIntoFixedSeq));
    // An epilogue that restores ra from another slot is not the epilogue.
    let mut c = skel(&[]);
    let n = c.len();
    c[n - EPILOGUE_LEN] = enc::lw(RA, SP, 4);
    assert!(verify(&c, &[0], &LIM).is_some());
    // (Shown directly: that `lw ra` as a body word is a reserved write.)
    assert_eq!(
        check(&[enc::lw(RA, SP, 4)]),
        Some(VerifyErr::WriteReservedReg)
    );
}

// --- hole 2: reserved base registers rewritten mid-image -------------------------

#[test]
fn poc_b_repoint_s0_then_table_call() {
    // PoC B: `lui a0, X; addi s0, a0, 0; lw t0, 32(s0); jalr ra, t0`.
    let body = [
        enc::lui(A0, 0x3fc80),
        enc::addi(S0, A0, 0),
        enc::lw(T0, S0, 32),
        enc::jalr(RA, T0, 0),
    ];
    assert_eq!(check(&body), Some(VerifyErr::WriteReservedReg));
    // The old generic-helper variant (offset 24) as well.
    let body = [
        enc::addi(S0, A0, 0),
        enc::lw(T0, S0, ctx::HELPER_OFF),
        enc::jalr(RA, T0, 0),
    ];
    assert_eq!(check(&body), Some(VerifyErr::WriteReservedReg));
}

#[test]
fn poc_d_reload_s0_from_written_stack() {
    // PoC D: `sw a0, 0(sp); lw s0, 0(sp); lw t0, 32(s0); jalr ra, t0`.
    let body = [
        enc::sw(A0, SP, 0),
        enc::lw(S0, SP, 0),
        enc::lw(T0, S0, 32),
        enc::jalr(RA, T0, 0),
    ];
    assert_eq!(check(&body), Some(VerifyErr::BadMemBase));
    // Without the store: the reload itself is rejected.
    assert_eq!(
        check(&[enc::lw(S0, SP, 0)]),
        Some(VerifyErr::WriteReservedReg)
    );
    // Reload from the frame / state (image-writable memory) instead.
    assert_eq!(
        check(&[enc::sw(A0, S1, 0), enc::lw(S0, S1, 0)]),
        Some(VerifyErr::WriteReservedReg)
    );
    assert_eq!(
        check(&[enc::lw(S1, S11, 0)]),
        Some(VerifyErr::WriteReservedReg)
    );
}

#[test]
fn reserved_registers_written_only_by_fixed_sequences() {
    for r in [S0, S1, S11, SP, GP, TP] {
        for w in [
            enc::addi(r, A0, 0),
            enc::addi(r, r, 4),
            enc::add(r, r, A0),
            enc::lui(r, 1),
            enc::lw(r, S1, 0),
            enc::jal(r, 8),
        ] {
            assert!(check(&[w]).is_some(), "rd={r} {w:08x}");
        }
    }
    // The exact prologue moves are rejected outside a prologue.
    for w in [
        enc::addi(S0, A0, 0),
        enc::addi(S1, A1, 0),
        enc::addi(S11, A2, 0),
    ] {
        assert_eq!(check(&[w]), Some(VerifyErr::WriteReservedReg));
    }
    // A whole second prologue in the body (not a declared entry).
    let pro = prologue_words(LIM.budget);
    assert_eq!(check(&pro), Some(VerifyErr::WriteReservedReg));
    // s10: only the canonical decrement.
    assert_eq!(
        check(&[enc::addi(S10, A0, 0)]),
        Some(VerifyErr::BadBudgetCheck)
    );
    assert_eq!(
        check(&[enc::addi(S10, S10, 100)]),
        Some(VerifyErr::BadBudgetCheck)
    );
    assert_eq!(
        check(&[enc::addi(S10, S10, -1)]),
        Some(VerifyErr::BadBudgetCheck)
    );
    assert_eq!(
        check(&[enc::lui(S10, 1)]),
        Some(VerifyErr::WriteReservedReg)
    );
    assert_eq!(
        check(&[enc::lw(S10, S1, 0)]),
        Some(VerifyErr::WriteReservedReg)
    );
}

#[test]
fn prologue_reachable_only_at_entries() {
    let code = skel(&[enc::jal(ZERO, 0)]);
    // Jump back to the prologue's `addi s0, a0, 0` (a0 is image-controlled).
    let mut c = code.clone();
    c[BODY] = enc::jal(ZERO, rel(0, 1 + SAVED.len()));
    assert_eq!(verify(&c, &[0], &LIM), Some(VerifyErr::BranchIntoFixedSeq));
    // ...or to the very start of the prologue.
    c[BODY] = enc::jal(ZERO, rel(0, 0));
    assert_eq!(verify(&c, &[0], &LIM), Some(VerifyErr::BranchIntoFixedSeq));
    // An entry that a body word falls through into.
    let mut two = skel(&[]);
    two.pop(); // drop the final `ret`: the previous word now falls through
    two.push(enc::addi(A0, A0, 0));
    let second = two.len();
    two.extend(skel(&[]));
    assert_eq!(verify(&two, &[0, second], &LIM), Some(VerifyErr::BadEntry));
    // Entries must hold the exact prologue with the caller's budget.
    assert_eq!(verify(&code, &[HDR], &LIM), Some(VerifyErr::BadEntry));
    assert_eq!(verify(&code, &[], &LIM), Some(VerifyErr::BadEntry));
    assert_eq!(
        verify(&code, &[code.len()], &LIM),
        Some(VerifyErr::BadEntry)
    );
    let other = VerifyLimits {
        budget: LIM.budget + 1,
        ..LIM
    };
    assert_eq!(verify(&skel(&[]), &[0], &other), Some(VerifyErr::BadEntry));
}

// --- hole 3: unbounded offsets through base registers --------------------------------

#[test]
fn poc_c_sp_store_above_frame() {
    // PoC C: `addi sp, sp, 2040` (x2); `sw a0, 2040(sp)`.
    let body = [
        enc::addi(SP, SP, 2040),
        enc::addi(SP, SP, 2040),
        enc::sw(A0, SP, 2040),
    ];
    assert_eq!(check(&body), Some(VerifyErr::WriteReservedReg));
    // No sp-relative access at all outside the fixed sequences.
    for off in [0, 48, 60, 64, 2040, -4] {
        assert_eq!(check(&[enc::sw(A0, SP, off)]), Some(VerifyErr::BadMemBase));
        assert_eq!(check(&[enc::lw(A0, SP, off)]), Some(VerifyErr::BadMemBase));
    }
}

#[test]
fn poc_f_frame_and_state_bounds() {
    // PoC F: `sw a0, -2048(s1)`.
    assert_eq!(
        check(&[enc::sw(A0, S1, -2048)]),
        Some(VerifyErr::MemOutOfBounds)
    );
    let f = LIM.frame_bytes as i32;
    let s = LIM.state_bytes as i32;
    for (base, size) in [(S1, f), (S11, s)] {
        for off in [-4, size, size + 4, 2044, 2, size - 2] {
            assert_eq!(
                check(&[enc::sw(A0, base, off)]),
                Some(VerifyErr::MemOutOfBounds),
                "sw {base} {off}"
            );
            assert_eq!(
                check(&[enc::lw(A0, base, off)]),
                Some(VerifyErr::MemOutOfBounds),
                "lw {base} {off}"
            );
        }
    }
    // Sizes come from the limits, not the image.
    let small = VerifyLimits {
        frame_bytes: 64,
        state_bytes: 8,
        ..LIM
    };
    assert_eq!(
        verify(&skel(&[enc::sw(A0, S1, 64)]), &[0], &small),
        Some(VerifyErr::MemOutOfBounds)
    );
    assert_eq!(
        verify(&skel(&[enc::lw(A0, S11, 8)]), &[0], &small),
        Some(VerifyErr::MemOutOfBounds)
    );
    // Only word accesses.
    for f3 in [0, 1, 4, 5] {
        assert_eq!(
            check(&[with_f3(enc::lw(A0, S1, 0), f3)]),
            Some(VerifyErr::BadMemBase)
        );
    }
    for f3 in [0, 1] {
        assert_eq!(
            check(&[with_f3(enc::sw(A0, S1, 0), f3)]),
            Some(VerifyErr::BadMemBase)
        );
    }
    // Any other base register.
    for base in [A0, T0, crate::reg::slot(0), GP, TP, RA, ZERO] {
        assert_eq!(check(&[enc::sw(A0, base, 0)]), Some(VerifyErr::BadMemBase));
        assert_eq!(check(&[enc::lw(A0, base, 0)]), Some(VerifyErr::BadMemBase));
    }
}

#[test]
fn ctx_writes_and_reads_are_fixed() {
    // Stores via s0: output words only (never the helper pointer or table).
    for off in [
        -4,
        20,
        ctx::HELPER_OFF,
        ctx::DIRECT_OFF,
        ctx::DIRECT_OFF + 4,
        2044,
    ] {
        assert_eq!(
            check(&[enc::sw(A0, S0, off)]),
            Some(VerifyErr::BadCtxStore),
            "{off}"
        );
    }
    // Loads via s0: only a table entry into t0.
    assert_eq!(
        check(&[enc::lw(A0, S0, 0)]),
        Some(VerifyErr::HelperNotAfterLoad)
    );
    assert_eq!(
        check(&[enc::lw(T0, S0, 64 * 8)]),
        Some(VerifyErr::HelperNotAfterLoad)
    );
    assert_eq!(check(&[enc::lw(T0, S0, ctx::DIRECT_OFF)]), None);
}

// --- hole 4: unbudgeted loops ---------------------------------------------------------

#[test]
fn poc_e_unbudgeted_loop() {
    // PoC E: `jal x0, 0`.
    assert_eq!(
        check(&[enc::jal(ZERO, 0)]),
        Some(VerifyErr::UnbudgetedBackEdge)
    );
    assert_eq!(
        check(&[enc::branch(enc::F3_BEQ, ZERO, ZERO, 0)]),
        Some(VerifyErr::UnbudgetedBackEdge)
    );
    // Back edge to a plain body word.
    let body = [enc::addi(A0, A0, 1), enc::jal(ZERO, -4)];
    assert_eq!(check(&body), Some(VerifyErr::UnbudgetedBackEdge));
    let body = [enc::addi(A0, A0, 1), enc::branch(enc::F3_BNE, A0, ZERO, -4)];
    assert_eq!(check(&body), Some(VerifyErr::UnbudgetedBackEdge));
    // Back edge into the middle of a budget check (skipping the decrement).
    assert_eq!(
        check(&[enc::jal(ZERO, rel(0, HDR + 1))]),
        Some(VerifyErr::UnbudgetedBackEdge)
    );
    assert_eq!(
        check(&[enc::jal(ZERO, rel(0, HDR + 2))]),
        Some(VerifyErr::UnbudgetedBackEdge)
    );
    // Back edge to a helper-call return point.
    let mut body = generic_call().to_vec();
    body.push(enc::addi(A0, A0, 0));
    body.push(enc::jal(ZERO, -4));
    assert_eq!(check(&body), Some(VerifyErr::UnbudgetedBackEdge));
}

#[test]
fn budget_check_must_be_canonical() {
    // A loop header whose check decrements by 0, uses blt, or exits anywhere but
    // the stub + epilogue.
    let stub_rel = |at: usize, len: usize| ((BODY + len - at) * 4) as i32;
    let cases: [[u32; 3]; 4] = [
        [
            enc::addi(S10, S10, 0),
            budget_check_head(1)[1],
            enc::jal(ZERO, stub_rel(BODY, 4)),
        ],
        [
            enc::addi(S10, S10, -1),
            enc::branch(enc::F3_BLT, S10, ZERO, 8),
            enc::jal(ZERO, stub_rel(BODY + 2, 4)),
        ],
        [
            enc::addi(S10, S10, -1),
            budget_check_head(1)[1],
            enc::jal(ZERO, 4),
        ],
        [
            enc::addi(S10, S10, -1),
            budget_check_head(1)[1],
            enc::jal(ZERO, -4),
        ],
    ];
    for (k, seq) in cases.iter().enumerate() {
        let mut body = seq.to_vec();
        body.push(enc::jal(ZERO, -12)); // back edge to this "check"
        assert!(check(&body).is_some(), "case {k}");
    }
    // The canonical one with a back edge to it is accepted.
    let mut body = budget_check_head(5).to_vec();
    body.push(0);
    body.push(enc::jal(ZERO, -12));
    let mut c = skel(&body);
    let stub = c.len() - EPILOGUE_LEN - EXIT_STUB_LEN;
    c[BODY + 2] = enc::jal(ZERO, ((stub - (BODY + 2)) * 4) as i32);
    assert_eq!(verify(&c, &[0], &LIM), None);
    // ...but not if the stub isn't followed by the epilogue.
    let n = c.len();
    c[n - 2] = enc::addi(A0, A0, 0);
    assert!(verify(&c, &[0], &LIM).is_some());
}

// --- helper calls (#351 rules + pinned pointer args) -----------------------------------

#[test]
fn fixed_helper_entries_only() {
    let call = |off: i32| {
        check(&[
            enc::addi(A3, S1, WIN_BYTE),
            enc::lw(T0, S0, off),
            enc::jalr(RA, T0, 0),
        ])
    };
    for i in 0..direct::COUNT {
        let off = ctx::DIRECT_OFF + i as i32 * direct::STRIDE;
        assert_eq!(call(off), None);
        assert_eq!(call(off + 4), Some(VerifyErr::HelperNotAfterLoad));
    }
    for off in [
        -8,
        0,
        ctx::DIRECT_OFF + direct::COUNT as i32 * direct::STRIDE,
    ] {
        assert_eq!(call(off), Some(VerifyErr::HelperNotAfterLoad));
    }
    // lw -> another width / another rd / another base.
    let off = ctx::DIRECT_OFF;
    for (w, e) in [
        (enc::lw(T0, S0, off) ^ (1 << 12), VerifyErr::BadMemBase),
        (enc::lw(T1, S0, off), VerifyErr::HelperNotAfterLoad),
        (enc::lw(T0, S1, off), VerifyErr::HelperNotAfterLoad),
    ] {
        let r = check(&[w, enc::jalr(RA, T0, 0)]);
        assert_eq!(r, Some(e), "{w:08x}");
    }
    // Call without a load, with something in between, or with an offset.
    assert_eq!(
        check(&[enc::jalr(RA, T0, 0)]),
        Some(VerifyErr::HelperNotAfterLoad)
    );
    let body = [
        enc::lw(T0, S0, off),
        enc::addi(A0, A0, 0),
        enc::jalr(RA, T0, 0),
    ];
    assert_eq!(check(&body), Some(VerifyErr::HelperNotAfterLoad));
    assert_eq!(
        check(&[enc::lw(T0, S0, off), enc::jalr(RA, T0, 4)]),
        Some(VerifyErr::BadJalr)
    );
    assert_eq!(
        check(&[enc::lw(T0, S0, off), with_f3(enc::jalr(RA, T0, 0), 1)]),
        Some(VerifyErr::BadJalr)
    );
}

#[test]
fn cannot_jump_into_a_helper_call() {
    let off = direct_off(direct::Id::Sin);
    // Forward branch to the jalr, skipping the load.
    let body = [
        enc::branch(enc::F3_BGE, A0, ZERO, 8),
        enc::lw(T0, S0, off),
        enc::jalr(RA, T0, 0),
    ];
    assert_eq!(check(&body), Some(VerifyErr::BranchIntoHelper));
    // Landing on a scalar helper's load still performs the load: allowed.
    let body = [
        enc::branch(enc::F3_BGE, A0, ZERO, 4),
        enc::lw(T0, S0, off),
        enc::jalr(RA, T0, 0),
    ];
    assert_eq!(check(&body), None);
    // A colour helper's load comes after its a3 pin: landing there skips it.
    let blue = direct_off(direct::Id::Hsv2Rgb);
    let body = [
        enc::branch(enc::F3_BGE, A0, ZERO, 8),
        enc::addi(A3, S1, WIN_BYTE),
        enc::lw(T0, S0, blue),
        enc::jalr(RA, T0, 0),
    ];
    assert_eq!(check(&body), Some(VerifyErr::BranchIntoHelper));
    // Into the generic call after its a0 pin: every offset 1..=7 is protected.
    for k in 1..=7 {
        let mut body = vec![enc::branch(enc::F3_BGE, A0, ZERO, 4 + 4 * k)];
        body.extend_from_slice(&generic_call());
        assert_eq!(check(&body), Some(VerifyErr::BranchIntoHelper), "k={k}");
    }
    // Landing on the first pin is fine.
    let mut body = vec![enc::branch(enc::F3_BGE, A0, ZERO, 4)];
    body.extend_from_slice(&generic_call());
    assert_eq!(check(&body), None);
    // Out of range / misaligned.
    assert_eq!(
        check(&[enc::branch(enc::F3_BGE, A0, ZERO, 6)]),
        Some(VerifyErr::BranchOutOfRange)
    );
    assert_eq!(
        check(&[enc::jal(ZERO, 1 << 19)]),
        Some(VerifyErr::BranchOutOfRange)
    );
    assert_eq!(
        check(&[enc::jal(ZERO, -(BODY as i32) * 4 - 4)]),
        Some(VerifyErr::BranchOutOfRange)
    );
}

#[test]
fn helper_pointer_args_are_pinned() {
    // Generic helper: a0 must be s0, a1 must be the frame window.
    let mut g = generic_call();
    g[0] = enc::addi(A0, A5, 0);
    assert_eq!(check(&g), Some(VerifyErr::BadHelperArgs));
    let mut g = generic_call();
    g[1] = enc::addi(A1, S1, 0);
    assert_eq!(check(&g), Some(VerifyErr::BadHelperArgs));
    let mut g = generic_call();
    g[1] = enc::addi(A1, S11, WIN_BYTE);
    assert_eq!(check(&g), Some(VerifyErr::BadHelperArgs));
    let mut g = generic_call();
    g[3] = enc::addi(A1, A1, 4); // rewrite a1 after the pin
    assert_eq!(check(&g), Some(VerifyErr::BadHelperArgs));
    assert_eq!(check(&generic_call()[6..]), Some(VerifyErr::BadHelperArgs));
    // Colour helpers write through a3: it must be the frame window.
    for id in [direct::Id::Hsv2Rgb, direct::Id::Palette] {
        let off = direct_off(id);
        let call = |a3: u32| check(&[a3, enc::lw(T0, S0, off), enc::jalr(RA, T0, 0)]);
        assert_eq!(call(enc::addi(A3, S1, WIN_BYTE)), None);
        assert_eq!(call(enc::addi(A3, A0, 0)), Some(VerifyErr::BadHelperArgs));
        assert_eq!(call(enc::addi(A3, S1, 0)), Some(VerifyErr::BadHelperArgs));
        assert_eq!(call(enc::lui(A3, 0x3fc80)), Some(VerifyErr::BadHelperArgs));
    }
    // A frame too small for the window can't host pointer-taking calls.
    let small = VerifyLimits {
        frame_bytes: 64,
        ..LIM
    };
    assert_eq!(
        verify(&skel(&generic_call()), &[0], &small),
        Some(VerifyErr::BadHelperArgs)
    );
}

// --- everything else ------------------------------------------------------------------

#[test]
fn forbidden_encodings() {
    assert_eq!(check(&[0x0000_0073]), Some(VerifyErr::ForbiddenCsrOrSystem)); // ecall
    assert_eq!(check(&[0x0010_0073]), Some(VerifyErr::ForbiddenCsrOrSystem)); // ebreak
    assert_eq!(check(&[0x3412_9073]), Some(VerifyErr::ForbiddenCsrOrSystem)); // csrw mepc
    assert_eq!(check(&[0x0ff0_000f]), Some(VerifyErr::ForbiddenCsrOrSystem)); // fence
    assert_eq!(check(&[0x0000_100f]), Some(VerifyErr::ForbiddenCsrOrSystem)); // fence.i
    assert_eq!(check(&[auipc(A0, 0)]), Some(VerifyErr::BadOpcode));
    assert_eq!(check(&[0x0000_0000]), Some(VerifyErr::BadOpcode));
    assert_eq!(check(&[0x0000_002f]), Some(VerifyErr::BadOpcode)); // AMO
    assert_eq!(
        check(&[with_f3(enc::branch(enc::F3_BEQ, A0, A1, 8), 2)]),
        Some(VerifyErr::BadOpcode)
    );
    assert_eq!(
        check(&[enc::add(A0, A0, A1) | (0x20 << 25) | (1 << 12)]),
        Some(VerifyErr::BadOpcode)
    );
    assert_eq!(
        check(&[enc::add(A0, A0, A1) | (0x05 << 25)]),
        Some(VerifyErr::BadOpcode)
    );
    assert_eq!(
        check(&[enc::slli(A0, A0, 3) | (0x20 << 25)]),
        Some(VerifyErr::BadOpcode)
    );
}

#[test]
fn control_cannot_run_off_the_end() {
    let mut c = skel(&[]);
    c.pop();
    assert_eq!(verify(&c, &[0], &LIM), Some(VerifyErr::FallsOffEnd));
    let mut c = skel(&[]);
    c.push(enc::lw(T0, S0, ctx::DIRECT_OFF));
    c.push(enc::jalr(RA, T0, 0)); // helper returns past the end
    assert_eq!(verify(&c, &[0], &LIM), Some(VerifyErr::FallsOffEnd));
    assert_eq!(verify(&[], &[0], &LIM), Some(VerifyErr::BadEntry));
    let neg = VerifyLimits { budget: -1, ..LIM };
    assert_eq!(verify(&skel(&[]), &[0], &neg), Some(VerifyErr::BadLimits));
}

#[test]
fn raw_pocs_from_review_are_rejected() {
    // The six images exactly as in verifier_poc.rs (no prologue), entry 0.
    let hdr = [
        enc::addi(S10, S10, -1),
        enc::branch(enc::F3_BGE, S10, ZERO, 8),
    ];
    let pocs: [&[u32]; 6] = [
        &[enc::lui(RA, 0x40800), RET],
        &[
            enc::lui(A0, 0x3fc80),
            enc::addi(S0, A0, 0),
            enc::lw(T0, S0, 32),
            enc::jalr(RA, T0, 0),
            RET,
        ],
        &[
            enc::addi(SP, SP, 2040),
            enc::addi(SP, SP, 2040),
            enc::sw(A0, SP, 2040),
            RET,
        ],
        &[
            enc::sw(A0, SP, 0),
            enc::lw(S0, SP, 0),
            enc::lw(T0, S0, 32),
            enc::jalr(RA, T0, 0),
            RET,
        ],
        &[enc::jal(ZERO, 0), RET],
        &[enc::sw(A0, S1, -2048), RET],
    ];
    for (k, p) in pocs.iter().enumerate() {
        let img = [&hdr[..], p].concat();
        assert!(
            verify(&img, &[0], &LIM).is_some(),
            "PoC {}",
            (b'A' + k as u8) as char
        );
        // Payload in a well-formed function: still rejected (by its payload).
        assert!(
            check(&p[..p.len() - 1]).is_some(),
            "PoC {} in skeleton",
            (b'A' + k as u8) as char
        );
    }
}
