//! `pbview-gen`: emit zero-copy protobuf views (for the `pbview` runtime) from a
//! `FileDescriptorSet`.
//!
//! Per message `Foo` it emits:
//! - `FooView<'a>`: a borrowed, `Copy` view (one slice) with `parse` (validates
//!   once: framing, wire types, UTF-8, nesting depth), one lazy accessor per
//!   field, and `FIELD_*` number constants;
//! - `foo::AnyField<'a>` + `FooView::fields()`: a single-pass typed field
//!   iterator, for hot paths that read many fields;
//! - `foo::<Oneof><'a>` + `FooView::<oneof>()`: each oneof as a borrowed enum,
//!   so an envelope dispatches with one `match`, straight from the wire;
//! - nested messages / enums inside `pub mod foo`.
//!
//! Enums become `#[repr(i32)]` Rust enums with `TryFrom<i32>`; enum-typed
//! fields return the raw `i32` (proto3 enums are open).
//!
//! Lazy vs indexed: accessors re-scan the message's top level on each call
//! (O(fields) per access, zero extra state). For control-sized messages that
//! read a handful of fields this is cheaper than building an offset index
//! (stack proportional to the field count); hot paths that read most fields
//! use the single-pass `fields()` iterator instead.

pub mod descriptor;

use descriptor::{FieldDesc, FileDesc, Label, MessageDesc};
use std::collections::HashMap;
use std::fmt::Write as _;

/// Generator options.
#[derive(Debug, Clone, Default)]
pub struct Options {
    /// Emit crate-root attributes (`#![no_std]`, lint allows) so the output can
    /// be a crate root on its own.
    pub crate_root: bool,
    /// Path the generated code uses to reach the runtime (default `::pbview`).
    pub runtime: Option<String>,
}

/// Generate Rust for every file in the descriptor set.
pub fn generate(fdset: &[u8], opts: &Options) -> Result<String, String> {
    let files = descriptor::parse_set(fdset)?;
    Gen::new(&files, opts).run()
}

const KEYWORDS: &[&str] = &[
    "as", "break", "const", "continue", "else", "enum", "extern", "false", "fn", "for", "if",
    "impl", "in", "let", "loop", "match", "mod", "move", "mut", "pub", "ref", "return", "static",
    "struct", "trait", "true", "type", "unsafe", "use", "where", "while", "async", "await", "dyn",
    "abstract", "become", "box", "do", "final", "macro", "override", "priv", "typeof",
    "unsized", "virtual", "yield", "try", "gen",
];
/// Inherent view methods a field accessor must not shadow.
const RESERVED_METHODS: &[&str] =
    &["parse", "as_bytes", "fields", "from_bytes_unchecked", "validate", "new_unchecked"];

/// `FooBar` / `fooBar` / `HTTPServer` -> `foo_bar` / `http_server`.
pub fn snake(name: &str) -> String {
    let c: Vec<char> = name.chars().collect();
    let mut out = String::new();
    for (i, &ch) in c.iter().enumerate() {
        if ch.is_ascii_uppercase() {
            let prev = if i > 0 { Some(c[i - 1]) } else { None };
            let next = c.get(i + 1).copied();
            let boundary = match prev {
                Some(p) if p.is_ascii_lowercase() || p.is_ascii_digit() => true,
                Some(p) if p.is_ascii_uppercase() => next.is_some_and(|n| n.is_ascii_lowercase()),
                _ => false,
            };
            if boundary && !out.ends_with('_') {
                out.push('_');
            }
            out.push(ch.to_ascii_lowercase());
        } else {
            out.push(ch);
        }
    }
    out
}

/// `time_sync_ping` / `PIN_SAFETY_OK` -> `TimeSyncPing` / `PinSafetyOk`.
pub fn camel(name: &str) -> String {
    let mut out = String::new();
    for part in name.split('_').filter(|p| !p.is_empty()) {
        let mut cs = part.chars();
        if let Some(f) = cs.next() {
            out.push(f.to_ascii_uppercase());
            let rest: String = cs.collect();
            if part.chars().all(|c| !c.is_ascii_lowercase()) {
                out.push_str(&rest.to_ascii_lowercase());
            } else {
                out.push_str(&rest);
            }
        }
    }
    out
}

fn ident(name: &str) -> String {
    match name {
        "self" | "Self" | "super" | "crate" => format!("{name}_"),
        n if KEYWORDS.contains(&n) => format!("r#{n}"),
        n => n.to_string(),
    }
}

