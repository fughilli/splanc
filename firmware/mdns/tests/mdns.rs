//! The responder against hand-built queries, decoded back with a small DNS reader.

use ledmapper_mdns::{announce, host_label, igmp_v2_report, inet_checksum, respond, Dest, Service};

const TXT: &[(&str, &str)] = &[
    ("id", "AA:BB:CC:DD:EE:FF"),
    ("name", "Kitchen"),
    ("fw", "1.6.0"),
    ("path", "/.well-known/splanc.json"),
];

fn svc() -> Service<'static> {
    Service { host: "splanc-ddeeff", instance: "Kitchen", port: 443, ip: [192, 168, 4, 23], txt: TXT }
}

fn qname(name: &str) -> Vec<u8> {
    let mut v = Vec::new();
    for l in name.split('.') {
        v.push(l.len() as u8);
        v.extend_from_slice(l.as_bytes());
    }
    v.push(0);
    v
}

fn query(id: u16, qs: &[(&str, u16, bool)]) -> Vec<u8> {
    let mut m = id.to_be_bytes().to_vec();
    m.extend([0, 0]);
    m.extend((qs.len() as u16).to_be_bytes());
    m.extend([0, 0, 0, 0, 0, 0]);
    for (name, qtype, qu) in qs {
        m.extend(qname(name));
        m.extend(qtype.to_be_bytes());
        m.extend((1u16 | if *qu { 0x8000 } else { 0 }).to_be_bytes());
    }
    m
}

#[derive(Debug)]
struct Rr {
    name: String,
    rtype: u16,
    class: u16,
    ttl: u32,
    rdata: Vec<u8>,
    rdata_off: usize,
}

fn name_at(m: &[u8], mut off: usize) -> (String, usize) {
    let mut labels = Vec::new();
    let mut end = None;
    loop {
        let l = m[off] as usize;
        if l & 0xc0 == 0xc0 {
            end.get_or_insert(off + 2);
            off = ((l & 0x3f) << 8) | m[off + 1] as usize;
            continue;
        }
        if l == 0 {
            return (labels.join("."), end.unwrap_or(off + 1));
        }
        labels.push(String::from_utf8(m[off + 1..off + 1 + l].to_vec()).unwrap());
        off += 1 + l;
    }
}

struct Msg {
    id: u16,
    flags: u16,
    questions: usize,
    answers: Vec<Rr>,
    additional: Vec<Rr>,
}

fn decode(m: &[u8]) -> Msg {
    let be = |o: usize| u16::from_be_bytes([m[o], m[o + 1]]);
    let (qd, an, ns, ar) = (be(4), be(6), be(8), be(10));
    let mut off = 12;
    for _ in 0..qd {
        off = name_at(m, off).1 + 4;
    }
    let mut rrs = Vec::new();
    for _ in 0..(an + ns + ar) {
        let (name, o) = name_at(m, off);
        let rdlen = be(o + 8) as usize;
        rrs.push(Rr {
            name,
            rtype: be(o),
            class: be(o + 2),
            ttl: u32::from_be_bytes([m[o + 4], m[o + 5], m[o + 6], m[o + 7]]),
            rdata: m[o + 10..o + 10 + rdlen].to_vec(),
            rdata_off: o + 10,
        });
        off = o + 10 + rdlen;
    }
    assert_eq!(off, m.len(), "no trailing bytes");
    let additional = rrs.split_off(an as usize);
    Msg { id: be(0), flags: be(2), questions: qd as usize, answers: rrs, additional }
}

fn txt_strings(rdata: &[u8]) -> Vec<String> {
    let mut v = Vec::new();
    let mut o = 0;
    while o < rdata.len() {
        let l = rdata[o] as usize;
        v.push(String::from_utf8(rdata[o + 1..o + 1 + l].to_vec()).unwrap());
        o += 1 + l;
    }
    v
}

fn ask(q: &[u8], sport: u16) -> Option<(Msg, Dest, Vec<u8>)> {
    let mut out = [0u8; 1024];
    let r = respond(q, sport, &svc(), &mut out)?;
    Some((decode(&out[..r.len]), r.dest, out[..r.len].to_vec()))
}

#[test]
fn a_browse_gets_the_ptr_and_everything_to_connect() {
    let (m, dest, raw) = ask(&query(0, &[("_splanc._tcp.local", 12, false)]), 5353).unwrap();
    assert_eq!(dest, Dest::Multicast);
    assert_eq!((m.id, m.flags, m.questions), (0, 0x8400, 0));
    assert_eq!(m.answers.len(), 1);
    let ptr = &m.answers[0];
    assert_eq!((ptr.name.as_str(), ptr.rtype, ptr.ttl), ("_splanc._tcp.local", 12, 4500));
    assert_eq!(name_at(&raw, ptr.rdata_off).0, "Kitchen._splanc._tcp.local");

    let kinds: Vec<u16> = m.additional.iter().map(|r| r.rtype).collect();
    assert_eq!(kinds, vec![33, 16, 1], "SRV, TXT, A as additional records");
    let srv = &m.additional[0];
    assert_eq!(srv.class, 0x8001, "unique record: cache-flush set");
    assert_eq!(u16::from_be_bytes([srv.rdata[4], srv.rdata[5]]), 443);
    assert_eq!(name_at(&raw, srv.rdata_off + 6).0, "splanc-ddeeff.local");
    assert_eq!(
        txt_strings(&m.additional[1].rdata),
        vec!["id=AA:BB:CC:DD:EE:FF", "name=Kitchen", "fw=1.6.0", "path=/.well-known/splanc.json"]
    );
    let a = &m.additional[2];
    assert_eq!((a.name.as_str(), a.rdata.as_slice()), ("splanc-ddeeff.local", &[192u8, 168, 4, 23][..]));
}

