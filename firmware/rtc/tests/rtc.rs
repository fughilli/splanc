//! The RTC drivers against register-file fakes: BCD and 12/24-hour decoding, the
//! century bit, the lost-time flags (OSF / VL / PORF), set round trips with the
//! exact bytes written, temperature, alarms, the RV-3028 backup switch-over, the
//! registry's probe order and config, the 0x68 DS3231 / MPU-6050 coexistence
//! (each identifies only itself, nothing written to a device that didn't), and
//! the write-back / read-offer policy.

mod fake_rtc;

use fake_rtc::fake_mpu::FakeMpu;
use fake_rtc::{Bus, FakeRtc, Kind};
use ledmapper_clock::Source;
use ledmapper_rtc::policy::{self, Writeback, WritebackInput};
use ledmapper_rtc::{
    detect, from_bcd, to_bcd, AnyRtc, ChipKind, Ds3231, Fields, Pcf8563, RtcChip, RtcConfig,
    RtcError, RtcTime, Rv3028, MAX_UNIX_S, MIN_UNIX_S,
};

/// 2026-11-25T12:34:56Z (a Wednesday).
const T: i64 = 1_795_610_096;
/// 2000-01-01T00:00:00Z.
const Y2K: i64 = 946_684_800;

// -- shared helpers --------------------------------------------------------------

#[test]
fn bcd_round_trips_and_rejects_bad_nibbles() {
    for v in 0..=99u8 {
        assert_eq!(from_bcd(to_bcd(v)), Some(v));
    }
    assert_eq!(to_bcd(59), 0x59);
    assert_eq!(from_bcd(0x5A), None);
    assert_eq!(from_bcd(0xA0), None);
}

#[test]
fn fields_cover_2000_to_2099_only() {
    let f = Fields::from_unix(T).unwrap();
    assert_eq!(
        (f.yy, f.month, f.day, f.hour, f.minute, f.second, f.wday),
        (26, 11, 25, 12, 34, 56, 3)
    );
    assert_eq!(f.to_unix(), Some(T));
    assert_eq!(Fields::from_unix(MIN_UNIX_S).unwrap().to_unix(), Some(Y2K));
    let last = Fields::from_unix(MAX_UNIX_S).unwrap();
    assert_eq!((last.yy, last.month, last.day, last.hour), (99, 12, 31, 23));
    assert_eq!(Fields::from_unix(MIN_UNIX_S - 1), Err(RtcError::OutOfRange));
    assert_eq!(Fields::from_unix(MAX_UNIX_S + 1), Err(RtcError::OutOfRange));
    // 2000 and 2096 are leap years in a two-digit chip too.
    let feb29 = Fields {
        yy: 96,
        month: 2,
        day: 29,
        hour: 0,
        minute: 0,
        second: 0,
        wday: 0,
    };
    assert!(feb29.to_unix().is_some());
    assert_eq!(Fields { yy: 97, ..feb29 }.to_unix(), None);
}

// -- DS3231 -----------------------------------------------------------------------

fn ds3231_at(bytes: [u8; 7], status: u8) -> Bus {
    let mut f = FakeRtc::new(Kind::Ds3231);
    f.poke(0x00, &bytes);
    f.regs[0x0F] = status;
    Bus::with(f)
}

#[test]
fn ds3231_reads_bcd_time_and_osf() {
    let mut bus = ds3231_at([0x56, 0x34, 0x12, 0x04, 0x25, 0x11, 0x26], 0x08);
    let mut c = Ds3231::probe(&mut bus, 0x68).expect("a DS3231");
    assert_eq!(
        c.read(&mut bus),
        Ok(RtcTime {
            unix_s: T,
            valid: true
        })
    );
    // OSF: the oscillator stopped since the last set.
    bus.rtc().regs[0x0F] = 0x88;
    assert_eq!(
        c.read(&mut bus),
        Ok(RtcTime {
            unix_s: T,
            valid: false
        })
    );
    // Power-on registers: 2000-01-01, OSF set.
    let mut bus = Bus::with(FakeRtc::new(Kind::Ds3231));
    let mut c = Ds3231::probe(&mut bus, 0x68).unwrap();
    assert_eq!(
        c.read(&mut bus),
        Ok(RtcTime {
            unix_s: Y2K,
            valid: false
        })
    );
}

