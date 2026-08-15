//! Effects compiler (docs/design/effects-compiler.md): a GLSL-ish shader source
//! → `.fxb` bytecode + a uniform manifest, for the effects VM (fx_vm). Runs on
//! the host (tests) and in the browser as wasm. A compact single-pass
//! type-checking codegen over a recursive-descent parse — enough for the
//! hybrid update()/shade() model, uniforms with ranges, scalar/vector math,
//! swizzles, the built-ins, if/else, for-loops, user functions, and user
//! `struct` types + fixed-size arrays with dynamic indexing (so scripts can
//! define e.g. agents with custom properties and simulate them in update()).

use std::collections::HashMap;
use std::fmt::Write as _;

// -- types --------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Ty {
    Float,
    Vec2,
    Vec3,
    Vec4,
    Int,   // native i32 (fast — no soft-float)
    Fixed, // Q16.16 fixed-point (fast fractional)
    // Reduced-precision fixed-point (FUG-10): `fixed8` is Q1.6 (s1.1.6) and
    // `fixed16` is Q1.14 (s1.1.14), both range [-2, 2). They enable the
    // accelerated integer sin/cos/exp path. Like `fixed`, the value rides in a
    // slot as a scaled integer, so +/-/neg/compare reuse the integer ops.
    Fixed8,
    Fixed16,
    Bool,
    Void,
    // Composite types (aggregate scalar/vec slots). The payload indexes the
    // compiler's `structs` / `arrays` side tables; their slot width comes from
    // `Compiler::ty_width` (NOT `Ty::width`, which only knows the primitives).
    Struct(u16),
    Array(u16),
}
impl Ty {
    /// Primitive slot width. Composites return 0 here — use
    /// [`Compiler::ty_width`], which consults the struct/array tables.
    fn width(self) -> u8 {
        match self {
            Ty::Float | Ty::Int | Ty::Fixed | Ty::Fixed8 | Ty::Fixed16 | Ty::Bool => 1,
            Ty::Vec2 => 2,
            Ty::Vec3 => 3,
            Ty::Vec4 => 4,
            Ty::Void | Ty::Struct(_) | Ty::Array(_) => 0,
        }
    }
    fn vec_of(n: u8) -> Ty {
        match n {
            1 => Ty::Float,
            2 => Ty::Vec2,
            3 => Ty::Vec3,
            _ => Ty::Vec4,
        }
    }
    fn is_num(self) -> bool {
        !matches!(self, Ty::Bool | Ty::Void | Ty::Struct(_) | Ty::Array(_))
    }
    fn is_scalar(self) -> bool {
        matches!(self, Ty::Float | Ty::Int | Ty::Fixed | Ty::Fixed8 | Ty::Fixed16)
    }
    /// Fraction bits for a fixed-family scalar (Int = 0 frac). `None` for float
    /// and non-scalars — the boundary that needs a soft-float conversion.
    fn fixed_frac(self) -> Option<u32> {
        match self {
            Ty::Int => Some(0),
            Ty::Fixed8 => Some(6),
            Ty::Fixed16 => Some(14),
            Ty::Fixed => Some(16),
            _ => None,
        }
    }
}

/// A field of a user `struct`: its name, type, and slot offset from the struct's
/// base (fields are laid out contiguously in declaration order).
#[derive(Clone)]
struct StructField {
    name: String,
    ty: Ty,
    offset: u8,
}

/// A registered `struct` type: its fields and total slot width.
#[derive(Clone)]
struct StructInfo {
    #[allow(dead_code)]
    name: String,
    fields: Vec<StructField>,
    width: u8,
}

/// A registered fixed-size array type `elem[count]`. Total width = elem_w*count.
#[derive(Clone, Copy)]
struct ArrayInfo {
    elem: Ty,
    elem_w: u8,
    count: u8,
}

/// Per-component storage precision codes for packed buffers/textures — mirrors
/// `fx_vm::comp`. Narrow formats pack a per-LED value into 1–2 bytes instead of a
/// 4-byte f32 slot (FUG-10). The `*F` variants store a compressed fixed but
/// present as a dequantized float (for float/vec colours); the plain fixed/int
/// variants present the raw scaled integer (the narrow first-class types).
mod comp {
    pub const F32: u8 = 0;
    pub const FIX16: u8 = 1;
    pub const FIX8: u8 = 2;
    pub const I16: u8 = 3;
    pub const I8: u8 = 4;
    pub const FIX16F: u8 = 5;
    pub const FIX8F: u8 = 6;
    pub const I32: u8 = 7;
}

/// A declared hidden buffer / texture. `kind` 0 = LED-arity (one element per
/// LED; the arena sizes it to led_count at run time), 1 = a WxH 2D texture.
/// `elem` is the component count of one element (1 = scalar … 4 = vec4) and
/// `comp` its per-component storage precision. Serialized into the `.fxb` buffer
/// table for the VM's LoadBuf/StoreBuf (see fx_vm).
#[derive(Clone, Copy)]
struct BufferInfo {
    kind: u8,
    elem: u8,
    comp: u8,
    w: u16,
    h: u16,
}

// -- uniform manifest ---------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
pub enum UiKind {
    Slider { min: f32, max: f32, step: f32 },
    Color,
    Toggle,
    Dropdown(Vec<String>),
}

#[derive(Clone, Debug)]
pub struct UniformInfo {
    pub name: String,
    pub ty: Ty,
    pub slot: u8,
    pub ui: UiKind,
    pub default: Vec<f32>,
}

#[derive(Clone, Debug)]
pub struct Diagnostic {
    pub line: u32,
    pub col: u32,
    pub msg: String,
}

/// A driver `export` (FUG-107): a named sensor reading `poll()` writes into a
/// state slot, which the firmware bridges into an effect uniform of the same
/// name. `unit` is a free-form display hint (e.g. "°C", "lux"); empty if none.
#[derive(Clone, Debug)]
pub struct ExportInfo {
    pub name: String,
    pub ty: Ty,
    pub slot: u8,
    pub unit: String,
}

pub struct Compiled {
    pub fxb: Vec<u8>,
    pub uniforms: Vec<UniformInfo>,
    /// Driver exports (empty for a plain effect). See [`ExportInfo`].
    pub exports: Vec<ExportInfo>,
}

// -- lexer --------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
enum Tok {
    Ident(String),
    Num(f32, bool), // value, is_int
    Str(String),
    Sym(char),
    Sym2([char; 2]), // == <= >= != && ||
    Range,           // ..
    Eof,
}

struct Lexer<'a> {
    s: &'a [u8],
    i: usize,
    line: u32,
    col: u32,
}
impl<'a> Lexer<'a> {
    fn new(s: &'a str) -> Self {
        Lexer { s: s.as_bytes(), i: 0, line: 1, col: 1 }
    }
    fn bump(&mut self) -> u8 {
        let c = self.s[self.i];
        self.i += 1;
        if c == b'\n' {
            self.line += 1;
            self.col = 1;
        } else {
            self.col += 1;
        }
        c
    }
    fn peek(&self, k: usize) -> u8 {
        *self.s.get(self.i + k).unwrap_or(&0)
    }
    fn next(&mut self) -> Result<(Tok, u32, u32), Diagnostic> {
        loop {
            while self.i < self.s.len() && (self.s[self.i] as char).is_whitespace() {
                self.bump();
            }
            // line comments
            if self.peek(0) == b'/' && self.peek(1) == b'/' {
                while self.i < self.s.len() && self.s[self.i] != b'\n' {
                    self.bump();
                }
                continue;
            }
            break;
        }
        let (line, col) = (self.line, self.col);
        if self.i >= self.s.len() {
            return Ok((Tok::Eof, line, col));
        }
        let c = self.peek(0);
        if (c as char).is_ascii_alphabetic() || c == b'_' {
            let mut id = String::new();
            while self.i < self.s.len()
                && ((self.s[self.i] as char).is_ascii_alphanumeric() || self.s[self.i] == b'_')
            {
                id.push(self.bump() as char);
            }
            return Ok((Tok::Ident(id), line, col));
        }
        if (c as char).is_ascii_digit() || (c == b'.' && (self.peek(1) as char).is_ascii_digit()) {
            let mut num = String::new();
            let mut is_int = true;
            while self.i < self.s.len() {
                let d = self.s[self.i];
                if (d as char).is_ascii_digit() {
                    num.push(self.bump() as char);
                } else if d == b'.' && self.peek(1) != b'.' {
                    is_int = false;
                    num.push(self.bump() as char);
                } else {
                    break;
                }
            }
            let v: f32 = num.parse().map_err(|_| Diagnostic {
                line,
                col,
                msg: format!("bad number '{num}'"),
            })?;
            return Ok((Tok::Num(v, is_int), line, col));
        }
        if c == b'"' {
            self.bump();
            // Collect raw bytes and decode as UTF-8 so multibyte characters
            // (e.g. "°C" units, non-ASCII dropdown labels) survive — pushing
            // each byte `as char` would mangle them (FUG-107).
            let mut bytes = Vec::new();
            while self.i < self.s.len() && self.s[self.i] != b'"' {
                bytes.push(self.bump());
            }
            if self.i < self.s.len() {
                self.bump();
            }
            let sv = String::from_utf8_lossy(&bytes).into_owned();
            return Ok((Tok::Str(sv), line, col));
        }
        // two-char operators
        let c2 = self.peek(1);
        if c == b'.' && c2 == b'.' {
            self.bump();
            self.bump();
            return Ok((Tok::Range, line, col));
        }
        for (a, b) in [
            (b'=', b'='),
            (b'<', b'='),
            (b'>', b'='),
            (b'!', b'='),
            (b'&', b'&'),
            (b'|', b'|'),
        ] {
            if c == a && c2 == b {
                self.bump();
                self.bump();
                return Ok((Tok::Sym2([a as char, b as char]), line, col));
            }
        }
        self.bump();
        Ok((Tok::Sym(c as char), line, col))
    }
}

// -- parser / codegen ---------------------------------------------------------

#[derive(Clone, Copy)]
enum SymKind {
    Uniform,
    State,
    Local,
    /// A hidden buffer/texture. `Sym::slot` is the buffer id (index into
    /// `Compiler::buffers`), not a VM slot; access is via LoadBuf/StoreBuf.
    Buffer,
}
#[derive(Clone, Copy)]
struct Sym {
    kind: SymKind,
    slot: u8,
    ty: Ty,
}

#[derive(Clone)]
struct FuncInfo {
    entry: u16,
    params: Vec<Ty>,
    ret: Ty,
}

/// A resolved access path (`base` variable + `[index]` / `.field` steps) reduced
/// to one addressable slot form. `off` folds every static struct offset and
/// constant array index; `dynamic` marks that a runtime index expression was
/// already emitted (so the `*_IDX` ops apply, addressing base + i*stride + off).
#[derive(Clone, Copy)]
struct Place {
    kind: SymKind,
    base: u8,
    off: u8,
    dynamic: bool,
    stride: u8,
    count: u8,
    ty: Ty,
    width: u8,
}

pub struct Compiler {
    lx_toks: Vec<(Tok, u32, u32)>,
    p: usize,
    // symbol tables
    syms: HashMap<String, Sym>,
    funcs: HashMap<String, FuncInfo>,
    // composite type tables (indexed by Ty::Struct / Ty::Array payloads)
    structs: Vec<StructInfo>,
    arrays: Vec<ArrayInfo>,
    buffers: Vec<BufferInfo>,
    struct_names: HashMap<String, u16>,
    cur_fn_is_entry: bool,
    uniforms: Vec<UniformInfo>,
    exports: Vec<ExportInfo>,
    n_uniform_slots: u8,
    n_state: u8,
    n_locals: u8,
    // const pool (raw 32-bit words: f32 bits, or i32/Q16.16 bit patterns)
    consts: Vec<u32>,
    // output code (per function)
    code: Vec<u8>,
    update_entry: u16,
    shade_entry: u16,
    poll_entry: u16,
}

/// Compile GLSL-ish source to `.fxb` + manifest, or a list of diagnostics.
pub fn compile(src: &str) -> Result<Compiled, Vec<Diagnostic>> {
    let mut lx = Lexer::new(src);
    let mut toks = Vec::new();
    loop {
        match lx.next() {
            Ok(t) => {
                let eof = t.0 == Tok::Eof;
                toks.push(t);
                if eof {
                    break;
                }
            }
            Err(d) => return Err(vec![d]),
        }
    }
    let mut c = Compiler {
        lx_toks: toks,
        p: 0,
        syms: HashMap::new(),
        funcs: HashMap::new(),
        structs: Vec::new(),
        arrays: Vec::new(),
        buffers: Vec::new(),
        struct_names: HashMap::new(),
        cur_fn_is_entry: false,
        uniforms: Vec::new(),
        exports: Vec::new(),
        n_uniform_slots: 0,
        n_state: 0,
        n_locals: 0,
        consts: Vec::new(),
        code: Vec::new(),
        update_entry: 0xFFFF,
        shade_entry: 0xFFFF,
        poll_entry: 0xFFFF,
    };
    match c.program() {
        Ok(()) => Ok(c.finish()),
        Err(d) => Err(vec![d]),
    }
}

const NO_ENTRY: u16 = 0xFFFF;
// Mirror the VM's slot-array sizes (fx_vm::MAX_STATE / MAX_LOCALS) so the
// compiler rejects programs that would overflow them at runtime.
const MAX_STATE: usize = 128;
const MAX_LOCALS: usize = 128;