/// Where a generated type lives: module path from the generated root + ident.
#[derive(Clone)]
struct TypeLoc {
    module: Vec<String>,
    ident: String,
}

struct Gen<'f> {
    files: &'f [FileDesc],
    opts: &'f Options,
    rt: String,
    types: HashMap<String, TypeLoc>,
    enums: HashMap<String, ()>,
}

/// The pbview scalar kind for a descriptor field type, with its Rust type and
/// default literal.
fn scalar(ty: u32) -> Option<(&'static str, &'static str, &'static str)> {
    Some(match ty {
        1 => ("Double", "f64", "0.0"),
        2 => ("Float", "f32", "0.0"),
        3 => ("Int64", "i64", "0"),
        4 => ("Uint64", "u64", "0"),
        5 => ("Int32", "i32", "0"),
        6 => ("Fixed64", "u64", "0"),
        7 => ("Fixed32", "u32", "0"),
        8 => ("Bool", "bool", "false"),
        13 => ("Uint32", "u32", "0"),
        14 => ("Enum", "i32", "0"),
        15 => ("Sfixed32", "i32", "0"),
        16 => ("Sfixed64", "i64", "0"),
        17 => ("Sint32", "i32", "0"),
        18 => ("Sint64", "i64", "0"),
        _ => return None,
    })
}

const TY_STRING: u32 = 9;
const TY_GROUP: u32 = 10;
const TY_MESSAGE: u32 = 11;
const TY_BYTES: u32 = 12;

impl<'f> Gen<'f> {
    fn new(files: &'f [FileDesc], opts: &'f Options) -> Self {
        let mut g = Gen {
            files,
            opts,
            rt: opts.runtime.clone().unwrap_or_else(|| "::pbview".into()),
            types: HashMap::new(),
            enums: HashMap::new(),
        };
        for f in files {
            let pkg: Vec<String> =
                f.package.split('.').filter(|p| !p.is_empty()).map(ident).collect();
            let prefix = if f.package.is_empty() { String::new() } else { format!(".{}", f.package) };
            for m in &f.messages {
                g.index_message(&prefix, &pkg, m);
            }
            for e in &f.enums {
                let full = format!("{prefix}.{}", e.name);
                g.types.insert(full.clone(), TypeLoc { module: pkg.clone(), ident: ident(&e.name) });
                g.enums.insert(full, ());
            }
        }
        g
    }

    fn index_message(&mut self, prefix: &str, module: &[String], m: &MessageDesc) {
        let full = format!("{prefix}.{}", m.name);
        self.types.insert(
            full.clone(),
            TypeLoc { module: module.to_vec(), ident: format!("{}View", m.name) },
        );
        let mut inner = module.to_vec();
        inner.push(ident(&snake(&m.name)));
        for n in &m.nested {
            self.index_message(&full, &inner, n);
        }
        for e in &m.enums {
            let ef = format!("{full}.{}", e.name);
            self.types.insert(ef.clone(), TypeLoc { module: inner.clone(), ident: ident(&e.name) });
            self.enums.insert(ef, ());
        }
    }

    /// Path from module `from` to type `full`.
    fn path(&self, from: &[String], full: &str) -> Result<String, String> {
        let loc = self.types.get(full).ok_or_else(|| format!("unknown type {full}"))?;
        let mut p = String::new();
        for _ in from {
            p.push_str("super::");
        }
        for m in &loc.module {
            p.push_str(m);
            p.push_str("::");
        }
        p.push_str(&loc.ident);
        Ok(p)
    }

    fn run(&self) -> Result<String, String> {
        let mut out = String::new();
        out.push_str("// @generated by pbview-gen. Do not edit.\n");
        if self.opts.crate_root {
            out.push_str("#![no_std]\n");
        }
        out.push_str(
            "#![allow(clippy::all, dead_code, non_camel_case_types, unused_imports, unused_mut, unused_variables)]\n",
        );
        // Group files by package so a package's module is emitted once.
        let mut pkgs: Vec<(String, Vec<&FileDesc>)> = Vec::new();
        for f in self.files {
            match pkgs.iter_mut().find(|(p, _)| *p == f.package) {
                Some((_, v)) => v.push(f),
                None => pkgs.push((f.package.clone(), vec![f])),
            }
        }
        for (pkg, files) in &pkgs {
            let parts: Vec<String> = pkg.split('.').filter(|p| !p.is_empty()).map(ident).collect();
            for p in &parts {
                let _ = writeln!(out, "pub mod {p} {{");
            }
            for f in files {
                for e in &f.enums {
                    self.emit_enum(&mut out, e);
                }
                for m in &f.messages {
                    self.emit_message(&mut out, &parts, m, f.proto3)?;
                }
            }
            for _ in &parts {
                out.push_str("}\n");
            }
        }
        Ok(out)
    }