#[test]
fn ds3231_twelve_hour_mode() {
    // 12-hour: bit 6; PM: bit 5. 12 AM = 00, 12 PM = 12, 1 PM = 13.
    for (h, want) in [(0x52u8, 0u8), (0x72, 12), (0x61, 13), (0x41, 1), (0x71, 23)] {
        let mut bus = ds3231_at([0x00, 0x00, h, 0x04, 0x25, 0x11, 0x26], 0x00);
        let mut c = Ds3231::attach(&mut bus, 0x68).unwrap();
        let t = c.read(&mut bus).unwrap();
        assert_eq!(
            Fields::from_unix(t.unix_s).unwrap().hour,
            want,
            "hours reg {h:#x}"
        );
    }
}

#[test]
fn ds3231_century_and_bad_bcd_are_errors_not_times() {
    // Century bit set: 2126, which this firmware never writes.
    let mut bus = ds3231_at([0x56, 0x34, 0x12, 0x04, 0x25, 0x91, 0x26], 0x00);
    let mut c = Ds3231::attach(&mut bus, 0x68).unwrap();
    assert_eq!(c.read(&mut bus), Err(RtcError::OutOfRange));
    // A non-BCD seconds register while OSF says the time is good.
    let mut bus = ds3231_at([0x5A, 0x34, 0x12, 0x04, 0x25, 0x11, 0x26], 0x00);
    let mut c = Ds3231::attach(&mut bus, 0x68).unwrap();
    assert_eq!(c.read(&mut bus), Err(RtcError::BadData));
    // The same garbage with OSF set: just "lost time".
    bus.rtc().regs[0x0F] = 0x80;
    assert_eq!(
        c.read(&mut bus),
        Ok(RtcTime {
            unix_s: 0,
            valid: false
        })
    );
}

#[test]
fn ds3231_set_writes_utc_bcd_and_clears_osf_and_eosc() {
    let mut bus = Bus::with(FakeRtc::new(Kind::Ds3231));
    bus.rtc().regs[0x0E] = 0x9C; // EOSC set: the oscillator would stop on battery
    let mut c = Ds3231::probe(&mut bus, 0x68).unwrap();
    c.set(&mut bus, T).unwrap();
    assert_eq!(
        &bus.rtc().regs[..7],
        &[0x56, 0x34, 0x12, 0x04, 0x25, 0x11, 0x26]
    );
    assert_eq!(bus.rtc().regs[0x0E], 0x1C, "EOSC cleared, the rest kept");
    assert_eq!(bus.rtc().regs[0x0F] & 0x80, 0, "OSF cleared");
    assert_eq!(
        c.read(&mut bus),
        Ok(RtcTime {
            unix_s: T,
            valid: true
        })
    );
    assert_eq!(c.set(&mut bus, MAX_UNIX_S + 1), Err(RtcError::OutOfRange));
    assert_eq!(Ds3231::SET_PHASE_US, 0);
}

#[test]
fn ds3231_temperature_quarter_degrees() {
    let mut bus = Bus::with(FakeRtc::new(Kind::Ds3231));
    let mut c = Ds3231::probe(&mut bus, 0x68).unwrap();
    assert_eq!(c.temperature_cc(&mut bus), Some(2525));
    // -9.5 °C: 10-bit two's complement -38 quarters = 0xF6, 0x80.
    bus.rtc().regs[0x11] = 0xF6;
    bus.rtc().regs[0x12] = 0x80;
    assert_eq!(c.temperature_cc(&mut bus), Some(-950));
    assert!(c.caps().temperature);
}