impl Compiler {
    fn err<T>(&self, msg: impl Into<String>) -> Result<T, Diagnostic> {
        let (_, line, col) = &self.lx_toks[self.p.min(self.lx_toks.len() - 1)];
        Err(Diagnostic {
            line: *line,
            col: *col,
            msg: msg.into(),
        })
    }
    fn cur(&self) -> &Tok {
        &self.lx_toks[self.p].0
    }
    fn advance(&mut self) -> Tok {
        let t = self.lx_toks[self.p].0.clone();
        if self.p + 1 < self.lx_toks.len() {
            self.p += 1;
        }
        t
    }
    fn eat_sym(&mut self, ch: char) -> Result<(), Diagnostic> {
        if *self.cur() == Tok::Sym(ch) {
            self.advance();
            Ok(())
        } else {
            self.err(format!("expected '{ch}'"))
        }
    }
    fn eat_ident(&mut self) -> Result<String, Diagnostic> {
        if let Tok::Ident(s) = self.cur().clone() {
            self.advance();
            Ok(s)
        } else {
            self.err("expected identifier")
        }
    }
    fn const_word(&mut self, w: u32) -> u16 {
        for (i, c) in self.consts.iter().enumerate() {
            if *c == w {
                return i as u16;
            }
        }
        self.consts.push(w);
        (self.consts.len() - 1) as u16
    }
    fn push_const(&mut self, w: u32) {
        let idx = self.const_word(w);
        self.emit(fx_vm_op::PUSH_CONST);
        self.emit_u16(idx);
    }
    fn emit(&mut self, b: u8) {
        self.code.push(b);
    }
    fn emit_u16(&mut self, v: u16) {
        self.code.extend_from_slice(&v.to_le_bytes());
    }

    fn ty_from_ident(s: &str) -> Option<Ty> {
        Some(match s {
            "float" => Ty::Float,
            "vec2" => Ty::Vec2,
            "vec3" => Ty::Vec3,
            "vec4" => Ty::Vec4,
            "int" => Ty::Int,
            "fixed" => Ty::Fixed,
            "fixed8" => Ty::Fixed8,
            "fixed16" => Ty::Fixed16,
            "bool" => Ty::Bool,
            "void" => Ty::Void,
            _ => return None,
        })
    }

    /// Resolve a type name to a [`Ty`]: a primitive, or a user `struct` declared
    /// earlier in the program.
    fn resolve_ty(&self, s: &str) -> Option<Ty> {
        Self::ty_from_ident(s).or_else(|| self.struct_names.get(s).map(|&i| Ty::Struct(i)))
    }

    /// Slot width of any type, including composites (the authoritative width —
    /// see [`Ty::width`], which only knows primitives).
    fn ty_width(&self, ty: Ty) -> u8 {
        match ty {
            Ty::Struct(i) => self.structs[i as usize].width,
            Ty::Array(i) => {
                let a = self.arrays[i as usize];
                a.elem_w.saturating_mul(a.count)
            }
            other => other.width(),
        }
    }

    /// Register (or reuse) a fixed-size array type `elem[count]`.
    fn make_array(&mut self, elem: Ty, count: u32) -> Result<Ty, Diagnostic> {
        if count == 0 || count > 255 {
            return self.err("array length must be 1..255");
        }
        let elem_w = self.ty_width(elem);
        if elem_w == 0 {
            return self.err("cannot make an array of this type");
        }
        if elem_w as u32 * count > 255 {
            return self.err("array is too large (over 255 slots)");
        }
        // Dedup identical array types so `T[N]` used twice is one entry.
        for (i, a) in self.arrays.iter().enumerate() {
            if a.elem == elem && a.count == count as u8 {
                return Ok(Ty::Array(i as u16));
            }
        }
        let idx = self.arrays.len() as u16;
        self.arrays.push(ArrayInfo { elem, elem_w, count: count as u8 });
        Ok(Ty::Array(idx))
    }

    /// Allocate `w` contiguous `state` slots, erroring if that overflows the VM's
    /// state array (MAX_STATE).
    fn alloc_state(&mut self, w: u8) -> Result<u8, Diagnostic> {
        let slot = self.n_state;
        let end = slot as usize + w as usize;
        if end > MAX_STATE {
            return self.err("too many state variables (over the state slot budget)");
        }
        self.n_state = end as u8;
        Ok(slot)
    }

    /// Allocate `w` contiguous `local` slots, erroring on overflow (MAX_LOCALS).
    fn alloc_local(&mut self, w: u8) -> Result<u8, Diagnostic> {
        let slot = self.n_locals;
        let end = slot as usize + w as usize;
        if end > MAX_LOCALS {
            return self.err("too many locals (over the local slot budget)");
        }
        self.n_locals = end as u8;
        Ok(slot)
    }

    fn program(&mut self) -> Result<(), Diagnostic> {
        loop {
            match self.cur().clone() {
                Tok::Eof => break,
                Tok::Ident(kw) if kw == "uniform" => self.uniform_decl()?,
                Tok::Ident(kw) if kw == "state" => self.state_decl()?,
                Tok::Ident(kw) if kw == "export" => self.export_decl()?,
                Tok::Ident(kw) if kw == "buffer" => self.buffer_decl()?,
                Tok::Ident(kw) if kw == "texture" => self.texture_decl()?,
                Tok::Ident(kw) if kw == "struct" => self.struct_decl()?,
                Tok::Ident(kw) if Self::ty_from_ident(&kw).is_some() => self.func_decl()?,
                other => return self.err(format!("unexpected token {other:?}")),
            }
        }
        // A program is either an EFFECT (defines `shade`) or a sensor DRIVER
        // (defines `poll`, FUG-107) — never both. Exports only make sense on a
        // driver; a plain effect that lists them almost certainly forgot poll().
        let is_driver = self.poll_entry != NO_ENTRY;
        if is_driver && self.shade_entry != NO_ENTRY {
            return self.err("a program is either an effect (shade) or a driver (poll), not both");
        }
        if !is_driver && !self.exports.is_empty() {
            return self.err("`export` is only valid in a sensor driver — define `void poll()`");
        }
        if !is_driver && self.shade_entry == NO_ENTRY {
            return self.err("program must define `vec3 shade(Led led)` or `void poll()`");
        }
        Ok(())
    }

    // export float temperature "°C";   export vec3 mag;   (a sensor reading a
    // driver's poll() writes; the firmware bridges it to a same-named uniform).
    // Backed by a state slot (scalars/vectors only, no arrays/structs).
    fn export_decl(&mut self) -> Result<(), Diagnostic> {
        self.advance(); // 'export'
        let tyname = self.eat_ident()?;
        let ty = Self::ty_from_ident(&tyname).ok_or_else(|| self.mkdiag("unknown type"))?;
        if !ty.is_scalar() && !matches!(ty, Ty::Vec2 | Ty::Vec3 | Ty::Vec4) {
            return self.err("export must be a scalar or vecN");
        }
        let name = self.eat_ident()?;
        let mut unit = String::new();
        if let Tok::Str(s) = self.cur().clone() {
            self.advance();
            unit = s;
        }
        self.expect_sym(';')?;
        let w = ty.width();
        let slot = self.alloc_state(w)?;
        self.syms.insert(name.clone(), Sym { kind: SymKind::State, slot, ty });
        self.exports.push(ExportInfo { name, ty, slot, unit });
        Ok(())
    }

    // uniform float speed : 0..5 = 1.0;   uniform vec3 tint : color = vec3(..);
    // uniform bool x = false;   uniform int mode : {"a","b"} = 0;
    fn uniform_decl(&mut self) -> Result<(), Diagnostic> {
        self.advance(); // 'uniform'
        let tyname = self.eat_ident()?;
        let ty = Self::ty_from_ident(&tyname).ok_or_else(|| self.mkdiag("unknown type"))?;
        let name = self.eat_ident()?;
        let mut ui = default_ui(ty);
        if *self.cur() == Tok::Sym(':') {
            self.advance();
            ui = self.parse_ui_annotation(ty)?;
        }
        // default
        self.expect_sym('=')?;
        let default = self.parse_uniform_default(ty)?;
        self.expect_sym(';')?;
        let slot = self.n_uniform_slots;
        self.n_uniform_slots += ty.width();
        self.syms.insert(
            name.clone(),
            Sym { kind: SymKind::Uniform, slot, ty },
        );
        self.uniforms.push(UniformInfo { name, ty, slot, ui, default });
        Ok(())
    }

    fn parse_ui_annotation(&mut self, ty: Ty) -> Result<UiKind, Diagnostic> {
        match self.cur().clone() {
            Tok::Ident(k) if k == "color" => {
                self.advance();
                Ok(UiKind::Color)
            }
            Tok::Sym('{') => {
                self.advance();
                let mut opts = Vec::new();
                loop {
                    if let Tok::Str(s) = self.cur().clone() {
                        self.advance();
                        opts.push(s);
                    } else {
                        return self.err("expected \"option\"");
                    }
                    if *self.cur() == Tok::Sym(',') {
                        self.advance();
                    } else {
                        break;
                    }
                }
                self.expect_sym('}')?;
                Ok(UiKind::Dropdown(opts))
            }
            Tok::Num(lo, _) => {
                self.advance();
                if *self.cur() != Tok::Range {
                    return self.err("expected '..' in range");
                }
                self.advance();
                let hi = match self.cur().clone() {
                    Tok::Num(v, _) => {
                        self.advance();
                        v
                    }
                    _ => return self.err("expected range max"),
                };
                let step = (hi - lo) / 100.0;
                Ok(UiKind::Slider { min: lo, max: hi, step })
            }
            _ => Ok(default_ui(ty)),
        }
    }

    fn parse_uniform_default(&mut self, ty: Ty) -> Result<Vec<f32>, Diagnostic> {
        match self.cur().clone() {
            Tok::Ident(b) if b == "true" || b == "false" => {
                self.advance();
                Ok(vec![if b == "true" { 1.0 } else { 0.0 }])
            }
            Tok::Num(v, _) => {
                self.advance();
                // A bare number. For a vecN uniform, also accept a comma-list
                // (`= 0.2, 0.6, 1.0`) or broadcast a lone scalar (`= 0.5`), so
                // `uniform vec3 tint : color = 0.2, 0.6, 1.0;` works without the
                // `vec3(...)` wrapper (natural for colors).
                let mut vals = vec![v];
                if ty.width() > 1 {
                    while *self.cur() == Tok::Sym(',') {
                        self.advance();
                        match self.cur().clone() {
                            Tok::Num(x, _) => {
                                self.advance();
                                vals.push(x);
                            }
                            Tok::Sym('-') => {
                                self.advance();
                                if let Tok::Num(x, _) = self.cur().clone() {
                                    self.advance();
                                    vals.push(-x);
                                } else {
                                    return self.err("expected number in default");
                                }
                            }
                            _ => return self.err("expected number in default"),
                        }
                    }
                    if vals.len() == 1 {
                        return Ok(vec![vals[0]; ty.width() as usize]);
                    }
                }
                Ok(vals)
            }
            Tok::Ident(ctor) if Self::ty_from_ident(&ctor).is_some() => {
                // vecN(a,b,c)
                self.advance();
                self.expect_sym('(')?;
                let mut vals = Vec::new();
                loop {
                    match self.cur().clone() {
                        Tok::Num(v, _) => {
                            self.advance();
                            vals.push(v);
                        }
                        Tok::Sym('-') => {
                            self.advance();
                            if let Tok::Num(v, _) = self.cur().clone() {
                                self.advance();
                                vals.push(-v);
                            } else {
                                return self.err("expected number");
                            }
                        }
                        _ => return self.err("expected number in default"),
                    }
                    if *self.cur() == Tok::Sym(',') {
                        self.advance();
                    } else {
                        break;
                    }
                }
                self.expect_sym(')')?;
                if vals.len() == 1 {
                    Ok(vec![vals[0]; ty.width() as usize])
                } else {
                    Ok(vals)
                }
            }
            _ => self.err("expected default value"),
        }
    }

    // struct Agent { float pos; vec3 col; };  (fields: scalar/vec/nested struct)
    fn struct_decl(&mut self) -> Result<(), Diagnostic> {
        self.advance(); // 'struct'
        let name = self.eat_ident()?;
        if self.struct_names.contains_key(&name) || Self::ty_from_ident(&name).is_some() {
            return self.err("duplicate type name");
        }
        self.expect_sym('{')?;
        let mut fields: Vec<StructField> = Vec::new();
        let mut off: u8 = 0;
        while *self.cur() != Tok::Sym('}') && *self.cur() != Tok::Eof {
            let ftyname = self.eat_ident()?;
            let fty = self
                .resolve_ty(&ftyname)
                .ok_or_else(|| self.mkdiag("unknown field type"))?;
            // Arrays inside structs would need a second dynamic index in access
            // paths (agents[i].trail[j]); out of scope for now.
            if matches!(fty, Ty::Array(_)) {
                return self.err("array fields in structs are not supported yet");
            }
            if matches!(fty, Ty::Void) {
                return self.err("a struct field cannot be void");
            }
            let fname = self.eat_ident()?;
            if fields.iter().any(|f| f.name == fname) {
                return self.err("duplicate struct field");
            }
            self.expect_sym(';')?;
            let w = self.ty_width(fty);
            fields.push(StructField { name: fname, ty: fty, offset: off });
            off = off
                .checked_add(w)
                .ok_or_else(|| self.mkdiag("struct is too large (over 255 slots)"))?;
        }
        self.expect_sym('}')?;
        if *self.cur() == Tok::Sym(';') {
            self.advance(); // optional trailing ';'
        }
        if fields.is_empty() {
            return self.err("a struct must have at least one field");
        }
        let idx = self.structs.len() as u16;
        self.structs.push(StructInfo { name: name.clone(), fields, width: off });
        self.struct_names.insert(name, idx);
        Ok(())
    }

    // state float phase;   state Agent agents[16];   (arrays allowed here)
    fn state_decl(&mut self) -> Result<(), Diagnostic> {
        self.advance(); // 'state'
        let tyname = self.eat_ident()?;
        let base_ty = self
            .resolve_ty(&tyname)
            .ok_or_else(|| self.mkdiag("unknown type"))?;
        let name = self.eat_ident()?;
        let ty = self.maybe_array_suffix(base_ty)?;
        self.expect_sym(';')?;
        let w = self.ty_width(ty);
        let slot = self.alloc_state(w)?;
        self.syms.insert(name, Sym { kind: SymKind::State, slot, ty });
        Ok(())
    }