    fn emit_enum(&self, out: &mut String, e: &descriptor::EnumDesc) {
        let name = ident(&e.name);
        let prefix = format!("{}_", snake(&e.name).to_ascii_uppercase());
        let mut seen = std::collections::HashSet::new();
        let mut variants = Vec::new();
        for (vname, num) in &e.values {
            if !seen.insert(*num) {
                continue; // allow_alias: keep the first name per number
            }
            let stripped = vname.strip_prefix(&prefix).unwrap_or(vname);
            let mut v = camel(stripped);
            if v.is_empty() || v.starts_with(|c: char| c.is_ascii_digit()) {
                v = camel(vname);
            }
            variants.push((ident(&v), *num));
        }
        let _ = writeln!(out, "#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]\n#[repr(i32)]");
        let _ = writeln!(out, "pub enum {name} {{");
        for (v, n) in &variants {
            let _ = writeln!(out, "    {v} = {n},");
        }
        let _ = writeln!(out, "}}");
        let _ = writeln!(out, "impl core::convert::TryFrom<i32> for {name} {{");
        let _ = writeln!(out, "    type Error = i32;");
        let _ = writeln!(out, "    fn try_from(v: i32) -> Result<Self, i32> {{");
        let _ = writeln!(out, "        match v {{");
        for (v, n) in &variants {
            let _ = writeln!(out, "            {n} => Ok({name}::{v}),");
        }
        let _ = writeln!(out, "            other => Err(other),\n        }}\n    }}\n}}");
    }

    /// Accessor name for a field (keyword-escaped, not shadowing view methods).
    fn acc(&self, f: &FieldDesc) -> String {
        let n = snake(&f.name);
        if RESERVED_METHODS.contains(&n.as_str()) {
            return format!("{n}_");
        }
        ident(&n)
    }

    fn has_presence(&self, f: &FieldDesc, proto3: bool) -> bool {
        f.ty == TY_MESSAGE || f.oneof_index.is_some() || f.proto3_optional || !proto3
    }