#[test]
fn ds3231_alarm1_date_match() {
    let mut bus = ds3231_at([0x00, 0x00, 0x12, 0x04, 0x25, 0x11, 0x26], 0x01); // A1F pending
    let mut c = Ds3231::probe(&mut bus, 0x68).unwrap();
    c.set_alarm(&mut bus, Some(T)).unwrap();
    assert_eq!(
        &bus.rtc().regs[0x07..0x0B],
        &[0x56, 0x34, 0x12, 0x25],
        "A1M4..1 = 0, DY/DT = date"
    );
    assert_eq!(bus.rtc().regs[0x0E] & 0x05, 0x05, "INTCN + A1IE");
    assert_eq!(c.alarm_fired(&mut bus), Ok(false), "arming clears A1F");
    bus.rtc().regs[0x0F] |= 0x01;
    assert_eq!(c.alarm_fired(&mut bus), Ok(true));
    c.set_alarm(&mut bus, None).unwrap();
    assert_eq!(&bus.rtc().regs[0x07..0x0B], &[0x80; 4]);
    assert_eq!(bus.rtc().regs[0x0E] & 0x01, 0);
    assert_eq!(c.alarm_fired(&mut bus), Ok(false));
}

// -- 0x68: DS3231 next to an MPU-6050 -----------------------------------------------

#[test]
fn mpu6050_alone_at_0x68_is_not_an_rtc_and_is_never_written() {
    let mut bus = Bus::default();
    bus.add_mpu(FakeMpu::new(0x68, 0x68));
    assert_eq!(detect(&mut bus, RtcConfig::Auto), None);
    assert_eq!(bus.writes_to(0x68), 0);
    assert!(bus.mpu.devs[0].writes.is_empty());
}

#[test]
fn mpu_with_rtc_shaped_registers_is_refused_by_who_am_i() {
    // Worst case: an IMU whose first 19 registers happen to look like a DS3231.
    let mut m = FakeMpu::new(0x68, 0x68);
    m.regs[..0x13].copy_from_slice(&[
        0x00, 0x00, 0x00, 0x01, 0x01, 0x01, 0x00, 0, 0, 0, 0, 0, 0, 0, 0x1C, 0x00, 0x00, 0x19, 0x00,
    ]);
    let mut bus = Bus::default();
    bus.add_mpu(m);
    assert!(
        Ds3231::signature(&mut bus, 0x68),
        "the registers alone would pass"
    );
    assert_eq!(
        Ds3231::probe(&mut bus, 0x68),
        None,
        "WHO_AM_I 0x68 = an MPU-6050"
    );
    assert_eq!(bus.writes_to(0x68), 0);
}

#[test]
fn ds3231_at_0x68_and_mpu_at_0x69_each_identify_only_themselves() {
    let mut bus = Bus::with(FakeRtc::new(Kind::Ds3231));
    bus.add_mpu(FakeMpu::new(0x69, 0x68));
    let rtc = detect(&mut bus, RtcConfig::Auto).expect("the DS3231");
    assert_eq!((rtc.kind(), rtc.addr()), (ChipKind::Ds3231, 0x68));
    let imu = ledmapper_sensor::mpu6050::probe(&mut bus).expect("the MPU");
    assert_eq!(imu.addr, 0x69);
    assert!(imu.variant.is_some());
    assert!(
        bus.rtc().writes.is_empty(),
        "nothing written to the RTC by either probe"
    );
}

#[test]
fn sensor_core_refuses_a_lone_ds3231_without_writing_it() {
    let mut bus = Bus::with(FakeRtc::new(Kind::Ds3231));
    let mut hub = ledmapper_sensor::Hub::new(ledmapper_sensor::mpu6050::Config::default());
    let st = hub.probe(&mut bus, 0);
    assert_eq!(st, ledmapper_sensor::State::Unknown);
    assert!(bus.rtc().writes.is_empty());
    // ...and the RTC side still finds it.
    assert_eq!(
        detect(&mut bus, RtcConfig::Auto).map(|r| r.kind()),
        Some(ChipKind::Ds3231)
    );
}

// -- PCF8563 ------------------------------------------------------------------------