    /// Resolve a buffer/texture element type name to its on-stack element type,
    /// component count, and default packed storage precision (FUG-10). Narrow
    /// element types (`fixed8`/`fixed16`) read back as those first-class types;
    /// `int8`/`int16` are storage specifiers that read back as `int`. `None` if
    /// the name isn't a valid element type.
    fn buffer_elem(name: &str) -> Option<(Ty, u8, u8)> {
        Some(match name {
            "float" => (Ty::Float, 1, comp::F32),
            "vec2" => (Ty::Vec2, 2, comp::F32),
            "vec3" => (Ty::Vec3, 3, comp::F32),
            "vec4" => (Ty::Vec4, 4, comp::F32),
            "int" => (Ty::Int, 1, comp::I32),
            "fixed" => (Ty::Fixed, 1, comp::I32), // Q16.16 rides in the i32 word
            "fixed16" => (Ty::Fixed16, 1, comp::FIX16),
            "fixed8" => (Ty::Fixed8, 1, comp::FIX8),
            "int16" => (Ty::Int, 1, comp::I16), // narrow storage, int on the stack
            "int8" => (Ty::Int, 1, comp::I8),
            _ => return None,
        })
    }

    /// Parse an optional `: fixed8` / `: fixed16` storage annotation that
    /// compresses a float/vec buffer element (default `comp` is `F32`). Only
    /// valid on a float/vec element — a narrow element type already fixes its
    /// storage. Returns the (possibly overridden) component precision.
    fn buffer_storage_annotation(&mut self, elem_ty: Ty, default_comp: u8) -> Result<u8, Diagnostic> {
        if *self.cur() != Tok::Sym(':') {
            return Ok(default_comp);
        }
        self.advance(); // ':'
        let ann = self.eat_ident()?;
        if !matches!(elem_ty, Ty::Float | Ty::Vec2 | Ty::Vec3 | Ty::Vec4) {
            return self.err("a storage annotation only applies to a float/vec element");
        }
        match ann.as_str() {
            "fixed16" => Ok(comp::FIX16F),
            "fixed8" => Ok(comp::FIX8F),
            _ => self.err("storage annotation must be `fixed8` or `fixed16`"),
        }
    }

    // buffer vec3 trail;   — a hidden LED-arity buffer (one `elem` per LED,
    // persisted across frames in the VM arena; sized to led_count at run time).
    // Element is a scalar/vec, optionally narrow (`buffer fixed8 t;`) or
    // compressed (`buffer vec3 c : fixed8;` packs vec3 to 3 bytes/LED). Access is
    // `trail[i]` (read) and `trail[i] = v;` (write), i an int LED index.
    fn buffer_decl(&mut self) -> Result<(), Diagnostic> {
        self.advance(); // 'buffer'
        let tyname = self.eat_ident()?;
        let (elem_ty, elem, comp0) =
            Self::buffer_elem(&tyname).ok_or_else(|| self.mkdiag("buffer element must be numeric: float/int/fixed/fixed8/fixed16/int8/int16/vec2/vec3/vec4"))?;
        let name = self.eat_ident()?;
        let comp = self.buffer_storage_annotation(elem_ty, comp0)?;
        self.expect_sym(';')?;
        if self.buffers.len() >= 255 {
            return self.err("too many buffers (max 255)");
        }
        let id = self.buffers.len() as u8;
        self.buffers.push(BufferInfo { kind: 0, elem, comp, w: 0, h: 0 });
        self.syms.insert(name, Sym { kind: SymKind::Buffer, slot: id, ty: elem_ty });
        Ok(())
    }

    // texture vec3 img(64, 64);  — a hidden WxH 2D texture (kind 1). Read via
    // sample(img, uv) (bilinear, always float) or flat img[i]; write via
    // paint(img, uv, c) or flat img[i] = c. Element may be narrow/compressed like
    // a buffer (`texture vec3 img(64,64) : fixed8;` quarters the texture RAM).
    fn texture_decl(&mut self) -> Result<(), Diagnostic> {
        self.advance(); // 'texture'
        let tyname = self.eat_ident()?;
        let (elem_ty, elem, comp0) =
            Self::buffer_elem(&tyname).ok_or_else(|| self.mkdiag("texture element must be numeric: float/int/fixed/fixed8/fixed16/int8/int16/vec2/vec3/vec4"))?;
        let name = self.eat_ident()?;
        self.expect_sym('(')?;
        let w = self.eat_uint("texture width")?;
        self.expect_sym(',')?;
        let h = self.eat_uint("texture height")?;
        self.expect_sym(')')?;
        let comp = self.buffer_storage_annotation(elem_ty, comp0)?;
        self.expect_sym(';')?;
        if w == 0 || w > 1024 || h == 0 || h > 1024 {
            return self.err("texture dimensions must be 1..1024");
        }
        if self.buffers.len() >= 255 {
            return self.err("too many buffers/textures (max 255)");
        }
        let id = self.buffers.len() as u8;
        self.buffers.push(BufferInfo { kind: 1, elem, comp, w: w as u16, h: h as u16 });
        self.syms.insert(name, Sym { kind: SymKind::Buffer, slot: id, ty: elem_ty });
        Ok(())
    }

    /// Eat a non-negative integer literal (for texture dimensions).
    fn eat_uint(&mut self, what: &str) -> Result<u32, Diagnostic> {
        match *self.cur() {
            Tok::Num(v, true) if v >= 0.0 => {
                self.advance();
                Ok(v as u32)
            }
            _ => self.err(format!("{what} must be a non-negative integer literal")),
        }
    }

    /// If the next token is `[`, parse `[N]` and wrap `base` in an array type;
    /// otherwise return `base` unchanged.
    fn maybe_array_suffix(&mut self, base: Ty) -> Result<Ty, Diagnostic> {
        if *self.cur() != Tok::Sym('[') {
            return Ok(base);
        }
        self.advance(); // '['
        let n = match *self.cur() {
            Tok::Num(v, true) => {
                self.advance();
                v as u32
            }
            _ => return self.err("array length must be an integer literal"),
        };
        self.expect_sym(']')?;
        self.make_array(base, n)
    }

    fn func_decl(&mut self) -> Result<(), Diagnostic> {
        let ret_ty = Self::ty_from_ident(&self.eat_ident()?).unwrap();
        let name = self.eat_ident()?;
        self.expect_sym('(')?;
        // params: `type name, ...`; the special `Led led` (shade) is the ctx
        // namespace, not a real local.
        let mut param_tys: Vec<Ty> = Vec::new();
        let mut param_syms: Vec<(String, u8, Ty)> = Vec::new();
        if *self.cur() != Tok::Sym(')') {
            loop {
                let pty_name = self.eat_ident()?;
                if pty_name == "Led" {
                    let _ = self.eat_ident()?; // `led`
                } else {
                    let pty = Self::ty_from_ident(&pty_name)
                        .ok_or_else(|| self.mkdiag("unknown parameter type"))?;
                    let pname = self.eat_ident()?;
                    let slot = self.n_locals;
                    self.n_locals += pty.width();
                    param_tys.push(pty);
                    param_syms.push((pname, slot, pty));
                }
                if *self.cur() == Tok::Sym(',') {
                    self.advance();
                } else {
                    break;
                }
            }
        }
        self.expect_sym(')')?;
        let is_entry = name == "update" || name == "shade" || name == "poll";
        let entry = self.code.len() as u16;
        if !is_entry {
            self.funcs.insert(
                name.clone(),
                FuncInfo { entry, params: param_tys, ret: ret_ty },
            );
        }
        for (pname, slot, pty) in &param_syms {
            self.syms
                .insert(pname.clone(), Sym { kind: SymKind::Local, slot: *slot, ty: *pty });
        }
        // args are pushed left→right (last on top), so store params in reverse.
        for (_, slot, pty) in param_syms.iter().rev() {
            self.emit(fx_vm_op::STORE_LOCAL);
            self.emit(*slot);
            self.emit(pty.width());
        }
        self.expect_sym('{')?;
        let want = if is_entry {
            if name == "shade" {
                Ty::Vec3
            } else {
                Ty::Void // update() and poll()
            }
        } else {
            ret_ty
        };
        self.cur_fn_is_entry = is_entry;
        self.block(want)?;
        if is_entry {
            self.emit(fx_vm_op::RET);
            self.emit(want.width());
        } else {
            self.emit(fx_vm_op::RET_FN);
        }
        self.expect_sym('}')?;
        // Scope out this function's locals, but DON'T reuse the slots — disjoint
        // ranges so a callee can't clobber a caller's locals (no recursion).
        self.syms.retain(|_, s| !matches!(s.kind, SymKind::Local));
        match name.as_str() {
            "update" => self.update_entry = entry,
            "shade" => self.shade_entry = entry,
            "poll" => self.poll_entry = entry,
            _ => {}
        }
        Ok(())
    }

    fn block(&mut self, ret: Ty) -> Result<(), Diagnostic> {
        while *self.cur() != Tok::Sym('}') && *self.cur() != Tok::Eof {
            self.stmt(ret)?;
        }
        Ok(())
    }

    fn stmt(&mut self, ret: Ty) -> Result<(), Diagnostic> {
        match self.cur().clone() {
            Tok::Ident(kw) if kw == "return" => {
                self.advance();
                if *self.cur() == Tok::Sym(';') {
                    self.advance();
                    if self.cur_fn_is_entry {
                        self.emit(fx_vm_op::RET);
                        self.emit(0);
                    } else {
                        self.emit(fx_vm_op::RET_FN);
                    }
                } else {
                    let t = self.expr()?;
                    self.coerce(t, ret)?;
                    self.expect_sym(';')?;
                    if self.cur_fn_is_entry {
                        self.emit(fx_vm_op::RET);
                        self.emit(ret.width());
                    } else {
                        self.emit(fx_vm_op::RET_FN);
                    }
                }
                Ok(())
            }
            Tok::Ident(kw) if kw == "if" => self.if_stmt(ret),
            Tok::Ident(kw) if kw == "for" => self.for_stmt(ret),
            Tok::Ident(tyname) if self.resolve_ty(&tyname).is_some() => {
                // local decl: `float d = expr;`, `Agent a;`, `Agent tmp[8];`
                self.advance();
                let base_ty = self.resolve_ty(&tyname).unwrap();
                let name = self.eat_ident()?;
                self.local_decl(base_ty, name)
            }
            Tok::Ident(name) => {
                self.advance();
                // A call-statement (e.g. `paint(tex, uv, c);`) — only void
                // results may be discarded; a value result must be assigned.
                if *self.cur() == Tok::Sym('(') {
                    let ty = self.call(&name)?;
                    self.expect_sym(';')?;
                    if ty != Ty::Void {
                        return self.err(format!("result of {name}() is unused — assign it"));
                    }
                    return Ok(());
                }
                self.assign_stmt(name)
            }
            _ => self.err("expected statement"),
        }
    }

    /// A local variable declaration, `base_ty` + `name` already consumed. Handles
    /// scalar/vec `= expr` initializers, zero-initialized `struct`/array locals,
    /// and array suffixes. Locals start zeroed (the VM clears them at entry), so
    /// composite decls emit no init code.
    fn local_decl(&mut self, base_ty: Ty, name: String) -> Result<(), Diagnostic> {
        // Array: `T name[N];`
        if *self.cur() == Tok::Sym('[') {
            let ty = self.maybe_array_suffix(base_ty)?;
            self.expect_sym(';')?;
            let w = self.ty_width(ty);
            let slot = self.alloc_local(w)?;
            self.syms.insert(name, Sym { kind: SymKind::Local, slot, ty });
            return Ok(());
        }
        // Struct with no initializer: `Agent a;`
        if matches!(base_ty, Ty::Struct(_)) && *self.cur() == Tok::Sym(';') {
            self.advance();
            let w = self.ty_width(base_ty);
            let slot = self.alloc_local(w)?;
            self.syms.insert(name, Sym { kind: SymKind::Local, slot, ty: base_ty });
            return Ok(());
        }
        // Initialized: `T name = expr;`
        self.expect_sym('=')?;
        let et = self.expr()?;
        self.coerce(et, base_ty)?;
        self.expect_sym(';')?;
        let w = self.ty_width(base_ty);
        let slot = self.alloc_local(w)?;
        self.syms.insert(name, Sym { kind: SymKind::Local, slot, ty: base_ty });
        self.emit(fx_vm_op::STORE_LOCAL);
        self.emit(slot);
        self.emit(w);
        Ok(())
    }

    /// An assignment, the target `name` already consumed. Simple whole-variable
    /// assignment (`x = expr;`, including whole-struct/array copy) or an indexed /
    /// struct-field place (`agents[i].pos = expr;`).
    fn assign_stmt(&mut self, name: String) -> Result<(), Diagnostic> {
        let sym = *self.syms.get(&name).ok_or_else(|| self.mkdiag("unknown identifier"))?;
        // Buffer element store: `buf[i] = v;` -> LoadBuf/StoreBuf, not a slot place.
        if matches!(sym.kind, SymKind::Buffer) {
            return self.buffer_index_store(sym);
        }
        // Indexed / struct-field target -> place store (may emit a dynamic index
        // BEFORE the RHS, which the *_IDX store then finds beneath the value).
        if *self.cur() == Tok::Sym('[')
            || (matches!(sym.ty, Ty::Struct(_)) && *self.cur() == Tok::Sym('.'))
        {
            let place = self.parse_access(sym)?;
            if *self.cur() == Tok::Sym('.') {
                return self.err("cannot assign to a vector component");
            }
            self.expect_sym('=')?;
            let et = self.expr()?;
            self.coerce(et, place.ty)?;
            self.expect_sym(';')?;
            return self.emit_store_place(&place);
        }
        // Whole-variable assignment.
        self.expect_sym('=')?;
        let et = self.expr()?;
        self.coerce(et, sym.ty)?;
        self.expect_sym(';')?;
        let opc = match sym.kind {
            SymKind::State => fx_vm_op::STORE_STATE,
            SymKind::Local => fx_vm_op::STORE_LOCAL,
            SymKind::Uniform => return self.err("cannot assign to a uniform"),
            SymKind::Buffer => return self.err("cannot assign to a buffer; use buf[i] = ..."),
        };
        let w = self.ty_width(sym.ty);
        self.emit(opc);
        self.emit(sym.slot);
        self.emit(w);
        Ok(())
    }

