//! The subset of `google/protobuf/descriptor.proto` the generator needs, read
//! with pbview's own runtime (the generator has no other dependencies).

use pbview::{fields, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Label {
    Optional,
    Required,
    Repeated,
}

#[derive(Debug, Clone)]
pub struct FieldDesc {
    pub name: String,
    pub number: u32,
    pub label: Label,
    /// descriptor.proto FieldDescriptorProto.Type (1 = double … 18 = sint64).
    pub ty: u32,
    /// Fully-qualified (".pkg.Msg") for message / enum fields.
    pub type_name: String,
    pub oneof_index: Option<u32>,
    pub proto3_optional: bool,
}

#[derive(Debug, Clone)]
pub struct EnumDesc {
    pub name: String,
    pub values: Vec<(String, i32)>,
}

#[derive(Debug, Clone)]
pub struct MessageDesc {
    pub name: String,
    pub fields: Vec<FieldDesc>,
    pub nested: Vec<MessageDesc>,
    pub enums: Vec<EnumDesc>,
    pub oneofs: Vec<String>,
    pub map_entry: bool,
}

#[derive(Debug, Clone)]
pub struct FileDesc {
    pub name: String,
    pub package: String,
    pub messages: Vec<MessageDesc>,
    pub enums: Vec<EnumDesc>,
    pub proto3: bool,
}

fn s(v: Value<'_>) -> Result<String, String> {
    match v {
        Value::Len(b) => String::from_utf8(b.to_vec()).map_err(|e| e.to_string()),
        _ => Err("expected a string field".into()),
    }
}

fn u(v: Value<'_>) -> Result<u64, String> {
    match v {
        Value::Varint(x) => Ok(x),
        _ => Err("expected a varint field".into()),
    }
}

fn b(v: Value<'_>) -> Result<&[u8], String> {
    match v {
        Value::Len(b) => Ok(b),
        _ => Err("expected a length-delimited field".into()),
    }
}

fn check(buf: &[u8]) -> Result<(), String> {
    for f in pbview::Reader::new(buf) {
        f.map_err(|e| format!("malformed descriptor: {e:?}"))?;
    }
    Ok(())
}

fn enum_desc(buf: &[u8]) -> Result<EnumDesc, String> {
    check(buf)?;
    let mut e = EnumDesc { name: String::new(), values: Vec::new() };
    for f in fields(buf) {
        match f.number {
            1 => e.name = s(f.value)?,
            2 => {
                let vb = b(f.value)?;
                let (mut name, mut number) = (String::new(), 0i32);
                for g in fields(vb) {
                    match g.number {
                        1 => name = s(g.value)?,
                        2 => number = u(g.value)? as i32,
                        _ => {}
                    }
                }
                e.values.push((name, number));
            }
            _ => {}
        }
    }
    Ok(e)
}

fn field_desc(buf: &[u8]) -> Result<FieldDesc, String> {
    check(buf)?;
    let mut d = FieldDesc {
        name: String::new(),
        number: 0,
        label: Label::Optional,
        ty: 0,
        type_name: String::new(),
        oneof_index: None,
        proto3_optional: false,
    };
    for f in fields(buf) {
        match f.number {
            1 => d.name = s(f.value)?,
            3 => d.number = u(f.value)? as u32,
            4 => {
                d.label = match u(f.value)? {
                    2 => Label::Required,
                    3 => Label::Repeated,
                    _ => Label::Optional,
                }
            }
            5 => d.ty = u(f.value)? as u32,
            6 => d.type_name = s(f.value)?,
            9 => d.oneof_index = Some(u(f.value)? as u32),
            17 => d.proto3_optional = u(f.value)? != 0,
            _ => {}
        }
    }
    Ok(d)
}

fn message_desc(buf: &[u8]) -> Result<MessageDesc, String> {
    check(buf)?;
    let mut m = MessageDesc {
        name: String::new(),
        fields: Vec::new(),
        nested: Vec::new(),
        enums: Vec::new(),
        oneofs: Vec::new(),
        map_entry: false,
    };
    for f in fields(buf) {
        match f.number {
            1 => m.name = s(f.value)?,
            2 => m.fields.push(field_desc(b(f.value)?)?),
            3 => m.nested.push(message_desc(b(f.value)?)?),
            4 => m.enums.push(enum_desc(b(f.value)?)?),
            // MessageOptions.map_entry = 7
            7 => {
                for g in fields(b(f.value)?) {
                    if g.number == 7 {
                        m.map_entry = u(g.value)? != 0;
                    }
                }
            }
            8 => {
                let mut name = String::new();
                for g in fields(b(f.value)?) {
                    if g.number == 1 {
                        name = s(g.value)?;
                    }
                }
                m.oneofs.push(name);
            }
            _ => {}
        }
    }
    Ok(m)
}

/// Parse a `FileDescriptorSet` (protoc `--descriptor_set_out`).
pub fn parse_set(buf: &[u8]) -> Result<Vec<FileDesc>, String> {
    check(buf)?;
    let mut out = Vec::new();
    for f in fields(buf) {
        if f.number != 1 {
            continue;
        }
        let fb = b(f.value)?;
        check(fb)?;
        let mut fd = FileDesc {
            name: String::new(),
            package: String::new(),
            messages: Vec::new(),
            enums: Vec::new(),
            proto3: false,
        };
        for g in fields(fb) {
            match g.number {
                1 => fd.name = s(g.value)?,
                2 => fd.package = s(g.value)?,
                4 => fd.messages.push(message_desc(b(g.value)?)?),
                5 => fd.enums.push(enum_desc(b(g.value)?)?),
                12 => fd.proto3 = s(g.value)? == "proto3",
                _ => {}
            }
        }
        out.push(fd);
    }
    Ok(out)
}