#[test]
fn pcf8563_power_on_garbage_is_lost_time() {
    let mut bus = Bus::with(FakeRtc::new(Kind::Pcf8563));
    let mut c = Pcf8563::probe(&mut bus, 0x51).expect("a PCF8563");
    assert_eq!(
        c.read(&mut bus),
        Ok(RtcTime {
            unix_s: 0,
            valid: false
        })
    );
}

#[test]
fn pcf8563_reads_vl_stop_and_ignores_the_century_bit() {
    let mut f = FakeRtc::new(Kind::Pcf8563);
    f.regs[0x00] = 0x00;
    f.poke(0x02, &[0x56, 0x34, 0x12, 0x25, 0x03, 0x11, 0x26]);
    let mut bus = Bus::with(f);
    let mut c = Pcf8563::probe(&mut bus, 0x51).unwrap();
    assert_eq!(
        c.read(&mut bus),
        Ok(RtcTime {
            unix_s: T,
            valid: true
        })
    );
    // Century bit either way: still 2026 (its polarity varies between parts).
    bus.rtc().regs[0x07] = 0x91;
    assert_eq!(
        c.read(&mut bus),
        Ok(RtcTime {
            unix_s: T,
            valid: true
        })
    );
    // VL: integrity not guaranteed.
    bus.rtc().regs[0x02] = 0xD6;
    assert_eq!(
        c.read(&mut bus),
        Ok(RtcTime {
            unix_s: T,
            valid: false
        })
    );
    // STOP held: not ticking.
    bus.rtc().regs[0x02] = 0x56;
    bus.rtc().regs[0x00] = 0x20;
    assert_eq!(c.read(&mut bus).map(|t| t.valid), Ok(false));
}

#[test]
fn pcf8563_set_stops_writes_then_releases() {
    let mut bus = Bus::with(FakeRtc::new(Kind::Pcf8563));
    let mut c = Pcf8563::probe(&mut bus, 0x51).unwrap();
    c.set(&mut bus, T).unwrap();
    let w = &bus.rtc().writes;
    assert_eq!(w[0], (0x00, 0x20), "STOP first");
    assert_eq!(
        &w[1..8],
        &[
            (0x02, 0x56),
            (0x03, 0x34),
            (0x04, 0x12),
            (0x05, 0x25),
            (0x06, 0x03),
            (0x07, 0x11),
            (0x08, 0x26)
        ]
    );
    assert_eq!(w[8], (0x00, 0x00), "then STOP released");
    assert_eq!(
        c.read(&mut bus),
        Ok(RtcTime {
            unix_s: T,
            valid: true
        })
    );
    // The first tick comes ~0.508 s after STOP is released.
    assert_eq!(Pcf8563::SET_PHASE_US, 492_000);
}

#[test]
fn pcf8563_minute_alarm_rounds_up() {
    let mut bus = Bus::with(FakeRtc::new(Kind::Pcf8563));
    bus.rtc().regs[0x01] = 0x08; // AF pending
    let mut c = Pcf8563::probe(&mut bus, 0x51).unwrap();
    c.set_alarm(&mut bus, Some(T)).unwrap(); // 12:34:56 -> 12:35
    assert_eq!(&bus.rtc().regs[0x09..0x0D], &[0x35, 0x12, 0x25, 0x80]);
    assert_eq!(bus.rtc().regs[0x01] & 0x0A, 0x02, "AIE on, AF cleared");
    assert_eq!(c.alarm_fired(&mut bus), Ok(false));
    bus.rtc().regs[0x01] |= 0x08;
    assert_eq!(c.alarm_fired(&mut bus), Ok(true));
    c.set_alarm(&mut bus, None).unwrap();
    assert_eq!(&bus.rtc().regs[0x09..0x0D], &[0x80; 4]);
    assert_eq!(bus.rtc().regs[0x01] & 0x0A, 0);
    assert_eq!(c.caps().alarm_step_s, 60);
}