    /// `buf[i]` read: emit the (int) index, then LoadBuf(id); the result is one
    /// element (the buffer's elem type) on the stack.
    fn buffer_index_load(&mut self, sym: Sym) -> Result<Ty, Diagnostic> {
        self.expect_sym('[')?;
        let it = self.expr()?;
        if !it.is_scalar() {
            return self.err("buffer index must be a scalar");
        }
        self.coerce(it, Ty::Int)?;
        self.expect_sym(']')?;
        self.emit(fx_vm_op::LOAD_BUF);
        self.emit(sym.slot); // buffer id
        Ok(sym.ty)
    }

    /// `buf[i] = v;` write: index first, then the value slots, then StoreBuf(id)
    /// — matching the VM's expectation of `[index, v0..v_elem]` beneath the op.
    fn buffer_index_store(&mut self, sym: Sym) -> Result<(), Diagnostic> {
        self.expect_sym('[')?;
        let it = self.expr()?;
        if !it.is_scalar() {
            return self.err("buffer index must be a scalar");
        }
        self.coerce(it, Ty::Int)?;
        self.expect_sym(']')?;
        self.expect_sym('=')?;
        let et = self.expr()?;
        self.coerce(et, sym.ty)?;
        self.expect_sym(';')?;
        self.emit(fx_vm_op::STORE_BUF);
        self.emit(sym.slot); // buffer id
        Ok(())
    }

    fn if_stmt(&mut self, ret: Ty) -> Result<(), Diagnostic> {
        self.advance(); // if
        self.expect_sym('(')?;
        let ct = self.expr()?;
        if ct != Ty::Bool {
            return self.err("if condition must be bool");
        }
        self.expect_sym(')')?;
        self.emit(fx_vm_op::BR_FALSE);
        let patch_else = self.code.len();
        self.emit_u16(0); // placeholder rel
        self.expect_sym('{')?;
        self.block(ret)?;
        self.expect_sym('}')?;
        let has_else = matches!(self.cur().clone(), Tok::Ident(k) if k == "else");
        if has_else {
            self.emit(fx_vm_op::JMP);
            let patch_end = self.code.len();
            self.emit_u16(0);
            // patch else target = here
            let rel = (self.code.len() as isize - (patch_else + 2) as isize) as i16;
            self.code[patch_else..patch_else + 2].copy_from_slice(&rel.to_le_bytes());
            self.advance(); // else
            self.expect_sym('{')?;
            self.block(ret)?;
            self.expect_sym('}')?;
            let rel_end = (self.code.len() as isize - (patch_end + 2) as isize) as i16;
            self.code[patch_end..patch_end + 2].copy_from_slice(&rel_end.to_le_bytes());
        } else {
            let rel = (self.code.len() as isize - (patch_else + 2) as isize) as i16;
            self.code[patch_else..patch_else + 2].copy_from_slice(&rel.to_le_bytes());
        }
        Ok(())
    }

    // for (init; cond; update) { body }. The instruction budget in the VM is
    // the hard bound on total iterations (no unbounded frame time).
    fn for_stmt(&mut self, ret: Ty) -> Result<(), Diagnostic> {
        use fx_vm_op::*;
        self.advance(); // 'for'
        self.expect_sym('(')?;
        self.stmt(ret)?; // init (declares loop-local, consumes ';')
        let loop_top = self.code.len();
        let ct = self.expr()?;
        if ct != Ty::Bool {
            return self.err("for condition must be bool");
        }
        self.expect_sym(';')?;
        self.emit(BR_FALSE);
        let patch_end = self.code.len();
        self.emit_u16(0);
        // The update runs AFTER the body but is written before it — skip its
        // tokens now, emit the body, then rewind and emit the update.
        let update_start = self.p;
        let mut depth = 0i32;
        while !(depth == 0 && *self.cur() == Tok::Sym(')')) && *self.cur() != Tok::Eof {
            match self.cur() {
                Tok::Sym('(') => depth += 1,
                Tok::Sym(')') => depth -= 1,
                _ => {}
            }
            self.advance();
        }
        self.expect_sym(')')?;
        self.expect_sym('{')?;
        self.block(ret)?;
        self.expect_sym('}')?;
        let after = self.p;
        self.p = update_start;
        self.assign_no_semi()?;
        self.p = after;
        self.emit(JMP);
        let rel = (loop_top as isize - (self.code.len() + 2) as isize) as i16;
        self.emit_u16(rel as u16);
        let rel_end = (self.code.len() as isize - (patch_end + 2) as isize) as i16;
        self.code[patch_end..patch_end + 2].copy_from_slice(&rel_end.to_le_bytes());
        Ok(())
    }

    fn assign_no_semi(&mut self) -> Result<(), Diagnostic> {
        let name = self.eat_ident()?;
        let sym = *self
            .syms
            .get(&name)
            .ok_or_else(|| self.mkdiag(&format!("unknown identifier '{name}'")))?;
        self.expect_sym('=')?;
        let et = self.expr()?;
        self.coerce(et, sym.ty)?;
        let opc = match sym.kind {
            SymKind::State => fx_vm_op::STORE_STATE,
            SymKind::Local => fx_vm_op::STORE_LOCAL,
            SymKind::Uniform => return self.err("cannot assign to a uniform"),
            SymKind::Buffer => return self.err("cannot assign a buffer in a for-update"),
        };
        self.emit(opc);
        self.emit(sym.slot);
        self.emit(self.ty_width(sym.ty));
        Ok(())
    }

    // -- array/struct access paths --------------------------------------------

    /// Resolve an access path starting at `sym`, consuming `[index]` and `.field`
    /// postfixes while the current type is composite. Constant indices and struct
    /// offsets fold into `off`; the first non-constant index is EMITTED here (so
    /// it lands on the stack) and recorded as the place's dynamic term. Stops when
    /// the type becomes a scalar/vec (a trailing `.xyz` is then a swizzle the
    /// caller handles). Errors on a second dynamic index (one per access).
    fn parse_access(&mut self, sym: Sym) -> Result<Place, Diagnostic> {
        let mut p = Place {
            kind: sym.kind,
            base: sym.slot,
            off: 0,
            dynamic: false,
            stride: 0,
            count: 0,
            ty: sym.ty,
            width: self.ty_width(sym.ty),
        };
        loop {
            match self.cur().clone() {
                Tok::Sym('[') => {
                    let ai = match p.ty {
                        Ty::Array(i) => i,
                        _ => return self.err("cannot index a non-array"),
                    };
                    let info = self.arrays[ai as usize]; // Copy
                    self.advance(); // '['
                    if let Tok::Num(v, true) = self.cur().clone() {
                        // constant index -> fold into the static offset
                        self.advance();
                        self.expect_sym(']')?;
                        let ix = v as i64;
                        if ix < 0 || ix >= info.count as i64 {
                            return self.err("array index out of range");
                        }
                        let add = (ix as u8).wrapping_mul(info.elem_w);
                        p.off = p
                            .off
                            .checked_add(add)
                            .ok_or_else(|| self.mkdiag("access offset overflow"))?;
                    } else {
                        // dynamic index -> emit it (coerced to int), record stride
                        if p.dynamic {
                            return self.err("only one dynamic index per access");
                        }
                        let it = self.expr()?;
                        if !it.is_scalar() {
                            return self.err("array index must be a scalar");
                        }
                        self.coerce(it, Ty::Int)?;
                        self.expect_sym(']')?;
                        p.dynamic = true;
                        p.stride = info.elem_w;
                        p.count = info.count;
                    }
                    p.ty = info.elem;
                    p.width = info.elem_w;
                }
                Tok::Sym('.') => {
                    let si = match p.ty {
                        Ty::Struct(i) => i,
                        _ => break, // scalar/vec: a trailing swizzle for the caller
                    };
                    self.advance(); // '.'
                    let field = self.eat_ident()?;
                    let found = self.structs[si as usize]
                        .fields
                        .iter()
                        .find(|f| f.name == field)
                        .map(|f| (f.ty, f.offset));
                    let (fty, foff) = match found {
                        Some(x) => x,
                        None => return self.err(format!("no field .{field}")),
                    };
                    p.off = p
                        .off
                        .checked_add(foff)
                        .ok_or_else(|| self.mkdiag("access offset overflow"))?;
                    p.ty = fty;
                    p.width = self.ty_width(fty);
                }
                _ => break,
            }
        }
        Ok(p)
    }

    /// Emit a load of `p`'s slots onto the stack (the dynamic index, if any, is
    /// already on the stack from [`parse_access`]).
    fn emit_load_place(&mut self, p: &Place) -> Result<(), Diagnostic> {
        use fx_vm_op::*;
        if p.dynamic {
            let opc = match p.kind {
                SymKind::State => LOAD_STATE_IDX,
                SymKind::Local => LOAD_LOCAL_IDX,
                SymKind::Uniform => return self.err("indexed uniforms are not supported"),
                SymKind::Buffer => return self.err("internal: buffers use LoadBuf, not a place"),
            };
            self.emit(opc);
            self.emit(p.base);
            self.emit(p.stride);
            self.emit(p.off);
            self.emit(p.width);
            self.emit(p.count);
        } else {
            let opc = match p.kind {
                SymKind::Uniform => LOAD_UNIFORM,
                SymKind::State => LOAD_STATE,
                SymKind::Local => LOAD_LOCAL,
                SymKind::Buffer => return self.err("internal: buffers use LoadBuf, not a place"),
            };
            let slot = p
                .base
                .checked_add(p.off)
                .ok_or_else(|| self.mkdiag("access offset overflow"))?;
            self.emit(opc);
            self.emit(slot);
            self.emit(p.width);
        }
        Ok(())
    }

    /// Emit a store into `p`. For a dynamic place the value's `width` slots are on
    /// top of the stack with the index just beneath them (the *_IDX store pops the
    /// values then the index).
    fn emit_store_place(&mut self, p: &Place) -> Result<(), Diagnostic> {
        use fx_vm_op::*;
        if matches!(p.kind, SymKind::Uniform) {
            return self.err("cannot assign to a uniform");
        }
        if p.dynamic {
            let opc = if matches!(p.kind, SymKind::State) {
                STORE_STATE_IDX
            } else {
                STORE_LOCAL_IDX
            };
            self.emit(opc);
            self.emit(p.base);
            self.emit(p.stride);
            self.emit(p.off);
            self.emit(p.width);
            self.emit(p.count);
        } else {
            let opc = if matches!(p.kind, SymKind::State) {
                STORE_STATE
            } else {
                STORE_LOCAL
            };
            let slot = p
                .base
                .checked_add(p.off)
                .ok_or_else(|| self.mkdiag("access offset overflow"))?;
            self.emit(opc);
            self.emit(slot);
            self.emit(p.width);
        }
        Ok(())
    }

    // -- expressions (Pratt-ish precedence climbing) --------------------------

    fn expr(&mut self) -> Result<Ty, Diagnostic> {
        self.expr_bp(0)
    }

    fn expr_bp(&mut self, min_bp: u8) -> Result<Ty, Diagnostic> {
        let mut lty = self.unary()?;
        loop {
            let (op, bp): (&str, u8) = match self.cur().clone() {
                Tok::Sym2(['&', '&']) => ("&&", 1),
                Tok::Sym2(['|', '|']) => ("||", 1),
                Tok::Sym2(['=', '=']) => ("==", 2),
                Tok::Sym2(['!', '=']) => ("!=", 2),
                Tok::Sym('<') => ("<", 2),
                Tok::Sym('>') => (">", 2),
                Tok::Sym2(['<', '=']) => ("<=", 2),
                Tok::Sym2(['>', '=']) => (">=", 2),
                Tok::Sym('+') => ("+", 3),
                Tok::Sym('-') => ("-", 3),
                Tok::Sym('*') => ("*", 4),
                Tok::Sym('/') => ("/", 4),
                Tok::Sym('%') => ("%", 4),
                _ => break,
            };
            if bp < min_bp {
                break;
            }
            self.advance();
            let rty = self.expr_bp(bp + 1)?;
            lty = self.emit_binop(op, lty, rty)?;
        }
        Ok(lty)
    }

