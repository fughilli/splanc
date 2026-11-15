//! The scheduled-change queue (apply_at_ms): due-time order with arrival order on
//! ties, late and unscheduled changes apply at once, overflow applies the earliest
//! early (never drops), the byte pool compacts, and clock shifts move every entry.

use ledmapper_player::apply_queue::{apply_due, ApplyQueue, APPLY_AT_MAX_AHEAD_MS};

type Q = ApplyQueue<4, 16>;

fn drain(q: &mut Q, now: i64) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    q.pop_due(now, |f| out.push(f.to_vec()));
    out
}

fn push(q: &mut Q, due: i64, frame: &[u8]) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    q.push(due, frame, |f| out.push(f.to_vec()));
    out
}

#[test]
fn applies_in_due_order_with_arrival_order_on_ties() {
    let mut q = Q::new();
    assert!(push(&mut q, 300, b"c").is_empty());
    assert!(push(&mut q, 100, b"a1").is_empty());
    assert!(push(&mut q, 200, b"b").is_empty());
    assert!(push(&mut q, 100, b"a2").is_empty());
    assert_eq!(q.len(), 4);
    assert_eq!(q.next_due(), Some(100));
    assert!(drain(&mut q, 99).is_empty(), "nothing is due 1 ms early");
    assert_eq!(drain(&mut q, 100), vec![b"a1".to_vec(), b"a2".to_vec()]);
    // A late frame boundary applies everything due since, still in order.
    assert_eq!(drain(&mut q, 1000), vec![b"b".to_vec(), b"c".to_vec()]);
    assert!(q.is_empty());
}

#[test]
fn full_queue_applies_the_earliest_early_never_drops() {
    let mut q = Q::new();
    for (i, due) in [10, 20, 30, 40].into_iter().enumerate() {
        assert!(push(&mut q, due, &[i as u8]).is_empty());
    }
    // A 5th entry: the earliest (due 10) is applied now to make room.
    assert_eq!(push(&mut q, 25, &[9]), vec![vec![0u8]]);
    assert_eq!(drain(&mut q, 100), vec![vec![1u8], vec![9], vec![2], vec![3]]);
}

#[test]
fn byte_pool_overflow_evicts_and_compacts() {
    let mut q = Q::new();
    assert!(push(&mut q, 10, b"aaaaaa").is_empty()); // 6
    assert!(push(&mut q, 30, b"cccccc").is_empty()); // 12
    assert!(push(&mut q, 20, b"bbbb").is_empty()); // 16: pool full
    // 3 more bytes: the earliest (a, 6 bytes) goes first; the pool compacts.
    assert_eq!(push(&mut q, 40, b"ddd"), vec![b"aaaaaa".to_vec()]);
    assert_eq!(q.len(), 3);
    assert_eq!(drain(&mut q, 100), vec![b"bbbb".to_vec(), b"cccccc".to_vec(), b"ddd".to_vec()]);
    // Reused after compaction, byte-exact.
    assert!(push(&mut q, 5, b"0123456789abcdef").is_empty());
    assert_eq!(drain(&mut q, 5), vec![b"0123456789abcdef".to_vec()]);
}

#[test]
fn oversize_frame_applies_now_after_everything_due_before_it() {
    let mut q = Q::new();
    push(&mut q, 10, b"a");
    push(&mut q, 50, b"z");
    let big = [7u8; 17];
    assert_eq!(push(&mut q, 20, &big), vec![b"a".to_vec(), big.to_vec()]);
    assert_eq!(drain(&mut q, 100), vec![b"z".to_vec()]);
}

#[test]
fn shift_and_clear() {
    let mut q = Q::new();
    push(&mut q, 1000, b"x");
    q.shift(-500);
    assert_eq!(drain(&mut q, 499).len(), 0);
    assert_eq!(drain(&mut q, 500), vec![b"x".to_vec()]);
    push(&mut q, 1, b"y");
    q.clear();
    assert!(q.is_empty() && drain(&mut q, i64::MAX).is_empty());
}

#[test]
fn due_time_rules() {
    // Unscheduled / no time base: on arrival (today's behaviour).
    assert_eq!(apply_due(None, Some(1000), 1000), None);
    assert_eq!(apply_due(Some(500), None, 1000), None);
    // On the shared base: due = epoch + apply_at, when it is still ahead.
    assert_eq!(apply_due(Some(500), Some(1000), 1200), Some(1500));
    // Late (already due) applies at once — uniforms are never dropped.
    assert_eq!(apply_due(Some(500), Some(1000), 1500), None);
    assert_eq!(apply_due(Some(500), Some(1000), 9000), None);
    // Implausibly far ahead (a stale epoch): at once rather than stuck.
    assert_eq!(apply_due(Some(500), Some(1000), 1500 - APPLY_AT_MAX_AHEAD_MS), Some(1500));
    assert_eq!(apply_due(Some(500), Some(1000), 1499 - APPLY_AT_MAX_AHEAD_MS), None);
}