#[test]
fn pcf8563_probe_needs_the_zero_bits() {
    let mut f = FakeRtc::new(Kind::Pcf8563);
    f.regs[0x00] = 0x80; // TEST1: EXT_CLK test mode, or not a PCF8563 at all
    let mut bus = Bus::with(f);
    assert_eq!(Pcf8563::probe(&mut bus, 0x51), None);
    assert!(bus.rtc().writes.is_empty());
}

// -- RV-3028 ------------------------------------------------------------------------

#[test]
fn rv3028_power_on_reset_flag_is_lost_time() {
    let mut bus = Bus::with(FakeRtc::new(Kind::Rv3028));
    let mut c = Rv3028::probe(&mut bus, 0x52).expect("an RV-3028");
    assert_eq!(
        c.read(&mut bus),
        Ok(RtcTime {
            unix_s: Y2K,
            valid: false
        })
    );
}

#[test]
fn rv3028_set_clears_porf_and_turns_on_backup_switchover_once() {
    let mut bus = Bus::with(FakeRtc::new(Kind::Rv3028));
    let mut c = Rv3028::probe(&mut bus, 0x52).unwrap();
    c.set(&mut bus, T).unwrap();
    let f = bus.rtc();
    assert_eq!(&f.regs[..7], &[0x56, 0x34, 0x12, 0x03, 0x25, 0x11, 0x26]);
    assert_eq!(f.regs[0x0E] & 0x01, 0, "PORF cleared");
    assert_eq!(f.regs[0x37] & 0x0C, 0x0C, "BSM = level switching");
    assert_eq!(f.regs[0x37] & 0x10, 0x10, "the other backup bits kept");
    assert_eq!(
        (f.ee_updates, f.eeprom_backup & 0x0C),
        (1, 0x0C),
        "persisted to the EEPROM"
    );
    assert_eq!(f.regs[0x0F] & 0x08, 0x08, "EERD held during the update");
    assert!(c.eeprom_pending());
    // Reads while EEBUSY: EERD stays; the first read after it clears drops EERD.
    let mut reads = 0;
    while c.eeprom_pending() {
        assert_eq!(
            c.read(&mut bus).unwrap(),
            RtcTime {
                unix_s: T,
                valid: true
            }
        );
        reads += 1;
        assert!(reads < 5);
    }
    assert_eq!(bus.rtc().regs[0x0F] & 0x08, 0, "EERD released");
    // Already on: a later set doesn't touch the EEPROM again.
    c.set(&mut bus, T + 60).unwrap();
    assert_eq!(bus.rtc().ee_updates, 1);
}

#[test]
fn rv3028_twelve_hour_mode_is_read_then_set_to_24() {
    let mut f = FakeRtc::new(Kind::Rv3028);
    f.poke(0x00, &[0x56, 0x34, 0x21, 0x03, 0x25, 0x11, 0x26]); // 1 PM in 12-hour mode
    f.regs[0x10] = 0x02;
    f.regs[0x0E] = 0;
    let mut bus = Bus::with(f);
    let mut c = Rv3028::probe(&mut bus, 0x52).unwrap();
    let t = c.read(&mut bus).unwrap();
    assert_eq!(Fields::from_unix(t.unix_s).unwrap().hour, 13);
    c.set(&mut bus, T).unwrap();
    assert_eq!(bus.rtc().regs[0x10] & 0x02, 0, "24-hour mode");
    assert_eq!(bus.rtc().regs[0x02], 0x12);
}

#[test]
fn rv3028_probe_checks_the_id_register() {
    let mut f = FakeRtc::new(Kind::Rv3028);
    f.regs[0x28] = 0x00;
    let mut bus = Bus::with(f);
    assert_eq!(Rv3028::probe(&mut bus, 0x52), None);
    assert!(bus.rtc().writes.is_empty());
}