    fn emit_message(
        &self,
        out: &mut String,
        module: &[String],
        m: &MessageDesc,
        proto3: bool,
    ) -> Result<(), String> {
        let rt = &self.rt;
        let view = format!("{}View", m.name);
        let modname = ident(&snake(&m.name));
        let mut inner_mod = module.to_vec();
        inner_mod.push(modname.clone());

        for f in &m.fields {
            if f.ty == TY_GROUP {
                return Err(format!("{}.{}: groups are not supported", m.name, f.name));
            }
        }
        // Real oneofs (proto3 `optional` makes a synthetic single-field one).
        let real_oneof = |i: u32| m.fields.iter().any(|f| f.oneof_index == Some(i) && !f.proto3_optional);

        let _ = writeln!(out, "/// Zero-copy view of `{}`.", m.name);
        let _ = writeln!(out, "#[derive(Clone, Copy)]\npub struct {view}<'a> {{ buf: &'a [u8] }}");
        let _ = writeln!(out, "impl<'a> core::fmt::Debug for {view}<'a> {{");
        let _ = writeln!(
            out,
            "    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {{ write!(f, \"{view}({{}} B)\", self.buf.len()) }}\n}}"
        );
        let _ = writeln!(out, "impl<'a> {view}<'a> {{");
        for f in &m.fields {
            let _ = writeln!(out, "    pub const FIELD_{}: u32 = {};", snake(&f.name).to_ascii_uppercase(), f.number);
        }
        let _ = writeln!(
            out,
            "    /// Validate `buf` (framing, wire types, UTF-8, nesting <= {rt}::DEFAULT_MAX_DEPTH) and wrap it.\n    pub fn parse(buf: &'a [u8]) -> {rt}::Result<Self> {{\n        <Self as {rt}::View<'a>>::validate(buf, {rt}::DEFAULT_MAX_DEPTH)?;\n        Ok({view} {{ buf }})\n    }}"
        );
        let _ = writeln!(
            out,
            "    /// Wrap without validating (accessors stay bounds-safe).\n    pub const fn new_unchecked(buf: &'a [u8]) -> Self {{ {view} {{ buf }} }}"
        );
        let _ = writeln!(out, "    pub const fn as_bytes(&self) -> &'a [u8] {{ self.buf }}");
        let _ = writeln!(
            out,
            "    /// Single pass over every field, decoded.\n    pub fn fields(&self) -> {modname}::Fields<'a> {{ {modname}::Fields {{ r: {rt}::Reader::new(self.buf) }} }}"
        );

        for f in &m.fields {
            let acc = self.acc(f);
            let num = f.number;
            let doc = format!("    /// `{}` = {}.", f.name, f.number);
            if f.label == Label::Repeated {
                let ret = self.repeated_ty(module, f)?;
                let ctor = self.repeated_ctor(f);
                let _ = writeln!(out, "{doc}\n    pub fn {acc}(&self) -> {ret} {{ {ctor}(self.buf, {num}) }}");
                continue;
            }
            let pres = self.has_presence(f, proto3);
            if let Some((k, ty, def)) = scalar(f.ty) {
                let get = format!("{rt}::last_scalar::<{rt}::kind::{k}>(self.buf, {num})");
                if pres {
                    let _ = writeln!(out, "{doc}\n    pub fn {acc}(&self) -> Option<{ty}> {{ {get} }}");
                } else {
                    let _ = writeln!(out, "{doc}\n    pub fn {acc}(&self) -> {ty} {{ {get}.unwrap_or({def}) }}");
                }
            } else if f.ty == TY_STRING || f.ty == TY_BYTES {
                let (ty, conv, def) = if f.ty == TY_STRING {
                    ("&'a str", format!("{rt}::str_of"), "\"\"")
                } else {
                    ("&'a [u8]", "core::convert::identity".to_string(), "&[]")
                };
                let get = format!("{rt}::last_len(self.buf, {num}).map({conv})");
                if pres {
                    let _ = writeln!(out, "{doc}\n    pub fn {acc}(&self) -> Option<{ty}> {{ {get} }}");
                } else {
                    let _ = writeln!(out, "{doc}\n    pub fn {acc}(&self) -> {ty} {{ {get}.unwrap_or({def}) }}");
                }
            } else if f.ty == TY_MESSAGE {
                let sub = self.path(module, &f.type_name)?;
                let _ = writeln!(
                    out,
                    "{doc}\n    pub fn {acc}(&self) -> Option<{sub}<'a>> {{ {rt}::last_len(self.buf, {num}).map(<{sub}<'a> as {rt}::View<'a>>::from_bytes_unchecked) }}"
                );
            }
        }
        // Oneofs as borrowed enums (last member occurrence wins).
        for (i, oname) in m.oneofs.iter().enumerate() {
            let i = i as u32;
            if !real_oneof(i) {
                continue;
            }
            let ety = camel(oname);
            let members: Vec<&FieldDesc> = m.fields.iter().filter(|f| f.oneof_index == Some(i)).collect();
            let lt = if self.oneof_borrows(&members) { "<'a>" } else { "" };
            let acc = {
                let n = snake(oname);
                if RESERVED_METHODS.contains(&n.as_str()) || m.fields.iter().any(|f| snake(&f.name) == n) {
                    format!("{n}_oneof")
                } else {
                    ident(&n)
                }
            };
            let _ = writeln!(
                out,
                "    /// The `{oname}` oneof: the arm set last on the wire.\n    pub fn {acc}(&self) -> Option<{modname}::{ety}{lt}> {{"
            );
            let _ = writeln!(out, "        let mut last = None;");
            let _ = writeln!(out, "        for f in {rt}::fields(self.buf) {{");
            let _ = writeln!(out, "            match f.number {{");
            for f in &members {
                let v = ident(&camel(&f.name));
                let conv = self.value_conv(module, f, "f.value")?;
                let _ = writeln!(
                    out,
                    "                {} => if let Some(x) = {conv} {{ last = Some({modname}::{ety}::{v}(x)); }},",
                    f.number
                );
            }
            let _ = writeln!(out, "                _ => {{}}\n            }}\n        }}\n        last\n    }}");
        }
        let _ = writeln!(out, "}}");

        // View impl: validation.
        let _ = writeln!(out, "impl<'a> {rt}::View<'a> for {view}<'a> {{");
        let _ = writeln!(out, "    fn validate(buf: &[u8], depth: u32) -> {rt}::Result<()> {{");
        let _ = writeln!(out, "        for f in {rt}::Reader::new(buf) {{");
        let _ = writeln!(out, "            let f = f?;");
        let _ = writeln!(out, "            match f.number {{");
        for f in &m.fields {
            let rep = f.label == Label::Repeated;
            let chk = if let Some((k, _, _)) = scalar(f.ty) {
                format!("{rt}::check_scalar::<{rt}::kind::{k}>(&f, {rep})?")
            } else if f.ty == TY_STRING {
                format!("{rt}::check_str(&f)?")
            } else if f.ty == TY_BYTES {
                format!("{{ {rt}::check_bytes(&f)?; }}")
            } else {
                let sub = self.path(module, &f.type_name)?;
                format!("{rt}::check_msg::<{sub}<'_>>(&f, depth)?")
            };
            let _ = writeln!(out, "                {} => {chk},", f.number);
        }
        let _ = writeln!(out, "                _ => {{}}\n            }}\n        }}\n        Ok(())\n    }}");
        let _ = writeln!(out, "    fn from_bytes_unchecked(buf: &'a [u8]) -> Self {{ {view} {{ buf }} }}");
        let _ = writeln!(out, "    fn as_bytes(&self) -> &'a [u8] {{ self.buf }}\n}}");

        // Nested module: oneof enums, the field enum, nested types.
        let _ = writeln!(out, "pub mod {modname} {{");
        for (i, oname) in m.oneofs.iter().enumerate() {
            let i = i as u32;
            if !real_oneof(i) {
                continue;
            }
            let members: Vec<&FieldDesc> = m.fields.iter().filter(|f| f.oneof_index == Some(i)).collect();
            let lt = if self.oneof_borrows(&members) { "<'a>" } else { "" };
            let _ = writeln!(out, "    /// The `{oname}` oneof of `{}`.", m.name);
            let _ = writeln!(out, "    #[derive(Debug, Clone, Copy)]\n    pub enum {}{lt} {{", camel(oname));
            for f in &members {
                let ty = self.single_ty(&inner_mod, f)?;
                let _ = writeln!(out, "        {}({ty}),", ident(&camel(&f.name)));
            }
            let _ = writeln!(out, "    }}");
        }
        // AnyField + Fields iterator.
        let _ = writeln!(out, "    /// One decoded field of `{}` (see `{view}::fields`).", m.name);
        let _ = writeln!(out, "    #[derive(Clone)]\n    pub enum AnyField<'a> {{");
        for f in &m.fields {
            let ty = if f.label == Label::Repeated {
                self.occurrence_ty(&inner_mod, f)?
            } else {
                self.single_ty(&inner_mod, f)?
            };
            let _ = writeln!(out, "        {}({ty}),", Self::any_variant(f));
        }
        let _ = writeln!(out, "        /// A field not in the schema (or one whose wire type doesn't match it).");
        let _ = writeln!(out, "        Unknown({rt}::Field<'a>),\n    }}");
        let _ = writeln!(out, "    pub struct Fields<'a> {{ pub(super) r: {rt}::Reader<'a> }}");
        let _ = writeln!(out, "    impl<'a> Iterator for Fields<'a> {{");
        let _ = writeln!(out, "        type Item = AnyField<'a>;");
        let _ = writeln!(out, "        fn next(&mut self) -> Option<AnyField<'a>> {{");
        let _ = writeln!(out, "            let f = self.r.next()?.ok()?;");
        let _ = writeln!(out, "            Some(match f.number {{");
        for f in &m.fields {
            let v = Self::any_variant(f);
            let conv = if f.label == Label::Repeated {
                self.occurrence_conv(&inner_mod, f, "f.value")?
            } else {
                self.value_conv(&inner_mod, f, "f.value")?
            };
            let _ = writeln!(
                out,
                "                {} => match {conv} {{ Some(x) => AnyField::{v}(x), None => AnyField::Unknown(f) }},",
                f.number
            );
        }
        let _ = writeln!(out, "                _ => AnyField::Unknown(f),\n            }})\n        }}\n    }}");
        for e in &m.enums {
            self.emit_enum(out, e);
        }
        for n in &m.nested {
            self.emit_message(out, &inner_mod, n, proto3)?;
        }
        let _ = writeln!(out, "}}");
        Ok(())
    }