#[test]
fn the_host_a_record_resolves_case_insensitively() {
    let (m, _, _) = ask(&query(0, &[("SPLANC-DDEEFF.local", 1, false)]), 5353).unwrap();
    assert_eq!(m.answers.len(), 1);
    assert_eq!((m.answers[0].rtype, m.answers[0].rdata.as_slice()), (1, &[192u8, 168, 4, 23][..]));
    assert!(m.additional.is_empty());
}

#[test]
fn srv_and_txt_resolve_the_instance() {
    let (m, _, _) =
        ask(&query(0, &[("Kitchen._splanc._tcp.local", 33, false), ("kitchen._splanc._tcp.local", 16, false)]), 5353)
            .unwrap();
    let kinds: Vec<u16> = m.answers.iter().map(|r| r.rtype).collect();
    assert_eq!(kinds, vec![33, 16]);
    assert_eq!(m.additional.iter().map(|r| r.rtype).collect::<Vec<_>>(), vec![1]);
}

#[test]
fn service_enumeration_lists_the_type() {
    let (m, _, raw) = ask(&query(0, &[("_services._dns-sd._udp.local", 12, false)]), 5353).unwrap();
    assert_eq!(m.answers.len(), 1);
    assert_eq!(name_at(&raw, m.answers[0].rdata_off).0, "_splanc._tcp.local");
}

#[test]
fn qu_questions_get_a_unicast_reply() {
    let (_, dest, _) = ask(&query(0, &[("_splanc._tcp.local", 12, true)]), 5353).unwrap();
    assert_eq!(dest, Dest::Unicast);
}

#[test]
fn a_legacy_resolver_gets_its_id_its_question_and_short_ttls() {
    // e.g. `dig @<device> -p 5353 splanc-ddeeff.local` from an ephemeral port.
    let q = query(0xbeef, &[("splanc-ddeeff.local", 1, false)]);
    let (m, dest, _) = ask(&q, 40000).unwrap();
    assert_eq!(dest, Dest::Unicast);
    assert_eq!((m.id, m.questions), (0xbeef, 1));
    assert_eq!(m.answers[0].ttl, 10);
    assert_eq!(m.answers[0].class, 1, "no cache-flush bit in a legacy reply");
}

#[test]
fn compressed_question_names_are_followed() {
    // Q1 = _splanc._tcp.local; Q2 = "Kitchen" + pointer to Q1's name at offset 12.
    let mut q = query(0, &[("_splanc._tcp.local", 12, false)]);
    q[5] = 2;
    q.extend([7]);
    q.extend(b"Kitchen");
    q.extend([0xc0, 12, 0, 16, 0, 1]);
    let (m, _, _) = ask(&q, 5353).unwrap();
    assert_eq!(m.answers.iter().map(|r| r.rtype).collect::<Vec<_>>(), vec![12, 16]);
}

#[test]
fn foreign_and_malformed_messages_are_ignored() {
    assert!(ask(&query(0, &[("_http._tcp.local", 12, false)]), 5353).is_none());
    assert!(ask(&query(0, &[("other.local", 1, false)]), 5353).is_none());
    // A response (QR set) is never answered.
    let mut r = query(0, &[("_splanc._tcp.local", 12, false)]);
    r[2] = 0x84;
    assert!(ask(&r, 5353).is_none());
    // Truncated / looping names.
    let q = query(0, &[("_splanc._tcp.local", 12, false)]);
    assert!(ask(&q[..q.len() - 3], 5353).is_none());
    let mut lp = q[..12].to_vec();
    lp.extend([0xc0, 12, 0, 12, 0, 1]);
    assert!(ask(&lp, 5353).is_none());
    assert!(ask(&[0u8; 5], 5353).is_none());
}

#[test]
fn a_small_buffer_is_refused_not_overrun() {
    let mut out = [0u8; 40];
    assert!(respond(&query(0, &[("_splanc._tcp.local", 12, false)]), 5353, &svc(), &mut out).is_none());
}

#[test]
fn the_announcement_carries_every_record() {
    let mut out = [0u8; 1024];
    let n = announce(&svc(), &mut out).unwrap();
    let m = decode(&out[..n]);
    assert_eq!(m.answers.iter().map(|r| r.rtype).collect::<Vec<_>>(), vec![12, 12, 33, 16, 1]);
}

#[test]
fn long_instance_names_are_cut_to_one_label() {
    let long = "é".repeat(40); // 80 bytes
    let s = Service { instance: &long, ..svc() };
    let mut out = [0u8; 1024];
    let n = announce(&s, &mut out).unwrap();
    let m = decode(&out[..n]);
    let inst = m.answers.iter().find(|r| r.rtype == 33).unwrap();
    let label = inst.name.split('.').next().unwrap();
    assert!(label.len() <= 63 && long.starts_with(label));
}

#[test]
fn host_labels_come_from_the_mac() {
    let mut b = [0u8; 13];
    assert_eq!(host_label("AA:BB:CC:DD:EE:FF", &mut b), "splanc-ddeeff");
    assert_eq!(host_label("", &mut b), "splanc");
}

#[test]
fn the_igmp_report_joins_the_mdns_group() {
    let r = igmp_v2_report();
    assert_eq!((r[0], &r[4..]), (0x16, &[224u8, 0, 0, 251][..]));
    assert_eq!(inet_checksum(&r), 0, "checksum verifies");
}