#[test]
fn rv3028_date_alarm() {
    let mut f = FakeRtc::new(Kind::Rv3028);
    f.regs[0x0E] = 0x04; // AF pending
    let mut bus = Bus::with(f);
    let mut c = Rv3028::probe(&mut bus, 0x52).unwrap();
    c.set_alarm(&mut bus, Some(T)).unwrap();
    assert_eq!(&bus.rtc().regs[0x07..0x0A], &[0x35, 0x12, 0x25]);
    assert_eq!(bus.rtc().regs[0x0F] & 0x20, 0x20, "WADA = date");
    assert_eq!(bus.rtc().regs[0x10] & 0x08, 0x08, "AIE");
    assert_eq!(c.alarm_fired(&mut bus), Ok(false));
    bus.rtc().regs[0x0E] |= 0x04;
    assert_eq!(c.alarm_fired(&mut bus), Ok(true));
    c.set_alarm(&mut bus, None).unwrap();
    assert_eq!(&bus.rtc().regs[0x07..0x0A], &[0x80; 3]);
    assert_eq!(bus.rtc().regs[0x10] & 0x08, 0);
}

// -- the registry --------------------------------------------------------------------

#[test]
fn detect_order_and_an_empty_bus() {
    let mut bus = Bus::default();
    assert_eq!(detect(&mut bus, RtcConfig::Auto), None);
    assert!(bus.log.iter().all(|&(_, _, w)| !w), "probes never write");
    // All three on one bus: RV-3028 first (the strongest signature).
    let mut bus = Bus::with(FakeRtc::new(Kind::Ds3231));
    bus.rtcs.push(FakeRtc::new(Kind::Pcf8563));
    bus.rtcs.push(FakeRtc::new(Kind::Rv3028));
    assert_eq!(
        detect(&mut bus, RtcConfig::Auto).map(|r| r.kind()),
        Some(ChipKind::Rv3028)
    );
    bus.rtcs.pop();
    assert_eq!(
        detect(&mut bus, RtcConfig::Auto).map(|r| r.kind()),
        Some(ChipKind::Pcf8563)
    );
}

#[test]
fn config_off_never_touches_the_bus_and_explicit_skips_the_signature() {
    let mut bus = Bus::with(FakeRtc::new(Kind::Ds3231));
    assert_eq!(detect(&mut bus, RtcConfig::Off), None);
    assert!(bus.log.is_empty());
    // A DS3231 whose registers fail the signature (day 0): only an explicit
    // config takes it.
    bus.rtc().regs[0x03] = 0;
    assert_eq!(detect(&mut bus, RtcConfig::Auto), None);
    let r = detect(&mut bus, RtcConfig::Chip(ChipKind::Ds3231, 0)).expect("forced");
    assert!(matches!(r, AnyRtc::Ds3231(_)));
    assert_eq!(r.addr(), 0x68);
    // Forced at an address where nothing ACKs.
    assert_eq!(
        detect(&mut bus, RtcConfig::Chip(ChipKind::Rv3028, 0x53)),
        None
    );
}

#[test]
fn config_record_round_trips() {
    for c in [
        RtcConfig::Auto,
        RtcConfig::Off,
        RtcConfig::Chip(ChipKind::Ds3231, 0),
        RtcConfig::Chip(ChipKind::Pcf8563, 0x51),
        RtcConfig::Chip(ChipKind::Rv3028, 0x52),
    ] {
        assert_eq!(RtcConfig::decode(c.encode()), c);
    }
    assert_eq!(
        RtcConfig::decode(0x0009),
        RtcConfig::Auto,
        "an unknown chip falls back to auto"
    );
}

#[test]
fn any_rtc_round_trip_for_every_chip() {
    for k in [Kind::Ds3231, Kind::Pcf8563, Kind::Rv3028] {
        let mut bus = Bus::with(FakeRtc::new(k));
        let mut r = detect(&mut bus, RtcConfig::Auto).unwrap_or_else(|| panic!("{k:?}"));
        assert!(
            !r.read(&mut bus).unwrap().valid,
            "{k:?}: power-on = lost time"
        );
        r.set(&mut bus, T).unwrap();
        assert_eq!(
            r.read(&mut bus),
            Ok(RtcTime {
                unix_s: T,
                valid: true
            }),
            "{k:?}"
        );
        assert_eq!(r.temperature_cc(&mut bus).is_some(), r.caps().temperature);
    }
}