    /// `AnyField` variant for a field (never the reserved `Unknown`).
    fn any_variant(f: &FieldDesc) -> String {
        let v = camel(&f.name);
        if v == "Unknown" {
            "Unknown_".into()
        } else {
            ident(&v)
        }
    }

    fn oneof_borrows(&self, members: &[&FieldDesc]) -> bool {
        members.iter().any(|f| matches!(f.ty, TY_STRING | TY_BYTES | TY_MESSAGE))
    }

    /// The Rust type of one value of `f` (as seen from module `module`).
    fn single_ty(&self, module: &[String], f: &FieldDesc) -> Result<String, String> {
        Ok(if let Some((_, ty, _)) = scalar(f.ty) {
            ty.to_string()
        } else if f.ty == TY_STRING {
            "&'a str".into()
        } else if f.ty == TY_BYTES {
            "&'a [u8]".into()
        } else {
            format!("{}<'a>", self.path(module, &f.type_name)?)
        })
    }

    /// Convert one wire value expression to `Option<single_ty>`.
    fn value_conv(&self, module: &[String], f: &FieldDesc, v: &str) -> Result<String, String> {
        let rt = &self.rt;
        Ok(if let Some((k, _, _)) = scalar(f.ty) {
            format!("<{rt}::kind::{k} as {rt}::ScalarKind>::from_value({v})")
        } else if f.ty == TY_STRING {
            format!("match {v} {{ {rt}::Value::Len(b) => core::str::from_utf8(b).ok(), _ => None }}")
        } else if f.ty == TY_BYTES {
            format!("match {v} {{ {rt}::Value::Len(b) => Some(b), _ => None }}")
        } else {
            let sub = self.path(module, &f.type_name)?;
            format!(
                "match {v} {{ {rt}::Value::Len(b) => Some(<{sub}<'a> as {rt}::View<'a>>::from_bytes_unchecked(b)), _ => None }}"
            )
        })
    }

