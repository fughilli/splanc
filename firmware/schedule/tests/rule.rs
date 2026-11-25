//! The ScheduleRule wire form: round trips, defaults, validation.

use ledmapper_schedule::{rule_bodies, Action, Rule, RuleError, Str, When, WhenKind, Writer};

fn enc(r: &Rule) -> Vec<u8> {
    let mut b = [0u8; 256];
    let n = {
        let mut w = Writer::new(&mut b);
        r.encode(&mut w);
        assert!(!w.full);
        w.written()
    };
    b[..n].to_vec()
}

fn rule(id: u8, action: Action) -> Rule {
    Rule {
        id,
        enabled: true,
        label: Str::new("Wake up").unwrap(),
        when: When::local(7 * 60, 0b0111110),
        action,
    }
}

#[test]
fn every_action_round_trips() {
    let actions = [
        Action::Power {
            on: true,
            duration_ms: 30_000,
        },
        Action::Power {
            on: false,
            duration_ms: 0,
        },
        Action::Brightness {
            level: 0.25,
            ramp_ms: 60_000,
        },
        Action::Effect {
            effect_id: Str::new("daylight").unwrap(),
            crossfade_ms: 5_000,
        },
        Action::Trigger {
            name: Str::new("alarm").unwrap(),
        },
        Action::None,
    ];
    for (i, a) in actions.into_iter().enumerate() {
        let r = rule(i as u8 + 1, a);
        assert_eq!(Rule::decode(&enc(&r)), Ok(r), "{a:?}");
    }
    let sun = Rule {
        id: 9,
        enabled: false,
        label: Str::EMPTY,
        when: When {
            kind: WhenKind::Sunset,
            minute_of_day: 0,
            offset_min: -30,
            days_mask: 0,
        },
        action: Action::Power {
            on: true,
            duration_ms: 0,
        },
    };
    assert_eq!(Rule::decode(&enc(&sun)), Ok(sun));
}

#[test]
fn proto3_defaults_and_known_bytes() {
    // {id: 3, minute_of_day: 420, power {on: true}}: enabled (disabled absent), every day.
    let b = [0x08, 0x03, 0x28, 0xa4, 0x03, 0x52, 0x02, 0x08, 0x01];
    let r = Rule::decode(&b).unwrap();
    assert!(r.enabled);
    assert_eq!(r.when, When::local(420, 0));
    assert_eq!(
        r.action,
        Action::Power {
            on: true,
            duration_ms: 0
        }
    );
    assert_eq!(enc(&r), b);
    // Unknown fields are skipped (a newer app).
    let mut b2 = b.to_vec();
    b2.extend_from_slice(&[0xa0, 0x01, 0x05]); // field 20 varint
    assert_eq!(Rule::decode(&b2), Ok(r));
}

#[test]
fn bad_rules_are_refused() {
    let r = rule(
        1,
        Action::Power {
            on: true,
            duration_ms: 0,
        },
    );
    let mut z = r;
    z.id = 0;
    assert_eq!(Rule::decode(&enc(&z)), Err(RuleError::BadId));
    let mut t = r;
    t.when.minute_of_day = 1440;
    assert_eq!(Rule::decode(&enc(&t)), Err(RuleError::BadTime));
    let mut o = r;
    o.when = When {
        kind: WhenKind::Sunrise,
        minute_of_day: 0,
        offset_min: 721,
        days_mask: 0,
    };
    assert_eq!(Rule::decode(&enc(&o)), Err(RuleError::BadTime));
    let b = rule(
        2,
        Action::Brightness {
            level: 1.5,
            ramp_ms: 0,
        },
    );
    assert_eq!(Rule::decode(&enc(&b)), Err(RuleError::BadAction));
    let e = rule(
        3,
        Action::Effect {
            effect_id: Str::EMPTY,
            crossfade_ms: 0,
        },
    );
    assert_eq!(Rule::decode(&enc(&e)), Err(RuleError::BadAction));
    let f = rule(
        4,
        Action::Effect {
            effect_id: Str::new("x").unwrap(),
            crossfade_ms: 3_600_000,
        },
    );
    assert_eq!(Rule::decode(&enc(&f)), Err(RuleError::BadAction));
    // Truncated / wrong wire types.
    let good = enc(&r);
    assert_eq!(
        Rule::decode(&good[..good.len() - 1]),
        Err(RuleError::Malformed)
    );
    assert_eq!(Rule::decode(&[0x0d, 1, 0, 0, 0]), Err(RuleError::Malformed)); // id as fixed32
                                                                              // A label over 24 bytes.
    let mut long = vec![0x08, 0x01, 0x1a, 25];
    long.extend_from_slice(&[b'a'; 25]);
    assert_eq!(Rule::decode(&long), Err(RuleError::BadAction));
    assert!(Str::<4>::new("toolong").is_none());
}

#[test]
fn a_file_is_repeated_rules() {
    let mut file = Vec::new();
    for id in 1..=3u8 {
        let body = enc(&rule(
            id,
            Action::Trigger {
                name: Str::new("t").unwrap(),
            },
        ));
        file.push(0x0a);
        file.push(body.len() as u8);
        file.extend_from_slice(&body);
    }
    // Other fields of the enclosing message are skipped.
    file.extend_from_slice(&[0x10, 0x07]);
    let ids: Vec<u8> = rule_bodies(&file)
        .map(|b| Rule::decode(b).unwrap().id)
        .collect();
    assert_eq!(ids, [1, 2, 3]);
}