    fn emit_binop(&mut self, op: &str, l: Ty, r: Ty) -> Result<Ty, Diagnostic> {
        use fx_vm_op::*;
        // Comparisons -> Bool (scalars). Promote to a common numeric type.
        if matches!(op, "<" | ">" | "<=" | ">=" | "==" | "!=") {
            if !l.is_scalar() || !r.is_scalar() {
                return self.err("comparison operands must be scalar");
            }
            let p = self.promote_scalars(l, r)?;
            let kind = match op {
                "<" => 0,
                "<=" => 1,
                ">" => 2,
                ">=" => 3,
                "==" => 4,
                _ => 5,
            };
            // Fixed-family scalars are scaled integers → the integer compare
            // gives the right ordering; only true float needs the float compare.
            let int_cmp = matches!(p, Ty::Int | Ty::Fixed | Ty::Fixed8 | Ty::Fixed16);
            self.emit(if int_cmp { CMP_I } else { CMP });
            self.emit(kind);
            return Ok(Ty::Bool);
        }
        if matches!(op, "&&" | "||") {
            self.emit(LOGIC);
            self.emit(if op == "&&" { 0 } else { 1 });
            return Ok(Ty::Bool);
        }
        if !l.is_num() || !r.is_num() {
            return self.err("arithmetic on non-numeric");
        }
        // Any vector operand: float-vector arithmetic with scalar broadcast.
        if l.width() > 1 || r.width() > 1 {
            return self.emit_vec_arith(op, l, r);
        }
        // Scalar arithmetic: promote to a common type, emit the typed op. Fixed-
        // family +/-/% reuse the integer ops (the representation is a scaled
        // integer); * and / are format-aware (shift by the fraction width).
        let p = self.promote_scalars(l, r)?;
        // Fraction width of the narrow fixed formats for the *FixN mul/div.
        let frac = match p {
            Ty::Fixed8 => Some(6u8),
            Ty::Fixed16 => Some(14),
            _ => None,
        };
        match (op, p) {
            ("+", Ty::Int) | ("+", Ty::Fixed) | ("+", Ty::Fixed8) | ("+", Ty::Fixed16) => {
                self.emit(ADD_I)
            }
            ("-", Ty::Int) | ("-", Ty::Fixed) | ("-", Ty::Fixed8) | ("-", Ty::Fixed16) => {
                self.emit(SUB_I)
            }
            ("*", Ty::Int) => self.emit(MUL_I),
            ("/", Ty::Int) => self.emit(DIV_I),
            // Fixed-point remainder is the plain integer remainder of the scaled ints.
            ("%", Ty::Int) | ("%", Ty::Fixed) | ("%", Ty::Fixed8) | ("%", Ty::Fixed16) => {
                self.emit(MOD_I)
            }
            ("%", Ty::Float) => return self.err("'%' is integer-only; use mod() for floats"),
            ("*", Ty::Fixed) => self.emit(MUL_FIX),
            ("/", Ty::Fixed) => self.emit(DIV_FIX),
            ("*", Ty::Fixed8) | ("*", Ty::Fixed16) => self.emit2(MUL_FIX_N, frac.unwrap()),
            ("/", Ty::Fixed8) | ("/", Ty::Fixed16) => self.emit2(DIV_FIX_N, frac.unwrap()),
            ("+", Ty::Float) => self.emit2(ADD, 1),
            ("-", Ty::Float) => self.emit2(SUB, 1),
            ("*", Ty::Float) => self.emit2(MUL, 1),
            ("/", Ty::Float) => self.emit2(DIV, 1),
            _ => return self.err("bad operator"),
        }
        Ok(p)
    }

    fn emit2(&mut self, a: u8, b: u8) {
        self.emit(a);
        self.emit(b);
    }

    /// Promote the two scalar operands already on the stack (left below, right
    /// on top) to a common type, emitting conversions. Widest wins along the
    /// lattice Int < Fixed8 < Fixed16 < Fixed < Float (more range/precision).
    fn promote_scalars(&mut self, l: Ty, r: Ty) -> Result<Ty, Diagnostic> {
        let asnum = |t: Ty| if t == Ty::Bool { Ty::Int } else { t };
        let (l, r) = (asnum(l), asnum(r));
        let rank = |t: Ty| match t {
            Ty::Int => 0,
            Ty::Fixed8 => 1,
            Ty::Fixed16 => 2,
            Ty::Fixed => 3,
            _ => 4, // Float
        };
        let p = if rank(l) >= rank(r) { l } else { r };
        if r != p {
            self.coerce(r, p)?; // top
        }
        if l != p {
            // bring left to top, convert, restore order
            self.emit2(fx_vm_op::SWAP, 1);
            self.emit(1);
            self.coerce(l, p)?;
            self.emit2(fx_vm_op::SWAP, 1);
            self.emit(1);
        }
        Ok(p)
    }

    /// Float-vector arithmetic with scalar broadcast (handles vec⊙vec,
    /// vec⊙scalar, scalar⊙vec — for +,-,*,/). Vectors are float in v1.
    fn emit_vec_arith(&mut self, op: &str, l: Ty, r: Ty) -> Result<Ty, Diagnostic> {
        use fx_vm_op::*;
        let opc = match op {
            "+" => ADD,
            "-" => SUB,
            "*" => MUL,
            "/" => DIV,
            _ => return self.err("bad vector operator"),
        };
        let lw = l.width();
        let rw = r.width();
        if lw > 1 && rw > 1 {
            if lw != rw {
                return self.err("mismatched vector widths");
            }
            self.emit2(opc, lw);
            return Ok(Ty::vec_of(lw));
        }
        if lw > 1 && rw == 1 {
            // vec ⊙ scalar : coerce scalar→float (top), broadcast, op
            if r != Ty::Float {
                self.coerce(r, Ty::Float)?;
            }
            self.broadcast_top(lw);
            self.emit2(opc, lw);
            return Ok(Ty::vec_of(lw));
        }
        // scalar ⊙ vec : [s, v]. Reorder to keep operand order for -,/.
        // 1) Swap(1, rw) -> [v, s]  2) coerce s->float, broadcast -> [v, s(rw)]
        // 3) Swap(rw, rw) -> [s(rw), v]  4) op
        self.emit2(SWAP, 1);
        self.emit(rw);
        if l != Ty::Float {
            self.coerce(l, Ty::Float)?;
        }
        self.broadcast_top(rw);
        self.emit2(SWAP, rw);
        self.emit(rw);
        self.emit2(opc, rw);
        Ok(Ty::vec_of(rw))
    }

    /// Broadcast the scalar on top of the stack to a width-`n` vector (.xxx).
    fn broadcast_top(&mut self, n: u8) {
        self.emit(fx_vm_op::SWIZZLE);
        self.emit(1);
        self.emit(n);
        for _ in 0..n {
            self.emit(0);
        }
    }

    fn unary(&mut self) -> Result<Ty, Diagnostic> {
        match self.cur().clone() {
            Tok::Sym('-') => {
                self.advance();
                let t = self.unary()?;
                match t {
                    Ty::Int | Ty::Fixed | Ty::Fixed8 | Ty::Fixed16 => self.emit(fx_vm_op::NEG_I),
                    _ => {
                        self.emit(fx_vm_op::NEG);
                        self.emit(t.width());
                    }
                }
                Ok(t)
            }
            Tok::Sym('!') => {
                self.advance();
                let t = self.unary()?;
                if t != Ty::Bool {
                    return self.err("! expects bool");
                }
                self.emit(fx_vm_op::LOGIC);
                self.emit(2);
                Ok(Ty::Bool)
            }
            _ => self.postfix(),
        }
    }

    fn postfix(&mut self) -> Result<Ty, Diagnostic> {
        let mut ty = self.primary()?;
        // member / swizzle: .x .xyz .rgb
        while *self.cur() == Tok::Sym('.') {
            self.advance();
            let field = self.eat_ident()?;
            ty = self.emit_swizzle(ty, &field)?;
        }
        Ok(ty)
    }

    fn emit_swizzle(&mut self, src: Ty, field: &str) -> Result<Ty, Diagnostic> {
        let idx = |c: char| -> Option<u8> {
            match c {
                'x' | 'r' | 's' => Some(0),
                'y' | 'g' | 't' => Some(1),
                'z' | 'b' | 'p' => Some(2),
                'w' | 'a' | 'q' => Some(3),
                _ => None,
            }
        };
        let src_w = src.width();
        let mut comps = Vec::new();
        for ch in field.chars() {
            let i = idx(ch).ok_or_else(|| self.mkdiag("bad swizzle component"))?;
            if i >= src_w {
                return self.err("swizzle component out of range");
            }
            comps.push(i);
        }
        self.emit(fx_vm_op::SWIZZLE);
        self.emit(src_w);
        self.emit(comps.len() as u8);
        for c in &comps {
            self.emit(*c);
        }
        Ok(Ty::vec_of(comps.len() as u8))
    }

    fn primary(&mut self) -> Result<Ty, Diagnostic> {
        match self.cur().clone() {
            Tok::Num(v, is_int) => {
                self.advance();
                if is_int {
                    self.push_const(v as i32 as u32);
                    Ok(Ty::Int)
                } else {
                    self.push_const(v.to_bits());
                    Ok(Ty::Float)
                }
            }
            Tok::Ident(id) if id == "true" || id == "false" => {
                self.advance();
                self.push_const(if id == "true" { 1.0f32 } else { 0.0f32 }.to_bits());
                Ok(Ty::Bool)
            }
            Tok::Sym('(') => {
                self.advance();
                let t = self.expr()?;
                self.expect_sym(')')?;
                Ok(t)
            }
            Tok::Ident(id) if id == "led" || id == "imu" => {
                // namespace access: led.pos / led.idx / imu.accel ... (further
                // swizzles like led.pos.x are then handled by postfix()).
                self.advance();
                self.expect_sym('.')?;
                let field = self.eat_ident()?;
                self.emit_namespace(&id, &field)
            }
            Tok::Ident(id) => {
                self.advance();
                if *self.cur() == Tok::Sym('(') {
                    return self.call(&id);
                }
                if let Some(sym) = self.syms.get(&id).copied() {
                    // Buffer element read: `buf[i]` -> LoadBuf, result = elem type.
                    if matches!(sym.kind, SymKind::Buffer) {
                        if *self.cur() != Tok::Sym('[') {
                            return self.err("a buffer must be indexed: name[i]");
                        }
                        return self.buffer_index_load(sym);
                    }
                    // Indexed / struct-field access -> resolve a place and load it
                    // (a leftover `.xyz` on a vec result is swizzled by postfix()).
                    if *self.cur() == Tok::Sym('[')
                        || (matches!(sym.ty, Ty::Struct(_)) && *self.cur() == Tok::Sym('.'))
                    {
                        let place = self.parse_access(sym)?;
                        self.emit_load_place(&place)?;
                        return Ok(place.ty);
                    }
                    // Whole composite value (e.g. RHS of `Agent a = other;`).
                    if matches!(sym.ty, Ty::Struct(_) | Ty::Array(_)) {
                        let place = Place {
                            kind: sym.kind,
                            base: sym.slot,
                            off: 0,
                            dynamic: false,
                            stride: 0,
                            count: 0,
                            ty: sym.ty,
                            width: self.ty_width(sym.ty),
                        };
                        self.emit_load_place(&place)?;
                        return Ok(sym.ty);
                    }
                }
                self.load_ident(&id)
            }
            other => self.err(format!("unexpected {other:?} in expression")),
        }
    }

    fn load_ident(&mut self, id: &str) -> Result<Ty, Diagnostic> {
        // context globals
        match id {
            "time" => {
                self.emit(fx_vm_op::LOAD_CTX);
                self.emit(fx_ctx::TIME);
                return Ok(Ty::Float);
            }
            "dt" => {
                self.emit(fx_vm_op::LOAD_CTX);
                self.emit(fx_ctx::DT);
                return Ok(Ty::Float);
            }
            "frame" => {
                self.emit(fx_vm_op::LOAD_CTX);
                self.emit(fx_ctx::FRAME);
                return Ok(Ty::Float);
            }
            _ => {}
        }
        // led.* accessed as `led` then `.field` — but `led` alone is invalid;
        // support the common `led.pos` etc. via a pseudo where `led` primary
        // isn't allowed. Instead handle `led` specially below in member access.
        let sym = *self.syms.get(id).ok_or_else(|| self.mkdiag(&format!("unknown identifier '{id}'")))?;
        let opc = match sym.kind {
            SymKind::Uniform => fx_vm_op::LOAD_UNIFORM,
            SymKind::State => fx_vm_op::LOAD_STATE,
            SymKind::Local => fx_vm_op::LOAD_LOCAL,
            SymKind::Buffer => return self.err("a buffer must be indexed: name[i]"),
        };
        self.emit(opc);
        self.emit(sym.slot);
        self.emit(sym.ty.width());
        Ok(sym.ty)
    }

    fn call(&mut self, name: &str) -> Result<Ty, Diagnostic> {
        self.expect_sym('(')?;
        // Texture ops take a texture NAME (not a value) as their first argument.
        if name == "sample" || name == "paint" {
            return self.texture_call(name);
        }
        // Type constructor: scalar cast (float/int/fixed) or vecN.
        if let Some(cty) = Self::ty_from_ident(name) {
            if cty.is_scalar() {
                let at = self.expr()?;
                self.expect_sym(')')?;
                if !at.is_scalar() {
                    return self.err(format!("{name}() expects a scalar"));
                }
                self.coerce(at, cty)?;
                return Ok(cty);
            }
            let w = cty.width();
            let mut got = 0u8;
            loop {
                let at = self.expr()?;
                if at.is_scalar() {
                    // vec components are float
                    if at != Ty::Float {
                        self.coerce(at, Ty::Float)?;
                    }
                    got += 1;
                } else {
                    got += at.width();
                }
                if *self.cur() == Tok::Sym(',') {
                    self.advance();
                } else {
                    break;
                }
            }
            self.expect_sym(')')?;
            if got == 1 && w > 1 {
                self.broadcast_top(w);
            } else if got != w {
                return self.err(format!("{name}() needs {w} components, got {got}"));
            }
            return Ok(cty);
        }
        // user-defined function (define-before-use)
        if let Some(f) = self.funcs.get(name).cloned() {
            for (i, pty) in f.params.iter().enumerate() {
                if i > 0 {
                    self.expect_sym(',')?;
                }
                let at = self.expr()?;
                self.coerce(at, *pty)?;
            }
            self.expect_sym(')')?;
            self.emit(fx_vm_op::CALL);
            self.emit_u16(f.entry);
            return Ok(f.ret);
        }
        // built-in functions
        let args = self.call_args()?;
        self.expect_sym(')')?;
        self.emit_builtin(name, &args)
    }

    /// `sample(tex, uv)` bilinearly samples a 2D texture at uv (vec2, 0..1) →
    /// its element type; `paint(tex, uv, color)` writes the nearest texel →
    /// void. The `(` is already consumed. `tex` must be a `texture`-declared
    /// buffer (kind 1).
    fn texture_call(&mut self, name: &str) -> Result<Ty, Diagnostic> {
        let tex_name = self.eat_ident()?;
        let sym = *self
            .syms
            .get(&tex_name)
            .ok_or_else(|| self.mkdiag(&format!("unknown texture '{tex_name}'")))?;
        if !matches!(sym.kind, SymKind::Buffer) || self.buffers[sym.slot as usize].kind != 1 {
            return self.err(format!(
                "{name}(): '{tex_name}' must be a 2D texture (declare with `texture <elem> {tex_name}(w, h);`)"
            ));
        }
        self.expect_sym(',')?;
        let uvt = self.expr()?;
        self.coerce(uvt, Ty::Vec2)?;
        // Sampling always dequantizes to a FLOAT colour (the packed precision is
        // a storage detail), so the result type is a float scalar/vec of the
        // element's component count — likewise paint() takes a float colour.
        let fty = Ty::vec_of(self.buffers[sym.slot as usize].elem);
        if name == "sample" {
            self.expect_sym(')')?;
            self.emit(fx_vm_op::SAMPLE_TEX);
            self.emit(sym.slot);
            Ok(fty)
        } else {
            self.expect_sym(',')?;
            let ct = self.expr()?;
            self.coerce(ct, fty)?;
            self.expect_sym(')')?;
            self.emit(fx_vm_op::PAINT_TEX);
            self.emit(sym.slot);
            Ok(Ty::Void)
        }
    }