    /// Type of ONE occurrence of a repeated field in `AnyField`: scalars carry
    /// the occurrence's elements (one value, or a packed run).
    fn occurrence_ty(&self, module: &[String], f: &FieldDesc) -> Result<String, String> {
        Ok(match scalar(f.ty) {
            Some((k, _, _)) => format!("{}::RepeatedScalar<'a, {}::kind::{k}>", self.rt, self.rt),
            None => self.single_ty(module, f)?,
        })
    }

    fn occurrence_conv(&self, module: &[String], f: &FieldDesc, v: &str) -> Result<String, String> {
        Ok(match scalar(f.ty) {
            Some(_) => format!("Some({}::RepeatedScalar::of_value({v}))", self.rt),
            None => self.value_conv(module, f, v)?,
        })
    }

    fn repeated_ty(&self, module: &[String], f: &FieldDesc) -> Result<String, String> {
        let rt = &self.rt;
        Ok(if let Some((k, _, _)) = scalar(f.ty) {
            format!("{rt}::RepeatedScalar<'a, {rt}::kind::{k}>")
        } else if f.ty == TY_STRING {
            format!("{rt}::RepeatedStr<'a>")
        } else if f.ty == TY_BYTES {
            format!("{rt}::RepeatedLen<'a>")
        } else {
            format!("{rt}::RepeatedMsg<'a, {}<'a>>", self.path(module, &f.type_name)?)
        })
    }

    fn repeated_ctor(&self, f: &FieldDesc) -> String {
        let rt = &self.rt;
        if scalar(f.ty).is_some() {
            format!("{rt}::RepeatedScalar::new")
        } else if f.ty == TY_STRING {
            format!("{rt}::RepeatedStr::new")
        } else if f.ty == TY_BYTES {
            format!("{rt}::RepeatedLen::new")
        } else {
            format!("{rt}::RepeatedMsg::new")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_mangling() {
        assert_eq!(snake("TimeSyncPing"), "time_sync_ping");
        assert_eq!(snake("HTTPServer"), "http_server");
        assert_eq!(snake("Vec3"), "vec3");
        assert_eq!(snake("led_count"), "led_count");
        assert_eq!(camel("time_sync_ping"), "TimeSyncPing");
        assert_eq!(camel("PIN_SAFETY_OK"), "PinSafetyOk");
        assert_eq!(ident("type"), "r#type");
        assert_eq!(ident("self"), "self_");
    }

    #[test]
    fn malformed_descriptor_is_an_error_not_a_panic() {
        assert!(generate(&[0x0a, 0x05, 0x01], &Options::default()).is_err());
        assert_eq!(generate(&[], &Options::default()).map(|s| s.contains("@generated")), Ok(true));
    }
}