// -- the policy -----------------------------------------------------------------------

#[test]
fn read_offer_error_grows_with_the_chip_spec_since_the_last_write() {
    let caps = Ds3231::probe(&mut Bus::with(FakeRtc::new(Kind::Ds3231)), 0x68)
        .unwrap()
        .caps();
    assert_eq!(
        policy::read_offer(
            RtcTime {
                unix_s: T,
                valid: false
            },
            5,
            caps,
            Some(0)
        ),
        None
    );
    let o = policy::read_offer(
        RtcTime {
            unix_s: T,
            valid: true,
        },
        5,
        caps,
        Some(86_400),
    )
    .unwrap();
    assert_eq!(o.source, Source::HwRtc);
    assert_eq!(
        o.unix_us,
        T * 1_000_000 + 500_000,
        "the middle of the read second"
    );
    assert_eq!(o.at_mono_us, 5);
    assert_eq!(o.err_us, 500_000 + 86_400 * 2, "±0.5 s + 2 ppm × 1 day");
    assert_eq!(o.drift_ppm, 2);
    let o = policy::read_offer(
        RtcTime {
            unix_s: T,
            valid: true,
        },
        5,
        caps,
        None,
    )
    .unwrap();
    assert_eq!(
        o.err_us,
        500_000 + 30 * 86_400 * 2,
        "never written here: 30 days assumed"
    );
    let pcf = Pcf8563::attach(&mut Bus::with(FakeRtc::new(Kind::Pcf8563)), 0x51)
        .unwrap()
        .caps();
    assert_eq!(policy::drift_ppm(pcf), 25);
}

#[test]
fn writeback_rules() {
    let base = WritebackInput {
        clock_source: Some(Source::Sntp),
        clock_err_us: 5_000,
        rtc_valid: true,
        rtc_diff_us: Some(200_000),
        since_write_s: Some(3_600),
        force: false,
    };
    assert_eq!(
        policy::writeback_due(&base),
        Writeback::No,
        "in step, written an hour ago"
    );
    let w = |f: &dyn Fn(&mut WritebackInput)| {
        let mut i = base;
        f(&mut i);
        policy::writeback_due(&i)
    };
    assert_eq!(w(&|i| i.rtc_diff_us = Some(-1_500_000)), Writeback::Drifted);
    assert_eq!(w(&|i| i.since_write_s = Some(86_400)), Writeback::Daily);
    assert_eq!(w(&|i| i.since_write_s = None), Writeback::NeverWritten);
    assert_eq!(w(&|i| i.rtc_valid = false), Writeback::ChipInvalid);
    assert_eq!(w(&|i| i.force = true), Writeback::Forced);
    assert_eq!(w(&|i| i.clock_source = Some(Source::App)), Writeback::No);
    assert_eq!(
        w(&|i| {
            i.clock_source = Some(Source::Mesh);
            i.rtc_diff_us = Some(2_000_000)
        }),
        Writeback::Drifted
    );
    // Never from the chip itself, nor an invalid clock, nor a vague one.
    assert_eq!(
        w(&|i| {
            i.clock_source = Some(Source::HwRtc);
            i.force = true
        }),
        Writeback::No
    );
    assert_eq!(w(&|i| i.clock_source = None), Writeback::No);
    assert_eq!(
        w(&|i| {
            i.clock_err_us = 400_000;
            i.rtc_valid = false
        }),
        Writeback::No
    );
    // The carry-over fills a chip that lost time, never overrides one that kept it.
    assert_eq!(
        w(&|i| {
            i.clock_source = Some(Source::Carry);
            i.rtc_diff_us = Some(5_000_000)
        }),
        Writeback::No
    );
    assert_eq!(
        w(&|i| {
            i.clock_source = Some(Source::Carry);
            i.rtc_valid = false
        }),
        Writeback::ChipInvalid
    );
    // No reading since the last write: wait for the verify read.
    assert_eq!(w(&|i| i.rtc_diff_us = None), Writeback::No);
}