    fn call_args(&mut self) -> Result<Vec<Ty>, Diagnostic> {
        let mut args = Vec::new();
        if *self.cur() == Tok::Sym(')') {
            return Ok(args);
        }
        loop {
            args.push(self.expr()?);
            if *self.cur() == Tok::Sym(',') {
                self.advance();
            } else {
                break;
            }
        }
        Ok(args)
    }

    /// Convert every scalar int/fixed arg already on the stack (in call order,
    /// last = top) to float IN PLACE, so a float-only builtin never reinterprets a
    /// scaled-integer word as f32. Scalar coercion doesn't change slot width, so
    /// coercing from the top down keeps the depths valid; a non-top arg is rotated
    /// up with Swap, coerced, and rotated back.
    fn floaten_args(&mut self, tys: &[Ty]) -> Result<(), Diagnostic> {
        for i in (0..tys.len()).rev() {
            let t = tys[i];
            if t.width() == 1 && t.fixed_frac().is_some() {
                let above: u8 = tys[i + 1..].iter().map(|a| a.width()).sum();
                if above == 0 {
                    self.coerce(t, Ty::Float)?;
                } else {
                    self.emit2(fx_vm_op::SWAP, 1);
                    self.emit(above);
                    self.coerce(t, Ty::Float)?;
                    self.emit2(fx_vm_op::SWAP, above);
                    self.emit(1);
                }
            }
        }
        Ok(())
    }

    fn emit_builtin(&mut self, name: &str, args: &[Ty]) -> Result<Ty, Diagnostic> {
        use fx_vm_op::*;
        // Float-only builtins: an int/fixed arg is CONVERTED to float (never
        // reinterpreted). Unary sqrt/log/tan and sin/cos/exp are handled below
        // (the latter with a fixed LUT); these are the multi-arg / vector ones.
        if matches!(
            name,
            "smoothstep"
                | "dot"
                | "cross"
                | "length"
                | "normalize"
                | "distance"
                | "hsv2rgb"
                | "palette0"
                | "palette1"
                | "palette2"
        ) {
            self.floaten_args(args)?;
        }
        // Reduced-precision transcendentals (FUG-10): sin/cos/exp on a fixed8 /
        // fixed16 argument compile to the pure-integer LUT opcodes — no
        // soft-float. sin/cos take the angle in TURNS (1.0 = 2π); exp saturates
        // to the ±2 range. Other scalar/vector args stay on the float path below.
        if matches!(name, "sin" | "cos" | "exp") {
            let a = self.arg1(args)?;
            let frac = match a {
                Ty::Fixed8 => Some(6u8),
                Ty::Fixed16 => Some(14),
                Ty::Fixed => Some(16),
                _ => None,
            };
            if let Some(frac) = frac {
                let op = match name {
                    "sin" => SIN_FIX,
                    "cos" => COS_FIX,
                    _ => EXP_FIX,
                };
                self.emit(op);
                self.emit(frac);
                return Ok(a);
            }
        }
        // Native integer/fixed unary — operate on the scaled-integer stack word
        // directly (no soft-float, no reinterpreting the bits as f32). abs works on
        // int + every fixed format; sign/floor/ceil/fract carry a `frac` operand
        // (frac 0 makes floor/ceil identity and fract 0, exactly int semantics).
        if matches!(name, "abs" | "sign" | "floor" | "ceil" | "fract") {
            let a = self.arg1(args)?;
            if let (1, Some(frac)) = (a.width(), a.fixed_frac()) {
                match name {
                    "abs" => self.emit(ABS_I),
                    "sign" => self.emit2(SIGN_I, frac as u8),
                    "floor" => self.emit2(FLOOR_FIX, frac as u8),
                    "ceil" => self.emit2(CEIL_FIX, frac as u8),
                    _ => self.emit2(FRACT_FIX, frac as u8),
                }
                return Ok(a);
            }
        }
        let unary = |f: u8| (UN_MATH, f);
        let un = match name {
            "sin" => Some(unary(0)),
            "cos" => Some(unary(1)),
            "abs" => Some(unary(2)),
            "floor" => Some(unary(3)),
            "ceil" => Some(unary(4)),
            "fract" => Some(unary(5)),
            "sqrt" => Some(unary(6)),
            "exp" => Some(unary(7)),
            "log" => Some(unary(8)),
            "sign" => Some(unary(9)),
            "tan" => Some(unary(10)),
            _ => None,
        };
        if let Some((opc, f)) = un {
            let mut a = self.arg1(args)?;
            // These are float-only (sqrt/log/tan/sign/fract/…, and sin/cos/exp on
            // a non-fixed8/16 arg). A scalar int/fixed arg must be CONVERTED to
            // float (not reinterpreted bit-for-bit), which the native abs/floor/
            // ceil handled above already avoided.
            if a.width() == 1 && a.fixed_frac().is_some() {
                self.coerce(a, Ty::Float)?;
                a = Ty::Float;
            }
            self.emit(opc);
            self.emit(f);
            self.emit(a.width());
            return Ok(a);
        }
        let bin = match name {
            "min" => Some(0u8),
            "max" => Some(1),
            "pow" => Some(2),
            "mod" => Some(3),
            "step" => Some(4),
            "atan2" => Some(5),
            _ => None,
        };
        if let Some(f) = bin {
            self.need(args, 2)?;
            let w = args[0].width();
            if args[1].width() != w {
                return self.err(format!("{name}() width mismatch"));
            }
            // Native integer/fixed compare/select/modulo/step — both args must be
            // the SAME int/fixed type (same scale) so the integer op is exact.
            if args[0] == args[1] && w == 1 && args[0].fixed_frac().is_some() {
                let frac = args[0].fixed_frac().unwrap() as u8;
                match name {
                    "min" => {
                        self.emit(MIN_I);
                        return Ok(args[0]);
                    }
                    "max" => {
                        self.emit(MAX_I);
                        return Ok(args[0]);
                    }
                    "mod" => {
                        self.emit(MOD_I);
                        return Ok(args[0]);
                    }
                    "step" => {
                        self.emit2(STEP_I, frac);
                        return Ok(args[0]);
                    }
                    _ => {} // pow/atan2: no integer path — fall to the float BinMath
                }
            }
            // Float path (all-float, mixed types, or pow/atan2): convert any
            // int/fixed arg to float first — never reinterpret its bits.
            self.floaten_args(args)?;
            self.emit(BIN_MATH);
            self.emit(f);
            self.emit(w);
            return Ok(Ty::vec_of(w));
        }
        match name {
            "clamp" => {
                self.need(args, 3)?;
                let w = args[0].width();
                // Native int/fixed clamp when x, lo, hi are all the same int/fixed
                // scalar type (compare/select on the scaled integer word).
                if args[0] == args[1] && args[1] == args[2] && w == 1 && args[0].fixed_frac().is_some()
                {
                    self.emit(CLAMP_I);
                    return Ok(args[0]);
                }
                // Mixed / float: convert any int/fixed arg to float, never reinterpret.
                self.floaten_args(args)?;
                self.emit(CLAMP);
                self.emit(w);
                Ok(Ty::vec_of(w))
            }
            "mix" => {
                self.need(args, 3)?;
                let w = args[0].width();
                if args[2].width() != 1 {
                    return self.err("mix(a,b,t): t must be scalar");
                }
                // Native fixed lerp when a, b, t are all the same fixed type
                // (frac > 0 — an int `t` isn't a fraction). a + ((b-a)*t >> frac).
                if args[0] == args[1]
                    && args[1] == args[2]
                    && matches!(args[0], Ty::Fixed8 | Ty::Fixed16 | Ty::Fixed)
                {
                    self.emit2(MIX_FIX, args[0].fixed_frac().unwrap() as u8);
                    return Ok(args[0]);
                }
                self.floaten_args(args)?;
                self.emit(MIX);
                self.emit(w);
                Ok(Ty::vec_of(w))
            }
            "smoothstep" => {
                self.need(args, 3)?;
                let w = args[0].width();
                self.emit(SMOOTHSTEP);
                self.emit(w);
                Ok(Ty::vec_of(w))
            }
            "dot" => {
                self.need(args, 2)?;
                self.emit(DOT);
                self.emit(args[0].width());
                Ok(Ty::Float)
            }
            "cross" => {
                self.need(args, 2)?;
                self.emit(CROSS);
                self.emit(3);
                Ok(Ty::Vec3)
            }
            "length" => {
                let a = self.arg1(args)?;
                self.emit(LENGTH);
                self.emit(a.width());
                Ok(Ty::Float)
            }
            "normalize" => {
                let a = self.arg1(args)?;
                self.emit(NORMALIZE);
                self.emit(a.width());
                Ok(a)
            }
            "distance" => {
                self.need(args, 2)?;
                self.emit(DISTANCE);
                self.emit(args[0].width());
                Ok(Ty::Float)
            }
            "hsv2rgb" => {
                // Accept hsv2rgb(vec3) OR hsv2rgb(h, s, v). Three scalar args are
                // already three contiguous stack slots — exactly the vec3(h,s,v)
                // that HSV2RGB pops — so no MakeVec is needed either way.
                let ok = (args.len() == 1 && args[0].width() == 3)
                    || (args.len() == 3 && args.iter().all(|a| a.width() == 1));
                if !ok {
                    return self.err("hsv2rgb expects a vec3 or (h, s, v)");
                }
                self.emit(HSV2RGB);
                Ok(Ty::Vec3)
            }
            "hash" => {
                let a = self.arg1(args)?;
                if a.width() == 3 {
                    self.emit(HASH3);
                } else {
                    self.emit(HASH1);
                }
                Ok(Ty::Float)
            }
            "palette" => {
                // palette(id_const, t)
                self.need(args, 2)?;
                // The id const was emitted as PushConst; we need it inline. For
                // v1, require the last emitted for arg0 to be a small int const.
                return self.err("use palette_lookup(int, float) — id must be a literal (v1: use palette0/1/2)");
            }
            "palette0" | "palette1" | "palette2" => {
                self.arg1(args)?;
                let id = name.as_bytes()[7] - b'0';
                self.emit(PALETTE);
                self.emit(id);
                Ok(Ty::Vec3)
            }
            // -- topology graph queries (agentic/graph-walking effects) --------
            // All take integer indices; seg_len returns float, the rest return
            // an int (segment/node id, degree, side). The args are already on the
            // stack; GraphQuery pops them per its kind. See fx_vm::gq.
            "seg_count" => {
                self.need(args, 0)?;
                self.emit(GRAPH_QUERY);
                self.emit(0);
                Ok(Ty::Int)
            }
            "seg_len" => {
                self.graph_int_args(args, 1)?;
                self.emit(GRAPH_QUERY);
                self.emit(1);
                Ok(Ty::Float)
            }
            "seg_node" => {
                self.graph_int_args(args, 2)?;
                self.emit(GRAPH_QUERY);
                self.emit(2);
                Ok(Ty::Int)
            }
            "node_deg" => {
                self.graph_int_args(args, 1)?;
                self.emit(GRAPH_QUERY);
                self.emit(3);
                Ok(Ty::Int)
            }
            "node_seg" => {
                self.graph_int_args(args, 2)?;
                self.emit(GRAPH_QUERY);
                self.emit(4);
                Ok(Ty::Int)
            }
            "node_side" => {
                self.graph_int_args(args, 2)?;
                self.emit(GRAPH_QUERY);
                self.emit(5);
                Ok(Ty::Int)
            }
            // Settable geodesic source (flood from any endpoint / agents):
            "term_count" => {
                self.need(args, 0)?;
                self.emit(GRAPH_QUERY);
                self.emit(6);
                Ok(Ty::Int)
            }
            "term" => {
                self.graph_int_args(args, 1)?;
                self.emit(GRAPH_QUERY);
                self.emit(7);
                Ok(Ty::Int)
            }
            // flood_from(node): set the geodesic source; led.dist then reports
            // distance from `node`. Void — call it in update(), once per cycle.
            "flood_from" => {
                self.graph_int_args(args, 1)?;
                self.emit(FLOOD_FROM);
                Ok(Ty::Void)
            }
            // -- I2C sensor-driver intrinsics (FUG-107) -----------------------
            // Only meaningful inside `poll()`; elsewhere the VM has no bus and
            // the read returns -1 / the write returns 0. All args are int (a
            // 7-bit device address, a register, a byte) — the readings come back
            // as int (byte value / big-endian u16, or -1 on a bus error).
            "i2c_write" => {
                self.i2c_int_args(args, 3)?;
                self.emit(I2C_WRITE);
                Ok(Ty::Int)
            }
            "i2c_read8" => {
                self.i2c_int_args(args, 2)?;
                self.emit(I2C_READ);
                self.emit(1);
                Ok(Ty::Int)
            }
            "i2c_read16" => {
                self.i2c_int_args(args, 2)?;
                self.emit(I2C_READ);
                self.emit(2);
                Ok(Ty::Int)
            }
            _ => self.err(format!("unknown function '{name}'")),
        }
    }

    /// Validate an I2C intrinsic's args: exactly `n`, each a scalar `int` (the
    /// I2C opcodes pop them as ints). Like [`graph_int_args`] — no coercion, so
    /// wrap a non-int (e.g. a `float`) in `int(...)` at the call site.
    fn i2c_int_args(&self, args: &[Ty], n: usize) -> Result<(), Diagnostic> {
        self.need(args, n)?;
        if args.iter().any(|a| !matches!(a, Ty::Int)) {
            return Err(self.mkdiag("i2c arguments must be int (wrap with int(...))"));
        }
        Ok(())
    }

    fn arg1(&mut self, args: &[Ty]) -> Result<Ty, Diagnostic> {
        self.need(args, 1)?;
        Ok(args[0])
    }
    fn need(&self, args: &[Ty], n: usize) -> Result<(), Diagnostic> {
        if args.len() != n {
            Err(self.mkdiag(&format!("expected {n} arguments, got {}", args.len())))
        } else {
            Ok(())
        }
    }

    /// Validate a graph-query's args: exactly `n`, each a scalar `int` (they are
    /// integer indices the GraphQuery opcode pops). No coercion — wrap a
    /// non-int index in `int(...)` at the call site.
    fn graph_int_args(&self, args: &[Ty], n: usize) -> Result<(), Diagnostic> {
        self.need(args, n)?;
        if args.iter().any(|a| !matches!(a, Ty::Int)) {
            return Err(self.mkdiag("graph query arguments must be int (wrap with int(...))"));
        }
        Ok(())
    }

    fn emit_namespace(&mut self, ns: &str, field: &str) -> Result<Ty, Diagnostic> {
        let (id, ty) = match (ns, field) {
            ("led", "pos") => (fx_ctx::LED_POS, Ty::Vec3),
            ("led", "idx") => (fx_ctx::LED_IDX, Ty::Float),
            ("led", "count") => (fx_ctx::LED_COUNT, Ty::Float),
            ("led", "seg") => (fx_ctx::LED_SEG, Ty::Float),
            ("led", "s") => (fx_ctx::LED_S, Ty::Float),
            ("led", "dist") => (fx_ctx::LED_DIST, Ty::Float),
            ("led", "uv") => (fx_ctx::LED_UV, Ty::Vec2),
            ("led", "branch") => (fx_ctx::LED_BRANCH, Ty::Bool),
            ("imu", "accel") => (fx_ctx::IMU_ACCEL, Ty::Vec3),
            ("imu", "gyro") => (fx_ctx::IMU_GYRO, Ty::Vec3),
            _ => return self.err(format!("no field {ns}.{field}")),
        };
        self.emit(fx_vm_op::LOAD_CTX);
        self.emit(id);
        Ok(ty)
    }

    /// Coerce the value on TOP of the stack from `from` to `to`, emitting a
    /// conversion op if the scalar numeric representation differs.
    fn coerce(&mut self, from: Ty, to: Ty) -> Result<(), Diagnostic> {
        if from == to {
            return Ok(());
        }
        if from.is_scalar() && to.is_scalar() {
            let op = match (from, to) {
                (Ty::Int, Ty::Float) => Some(fx_vm_op::I2F),
                (Ty::Float, Ty::Int) => Some(fx_vm_op::F2I),
                (Ty::Fixed, Ty::Float) => Some(fx_vm_op::FIX2F),
                (Ty::Float, Ty::Fixed) => Some(fx_vm_op::F2FIX),
                (Ty::Int, Ty::Fixed) => Some(fx_vm_op::I2FIX),
                (Ty::Fixed, Ty::Int) => Some(fx_vm_op::FIX2I),
                _ => None,
            };
            if let Some(o) = op {
                self.emit(o);
                return Ok(());
            }
            // Narrow fixed formats (Fixed8/Fixed16) and any other fixed-family
            // pair not covered above: convert between fraction widths by an
            // arithmetic shift, or cross the float boundary via FixToF/FixFromF.
            match (from.fixed_frac(), to.fixed_frac()) {
                (Some(f), Some(t)) => {
                    let sh = t as i32 - f as i32;
                    if sh != 0 {
                        self.emit(fx_vm_op::FIX_RESCALE);
                        self.emit(sh as i8 as u8);
                    }
                    return Ok(());
                }
                (Some(f), None) => {
                    // fixed-family -> float
                    self.emit(fx_vm_op::FIX_TO_F);
                    self.emit(f as u8);
                    return Ok(());
                }
                (None, Some(t)) => {
                    // float -> fixed-family
                    self.emit(fx_vm_op::FIX_FROM_F);
                    self.emit(t as u8);
                    return Ok(());
                }
                (None, None) => {}
            }
        }
        // bool <-> {int,float,fixed*} at the value level (0/1) — allow reading a
        // bool as a number and vice-versa (all are 0/1 words). A bool rides as a
        // 1.0/0.0 float, so narrowing to a fixed format quantizes it via FixFromF.
        if matches!(from, Ty::Bool) && to.is_scalar() {
            match to {
                Ty::Fixed => self.emit(fx_vm_op::F2FIX),
                Ty::Int => self.emit(fx_vm_op::F2I),
                Ty::Fixed8 => self.emit2(fx_vm_op::FIX_FROM_F, 6),
                Ty::Fixed16 => self.emit2(fx_vm_op::FIX_FROM_F, 14),
                _ => {} // Float: nop
            }
            return Ok(());
        }
        self.err(format!("type mismatch: {from:?} vs {to:?}"))
    }

    fn expect_sym(&mut self, ch: char) -> Result<(), Diagnostic> {
        self.eat_sym(ch)
    }
    fn mkdiag(&self, msg: &str) -> Diagnostic {
        let (_, line, col) = &self.lx_toks[self.p.min(self.lx_toks.len() - 1)];
        Diagnostic { line: *line, col: *col, msg: msg.to_string() }
    }

    fn finish(self) -> Compiled {
        let mut b = Vec::new();
        let flags = if self.buffers.is_empty() { 0 } else { FLAG_BUFFERS };
        b.extend_from_slice(b"FXB1");
        b.push(2); // version 2: adds poll_entry to the header (FUG-107)
        b.push(flags); // flags
        b.push(self.n_state);
        b.push(self.n_uniform_slots);
        // manifest: a compact encoding (VM skips it; the app decodes via the
        // returned Vec<UniformInfo>, so keep the on-wire manifest minimal here).
        let manifest: Vec<u8> = Vec::new();
        b.extend_from_slice(&(manifest.len() as u16).to_le_bytes());
        b.extend_from_slice(&(self.consts.len() as u16).to_le_bytes());
        b.extend_from_slice(&(self.code.len() as u16).to_le_bytes());
        b.extend_from_slice(&self.update_entry.to_le_bytes());
        b.extend_from_slice(&self.shade_entry.to_le_bytes());
        b.extend_from_slice(&self.poll_entry.to_le_bytes()); // v2 field
        b.extend_from_slice(&manifest);
        for c in &self.consts {
            b.extend_from_slice(&c.to_le_bytes());
        }
        b.extend_from_slice(&self.code);
        // Optional buffer descriptor table (FLAG_BUFFERS): n_buffers, then
        // n × [kind(u8) elem(u8) comp(u8) w(u16) h(u16)] — mirrors
        // fx_vm::Program::parse.
        if !self.buffers.is_empty() {
            b.push(self.buffers.len() as u8);
            for buf in &self.buffers {
                b.push(buf.kind);
                b.push(buf.elem);
                b.push(buf.comp);
                b.extend_from_slice(&buf.w.to_le_bytes());
                b.extend_from_slice(&buf.h.to_le_bytes());
            }
        }
        Compiled { fxb: b, uniforms: self.uniforms, exports: self.exports }
    }
}

// -- disassembler -------------------------------------------------------------

/// Disassemble a `.fxb` byte buffer to a human-readable listing: the header
/// summary, the const pool, then the code stream as `offset: MNEMONIC operands`
/// with the `update()`/`shade()` entry points labelled. This is the AUTHORITATIVE
/// disassembler — it reads the exact `.fxb` header (mirrors fx_vm::Program::parse
/// in firmware/fx_vm/src/lib.rs) and the `fx_vm_op` opcode table below, so it can
/// never drift from what the VM executes. Malformed input yields a short error
/// line rather than a panic.
pub fn disassemble(fxb: &[u8]) -> String {
    let mut out = String::new();
    if fxb.len() < 18 {
        return "; error: buffer too short for header\n".into();
    }
    if &fxb[0..4] != b"FXB1" {
        return "; error: bad magic (expected FXB1)\n".into();
    }
    let ver = fxb[4];
    let n_state = fxb[6];
    let n_uniform_slots = fxb[7];
    let manifest_len = u16::from_le_bytes([fxb[8], fxb[9]]) as usize;
    let n_consts = u16::from_le_bytes([fxb[10], fxb[11]]) as usize;
    let code_len = u16::from_le_bytes([fxb[12], fxb[13]]) as usize;
    let update_entry = u16::from_le_bytes([fxb[14], fxb[15]]);
    let shade_entry = u16::from_le_bytes([fxb[16], fxb[17]]);
    // v2 appends poll_entry (FUG-107); v1 headers end at 18 with no poll.
    let (poll_entry, hdr_len) = if ver >= 2 && fxb.len() >= 20 {
        (u16::from_le_bytes([fxb[18], fxb[19]]), 20usize)
    } else {
        (NO_ENTRY, 18usize)
    };

    let _ = write!(
        out,
        "; FXB v{ver}  state={n_state}  uniform_slots={n_uniform_slots}  consts={n_consts}  code={code_len}B\n"
    );
    let _ = write!(
        out,
        "; update_entry={}  shade_entry={}  poll_entry={}\n",
        entry_label(update_entry),
        entry_label(shade_entry),
        entry_label(poll_entry)
    );

    let mut o = hdr_len;
    let consts_off = o + manifest_len;
    o = consts_off;
    // Const pool (raw 32-bit words shown as both f32 and i32 — the compiler types
    // every op so the runtime interpretation is unambiguous, but showing both is
    // handy since ints/fixed ride in the same slots).
    if n_consts > 0 && consts_off + n_consts * 4 <= fxb.len() {
        out.push_str("; consts:\n");
        for i in 0..n_consts {
            let b = &fxb[consts_off + i * 4..consts_off + i * 4 + 4];
            let bits = u32::from_le_bytes([b[0], b[1], b[2], b[3]]);
            let f = f32::from_bits(bits);
            let _ = write!(out, ";   [{i}] = {f} (i32 {})\n", bits as i32);
        }
    }
    o += n_consts * 4;
    let code_off = o;
    if code_off + code_len > fxb.len() {
        out.push_str("; error: code section exceeds buffer\n");
        return out;
    }
    let code = &fxb[code_off..code_off + code_len];

    let mut pc = 0usize;
    while pc < code.len() {
        // Label the entry points as the disassembler reaches them.
        if pc == update_entry as usize && update_entry != NO_ENTRY {
            out.push_str("update:\n");
        }
        if pc == shade_entry as usize && shade_entry != NO_ENTRY {
            out.push_str("shade:\n");
        }
        if pc == poll_entry as usize && poll_entry != NO_ENTRY {
            out.push_str("poll:\n");
        }
        let (text, len) = decode_op(code, pc);
        let _ = write!(out, "{pc:>5}: {text}\n");
        if len == 0 {
            break;
        }
        pc += len;
    }
    out
}

fn entry_label(e: u16) -> String {
    if e == NO_ENTRY {
        "none".into()
    } else {
        e.to_string()
    }
}

/// Decode one opcode at `pc`. Returns `(rendered text, byte length incl operands)`.
/// A length of 0 signals an unknown opcode (stop). Mirrors the `run` dispatch in
/// firmware/fx_vm/src/lib.rs and the `fx_vm_op` table below.
fn decode_op(code: &[u8], pc: usize) -> (String, usize) {
    use fx_vm_op::*;
    let op = code[pc];
    let b = |k: usize| *code.get(pc + 1 + k).unwrap_or(&0);
    let u16at = |k: usize| u16::from_le_bytes([b(k), b(k + 1)]);
    let i16at = |k: usize| i16::from_le_bytes([b(k), b(k + 1)]);
    // Signed branch targets are resolved to an absolute offset for readability.
    let rel_target = |operand_len: usize| {
        let next = pc + 1 + operand_len;
        (next as isize + i16at(0) as isize) as isize
    };
    let un_fn = |f: u8| match f {
        0 => "sin", 1 => "cos", 2 => "abs", 3 => "floor", 4 => "ceil", 5 => "fract",
        6 => "sqrt", 7 => "exp", 8 => "log", 9 => "sign", 10 => "tan", _ => "?",
    };
    let bin_fn = |f: u8| match f {
        0 => "min", 1 => "max", 2 => "pow", 3 => "mod", 4 => "step", 5 => "atan2", _ => "?",
    };
    let ctx_name = |id: u8| match id {
        0 => "time", 1 => "dt", 2 => "frame", 3 => "led.pos", 4 => "led.idx",
        5 => "led.count", 6 => "led.seg", 7 => "led.s", 8 => "led.branch",
        9 => "imu.accel", 10 => "imu.gyro", 11 => "led.dist", 12 => "led.uv", _ => "?",
    };
    let cmp_kind = |k: u8| match k {
        0 => "lt", 1 => "le", 2 => "gt", 3 => "ge", 4 => "eq", _ => "ne",
    };
    match op {
        PUSH_CONST => (format!("PUSH_CONST c{}", u16at(0)), 3),
        LOAD_UNIFORM => (format!("LOAD_UNIFORM slot={} n={}", b(0), b(1)), 3),
        LOAD_STATE => (format!("LOAD_STATE slot={} n={}", b(0), b(1)), 3),
        STORE_STATE => (format!("STORE_STATE slot={} n={}", b(0), b(1)), 3),
        LOAD_LOCAL => (format!("LOAD_LOCAL slot={} n={}", b(0), b(1)), 3),
        STORE_LOCAL => (format!("STORE_LOCAL slot={} n={}", b(0), b(1)), 3),
        LOAD_CTX => (format!("LOAD_CTX {}", ctx_name(b(0))), 2),
        ADD => (format!("ADD n={}", b(0)), 2),
        SUB => (format!("SUB n={}", b(0)), 2),
        MUL => (format!("MUL n={}", b(0)), 2),
        DIV => (format!("DIV n={}", b(0)), 2),
        NEG => (format!("NEG n={}", b(0)), 2),
        SCALE => (format!("SCALE n={}", b(0)), 2),
        UN_MATH => (format!("UN_MATH {} n={}", un_fn(b(0)), b(1)), 3),
        BIN_MATH => (format!("BIN_MATH {} n={}", bin_fn(b(0)), b(1)), 3),
        CLAMP => (format!("CLAMP n={}", b(0)), 2),
        MIX => (format!("MIX n={}", b(0)), 2),
        SMOOTHSTEP => (format!("SMOOTHSTEP n={}", b(0)), 2),
        DOT => (format!("DOT n={}", b(0)), 2),
        CROSS => (format!("CROSS n={}", b(0)), 2),
        LENGTH => (format!("LENGTH n={}", b(0)), 2),
        NORMALIZE => (format!("NORMALIZE n={}", b(0)), 2),
        DISTANCE => (format!("DISTANCE n={}", b(0)), 2),
        SWIZZLE => {
            let src_n = b(0);
            let dst_n = b(1) as usize;
            let mut comps = String::new();
            for i in 0..dst_n {
                if i > 0 {
                    comps.push(',');
                }
                let _ = write!(comps, "{}", b(2 + i));
            }
            (format!("SWIZZLE src={src_n} dst={dst_n} [{comps}]"), 3 + dst_n)
        }
        CMP => (format!("CMP {}", cmp_kind(b(0))), 2),
        LOGIC => {
            let k = match b(0) { 0 => "and", 1 => "or", _ => "not" };
            (format!("LOGIC {k}"), 2)
        }
        BR_FALSE => (format!("BR_FALSE -> {}", rel_target(2)), 3),
        JMP => (format!("JMP -> {}", rel_target(2)), 3),
        HASH1 => ("HASH1".into(), 1),
        HASH3 => ("HASH3".into(), 1),
        HSV2RGB => ("HSV2RGB".into(), 1),
        PALETTE => (format!("PALETTE id={}", b(0)), 2),
        _POP => (format!("POP n={}", b(0)), 2),
        RET => (format!("RET n={}", b(0)), 2),
        SWAP => (format!("SWAP a={} b={}", b(0), b(1)), 3),
        ADD_I => ("ADD_I".into(), 1),
        SUB_I => ("SUB_I".into(), 1),
        MUL_I => ("MUL_I".into(), 1),
        DIV_I => ("DIV_I".into(), 1),
        MOD_I => ("MOD_I".into(), 1),
        NEG_I => ("NEG_I".into(), 1),
        CMP_I => (format!("CMP_I {}", cmp_kind(b(0))), 2),
        MUL_FIX => ("MUL_FIX".into(), 1),
        DIV_FIX => ("DIV_FIX".into(), 1),
        I2F => ("I2F".into(), 1),
        F2I => ("F2I".into(), 1),
        FIX2F => ("FIX2F".into(), 1),
        F2FIX => ("F2FIX".into(), 1),
        I2FIX => ("I2FIX".into(), 1),
        FIX2I => ("FIX2I".into(), 1),
        CALL => (format!("CALL -> {}", u16at(0)), 3),
        RET_FN => ("RET_FN".into(), 1),
        LOAD_STATE_IDX => (
            format!("LOAD_STATE_IDX base={} stride={} off={} n={} count={}", b(0), b(1), b(2), b(3), b(4)),
            6,
        ),
        STORE_STATE_IDX => (
            format!("STORE_STATE_IDX base={} stride={} off={} n={} count={}", b(0), b(1), b(2), b(3), b(4)),
            6,
        ),
        LOAD_LOCAL_IDX => (
            format!("LOAD_LOCAL_IDX base={} stride={} off={} n={} count={}", b(0), b(1), b(2), b(3), b(4)),
            6,
        ),
        STORE_LOCAL_IDX => (
            format!("STORE_LOCAL_IDX base={} stride={} off={} n={} count={}", b(0), b(1), b(2), b(3), b(4)),
            6,
        ),
        GRAPH_QUERY => {
            let k = match b(0) {
                0 => "seg_count", 1 => "seg_len", 2 => "seg_node", 3 => "node_deg",
                4 => "node_seg", 5 => "node_side", 6 => "term_count", 7 => "term", _ => "?",
            };
            (format!("GRAPH_QUERY {k}"), 2)
        }
        LOAD_BUF => (format!("LOAD_BUF id={}", b(0)), 2),
        STORE_BUF => (format!("STORE_BUF id={}", b(0)), 2),
        SAMPLE_TEX => (format!("SAMPLE_TEX id={}", b(0)), 2),
        PAINT_TEX => (format!("PAINT_TEX id={}", b(0)), 2),
        FLOOD_FROM => ("FLOOD_FROM".into(), 1),
        MUL_FIX_N => (format!("MUL_FIX_N frac={}", b(0)), 2),
        DIV_FIX_N => (format!("DIV_FIX_N frac={}", b(0)), 2),
        FIX_RESCALE => (format!("FIX_RESCALE shift={}", b(0) as i8), 2),
        FIX_TO_F => (format!("FIX_TO_F frac={}", b(0)), 2),
        FIX_FROM_F => (format!("FIX_FROM_F frac={}", b(0)), 2),
        SIN_FIX => (format!("SIN_FIX frac={}", b(0)), 2),
        COS_FIX => (format!("COS_FIX frac={}", b(0)), 2),
        EXP_FIX => (format!("EXP_FIX frac={}", b(0)), 2),
        ABS_I => ("ABS_I".into(), 1),
        MIN_I => ("MIN_I".into(), 1),
        MAX_I => ("MAX_I".into(), 1),
        CLAMP_I => ("CLAMP_I".into(), 1),
        SIGN_I => (format!("SIGN_I frac={}", b(0)), 2),
        STEP_I => (format!("STEP_I frac={}", b(0)), 2),
        FLOOR_FIX => (format!("FLOOR_FIX frac={}", b(0)), 2),
        CEIL_FIX => (format!("CEIL_FIX frac={}", b(0)), 2),
        FRACT_FIX => (format!("FRACT_FIX frac={}", b(0)), 2),
        MIX_FIX => (format!("MIX_FIX frac={}", b(0)), 2),
        I2C_WRITE => ("I2C_WRITE".into(), 1),
        I2C_READ => (format!("I2C_READ n={}", b(0)), 2),
        other => (format!("?? 0x{other:02x}"), 0),
    }
}

fn default_ui(ty: Ty) -> UiKind {
    match ty {
        Ty::Bool => UiKind::Toggle,
        Ty::Vec3 | Ty::Vec4 => UiKind::Color,
        _ => UiKind::Slider { min: 0.0, max: 1.0, step: 0.01 },
    }
}

/// Render the uniform manifest as JSON (for the app / editor).
pub fn manifest_json(uniforms: &[UniformInfo]) -> String {
    let mut s = String::from("[");
    for (i, u) in uniforms.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        let ui = match &u.ui {
            UiKind::Slider { min, max, step } => {
                format!("{{\"kind\":\"slider\",\"min\":{min},\"max\":{max},\"step\":{step}}}")
            }
            UiKind::Color => "{\"kind\":\"color\"}".to_string(),
            UiKind::Toggle => "{\"kind\":\"toggle\"}".to_string(),
            UiKind::Dropdown(o) => {
                let opts: Vec<String> = o.iter().map(|x| format!("\"{x}\"")).collect();
                format!("{{\"kind\":\"dropdown\",\"options\":[{}]}}", opts.join(","))
            }
        };
        let def: Vec<String> = u.default.iter().map(|v| v.to_string()).collect();
        let _ = write!(
            s,
            "{{\"name\":\"{}\",\"slot\":{},\"width\":{},\"ui\":{ui},\"default\":[{}]}}",
            u.name,
            u.slot,
            u.ty.width(),
            def.join(",")
        );
    }
    s.push(']');
    s
}

/// Render the driver export manifest as JSON (FUG-107): the named sensor
/// readings `poll()` writes, which the app auto-binds to same-named effect
/// uniforms. `[{"name","slot","width","unit"}]`.
pub fn exports_manifest_json(exports: &[ExportInfo]) -> String {
    let mut s = String::from("[");
    for (i, e) in exports.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        let _ = write!(
            s,
            "{{\"name\":\"{}\",\"slot\":{},\"width\":{},\"unit\":\"{}\"}}",
            e.name,
            e.slot,
            e.ty.width(),
            e.unit
        );
    }
    s.push(']');
    s
}

// Opcode constants mirroring fx_vm::Op discriminants (kept in sync by the
// fx_vm crate order; a test asserts they match).
mod fx_vm_op {
    pub const PUSH_CONST: u8 = 0;
    pub const LOAD_UNIFORM: u8 = 1;
    pub const LOAD_STATE: u8 = 2;
    pub const STORE_STATE: u8 = 3;
    pub const LOAD_LOCAL: u8 = 4;
    pub const STORE_LOCAL: u8 = 5;
    pub const LOAD_CTX: u8 = 6;
    pub const ADD: u8 = 7;
    pub const SUB: u8 = 8;
    pub const MUL: u8 = 9;
    pub const DIV: u8 = 10;
    pub const NEG: u8 = 11;
    pub const SCALE: u8 = 12;
    pub const UN_MATH: u8 = 13;
    pub const BIN_MATH: u8 = 14;
    pub const CLAMP: u8 = 15;
    pub const MIX: u8 = 16;
    pub const SMOOTHSTEP: u8 = 17;
    pub const DOT: u8 = 18;
    pub const CROSS: u8 = 19;
    pub const LENGTH: u8 = 20;
    pub const NORMALIZE: u8 = 21;
    pub const DISTANCE: u8 = 22;
    pub const SWIZZLE: u8 = 23;
    pub const CMP: u8 = 24;
    pub const LOGIC: u8 = 25;
    pub const BR_FALSE: u8 = 26;
    pub const JMP: u8 = 27;
    pub const HASH1: u8 = 28;
    pub const HASH3: u8 = 29;
    pub const HSV2RGB: u8 = 30;
    pub const PALETTE: u8 = 31;
    pub const _POP: u8 = 32;
    pub const RET: u8 = 33;
    pub const SWAP: u8 = 34;
    pub const ADD_I: u8 = 35;
    pub const SUB_I: u8 = 36;
    pub const MUL_I: u8 = 37;
    pub const DIV_I: u8 = 38;
    pub const MOD_I: u8 = 39;
    pub const NEG_I: u8 = 40;
    pub const CMP_I: u8 = 41;
    pub const MUL_FIX: u8 = 42;
    pub const DIV_FIX: u8 = 43;
    pub const I2F: u8 = 44;
    pub const F2I: u8 = 45;
    pub const FIX2F: u8 = 46;
    pub const F2FIX: u8 = 47;
    pub const I2FIX: u8 = 48;
    pub const FIX2I: u8 = 49;
    pub const CALL: u8 = 50;
    pub const RET_FN: u8 = 51;
    pub const LOAD_STATE_IDX: u8 = 52;
    pub const STORE_STATE_IDX: u8 = 53;
    pub const LOAD_LOCAL_IDX: u8 = 54;
    pub const STORE_LOCAL_IDX: u8 = 55;
    pub const GRAPH_QUERY: u8 = 56;
    pub const LOAD_BUF: u8 = 57;
    pub const STORE_BUF: u8 = 58;
    pub const SAMPLE_TEX: u8 = 59;
    pub const PAINT_TEX: u8 = 60;
    pub const FLOOD_FROM: u8 = 61;
    // Reduced-precision fixed-point (FUG-10). Mirror fx_vm::Op ordering.
    pub const MUL_FIX_N: u8 = 62;
    pub const DIV_FIX_N: u8 = 63;
    pub const FIX_RESCALE: u8 = 64;
    pub const FIX_TO_F: u8 = 65;
    pub const FIX_FROM_F: u8 = 66;
    pub const SIN_FIX: u8 = 67;
    pub const COS_FIX: u8 = 68;
    pub const EXP_FIX: u8 = 69;
    // Integer/fixed abs/min/max/clamp (serve int + every fixed format).
    pub const ABS_I: u8 = 70;
    pub const MIN_I: u8 = 71;
    pub const MAX_I: u8 = 72;
    pub const CLAMP_I: u8 = 73;
    // sign/step/floor/ceil/fract/mix with a u8 frac operand (int = frac 0).
    pub const SIGN_I: u8 = 74;
    pub const STEP_I: u8 = 75;
    pub const FLOOR_FIX: u8 = 76;
    pub const CEIL_FIX: u8 = 77;
    pub const FRACT_FIX: u8 = 78;
    pub const MIX_FIX: u8 = 79;
    // I2C sensor-driver intrinsics (FUG-107).
    pub const I2C_WRITE: u8 = 80;
    pub const I2C_READ: u8 = 81;
}

/// `.fxb` flags bit: a buffer descriptor table follows `code` (mirrors
/// fx_vm::FLAG_BUFFERS). One byte `n_buffers`, then n × [kind(u8) elem(u8)
/// comp(u8) w(u16) h(u16)] (7 bytes each = fx_vm::BUF_DESC_LEN).
const FLAG_BUFFERS: u8 = 0x01;
mod fx_ctx {
    pub const TIME: u8 = 0;
    pub const DT: u8 = 1;
    pub const FRAME: u8 = 2;
    pub const LED_POS: u8 = 3;
    pub const LED_IDX: u8 = 4;
    pub const LED_COUNT: u8 = 5;
    pub const LED_SEG: u8 = 6;
    pub const LED_S: u8 = 7;
    pub const LED_BRANCH: u8 = 8;
    pub const IMU_ACCEL: u8 = 9;
    pub const IMU_GYRO: u8 = 10;
    pub const LED_DIST: u8 = 11;
    pub const LED_UV: u8 = 12;
}
