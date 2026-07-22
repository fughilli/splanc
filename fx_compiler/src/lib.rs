//! Effects compiler (docs/design/effects-compiler.md): a GLSL-ish shader source
//! → `.fxb` bytecode + a uniform manifest, for the effects VM (fx_vm). Runs on
//! the host (tests) and in the browser as wasm. A compact single-pass
//! type-checking codegen over a recursive-descent parse — enough for the
//! hybrid update()/shade() model, uniforms with ranges, scalar/vector math,
//! swizzles, the built-ins, and if/else. (User functions + for-loops: TODO.)

use std::collections::HashMap;
use std::fmt::Write as _;

// -- types --------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Ty {
    Float,
    Vec2,
    Vec3,
    Vec4,
    Int,
    Bool,
    Void,
}
impl Ty {
    fn width(self) -> u8 {
        match self {
            Ty::Float | Ty::Int | Ty::Bool => 1,
            Ty::Vec2 => 2,
            Ty::Vec3 => 3,
            Ty::Vec4 => 4,
            Ty::Void => 0,
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
        !matches!(self, Ty::Bool | Ty::Void)
    }
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

pub struct Compiled {
    pub fxb: Vec<u8>,
    pub uniforms: Vec<UniformInfo>,
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
            let mut sv = String::new();
            while self.i < self.s.len() && self.s[self.i] != b'"' {
                sv.push(self.bump() as char);
            }
            if self.i < self.s.len() {
                self.bump();
            }
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
}
#[derive(Clone, Copy)]
struct Sym {
    kind: SymKind,
    slot: u8,
    ty: Ty,
}

pub struct Compiler {
    lx_toks: Vec<(Tok, u32, u32)>,
    p: usize,
    // symbol tables
    syms: HashMap<String, Sym>,
    uniforms: Vec<UniformInfo>,
    n_uniform_slots: u8,
    n_state: u8,
    n_locals: u8,
    // const pool
    consts: Vec<f32>,
    // output code (per function)
    code: Vec<u8>,
    update_entry: u16,
    shade_entry: u16,
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
        uniforms: Vec::new(),
        n_uniform_slots: 0,
        n_state: 0,
        n_locals: 0,
        consts: Vec::new(),
        code: Vec::new(),
        update_entry: 0xFFFF,
        shade_entry: 0xFFFF,
    };
    match c.program() {
        Ok(()) => Ok(c.finish()),
        Err(d) => Err(vec![d]),
    }
}

const NO_ENTRY: u16 = 0xFFFF;

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
    fn const_idx(&mut self, v: f32) -> u16 {
        for (i, c) in self.consts.iter().enumerate() {
            if *c == v {
                return i as u16;
            }
        }
        self.consts.push(v);
        (self.consts.len() - 1) as u16
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
            "bool" => Ty::Bool,
            "void" => Ty::Void,
            _ => return None,
        })
    }

    fn program(&mut self) -> Result<(), Diagnostic> {
        loop {
            match self.cur().clone() {
                Tok::Eof => break,
                Tok::Ident(kw) if kw == "uniform" => self.uniform_decl()?,
                Tok::Ident(kw) if kw == "state" => self.state_decl()?,
                Tok::Ident(kw) if Self::ty_from_ident(&kw).is_some() => self.func_decl()?,
                other => return self.err(format!("unexpected token {other:?}")),
            }
        }
        if self.shade_entry == NO_ENTRY {
            return self.err("program must define `vec3 shade(Led led)`");
        }
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
                Ok(vec![v])
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

    fn state_decl(&mut self) -> Result<(), Diagnostic> {
        self.advance(); // 'state'
        let tyname = self.eat_ident()?;
        let ty = Self::ty_from_ident(&tyname).ok_or_else(|| self.mkdiag("unknown type"))?;
        let name = self.eat_ident()?;
        self.expect_sym(';')?;
        let slot = self.n_state;
        self.n_state += ty.width();
        self.syms.insert(name, Sym { kind: SymKind::State, slot, ty });
        Ok(())
    }

    fn func_decl(&mut self) -> Result<(), Diagnostic> {
        let ret_ty = Self::ty_from_ident(&self.eat_ident()?).unwrap();
        let name = self.eat_ident()?;
        self.expect_sym('(')?;
        // params: only `Led led` supported (for shade). skip tokens to ')'.
        while *self.cur() != Tok::Sym(')') && *self.cur() != Tok::Eof {
            self.advance();
        }
        self.expect_sym(')')?;
        // reset per-function locals
        self.n_locals = 0;
        let entry = self.code.len() as u16;
        self.expect_sym('{')?;
        let want = match name.as_str() {
            "update" => Ty::Void,
            "shade" => Ty::Vec3,
            _ => return self.err("only update() and shade(Led led) supported in v1"),
        };
        let _ = ret_ty;
        self.block(want)?;
        // implicit return
        self.emit(fx_vm_op::RET);
        self.emit(want.width());
        self.expect_sym('}')?;
        // clear locals from scope
        self.syms.retain(|_, s| !matches!(s.kind, SymKind::Local));
        match name.as_str() {
            "update" => self.update_entry = entry,
            "shade" => self.shade_entry = entry,
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
                    self.emit(fx_vm_op::RET);
                    self.emit(0);
                } else {
                    let t = self.expr()?;
                    self.coerce(t, ret)?;
                    self.expect_sym(';')?;
                    self.emit(fx_vm_op::RET);
                    self.emit(ret.width());
                }
                Ok(())
            }
            Tok::Ident(kw) if kw == "if" => self.if_stmt(ret),
            Tok::Ident(tyname) if Self::ty_from_ident(&tyname).is_some() => {
                // local decl: `float d = expr;`
                self.advance();
                let ty = Self::ty_from_ident(&tyname).unwrap();
                let name = self.eat_ident()?;
                self.expect_sym('=')?;
                let et = self.expr()?;
                self.coerce(et, ty)?;
                self.expect_sym(';')?;
                let slot = self.n_locals;
                self.n_locals += ty.width();
                self.syms.insert(name, Sym { kind: SymKind::Local, slot, ty });
                self.emit(fx_vm_op::STORE_LOCAL);
                self.emit(slot);
                self.emit(ty.width());
                Ok(())
            }
            Tok::Ident(name) => {
                // assignment: name = expr;
                let sym = *self.syms.get(&name).ok_or_else(|| self.mkdiag("unknown identifier"))?;
                self.advance();
                self.expect_sym('=')?;
                let et = self.expr()?;
                self.coerce(et, sym.ty)?;
                self.expect_sym(';')?;
                let opc = match sym.kind {
                    SymKind::State => fx_vm_op::STORE_STATE,
                    SymKind::Local => fx_vm_op::STORE_LOCAL,
                    SymKind::Uniform => return self.err("cannot assign to a uniform"),
                };
                self.emit(opc);
                self.emit(sym.slot);
                self.emit(sym.ty.width());
                Ok(())
            }
            _ => self.err("expected statement"),
        }
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
        // Comparisons / logic -> Bool (scalars only in v1)
        if matches!(op, "<" | ">" | "<=" | ">=" | "==" | "!=") {
            if l.width() != 1 || r.width() != 1 {
                return self.err("comparison operands must be scalar");
            }
            let kind = match op {
                "<" => 0,
                "<=" => 1,
                ">" => 2,
                ">=" => 3,
                "==" => 4,
                _ => 5,
            };
            self.emit(fx_vm_op::CMP);
            self.emit(kind);
            return Ok(Ty::Bool);
        }
        if matches!(op, "&&" | "||") {
            self.emit(fx_vm_op::LOGIC);
            self.emit(if op == "&&" { 0 } else { 1 });
            return Ok(Ty::Bool);
        }
        // arithmetic. Note: operands already emitted (l then r on stack).
        if !l.is_num() || !r.is_num() {
            return self.err("arithmetic on non-numeric");
        }
        let lw = l.width();
        let rw = r.width();
        // vec * scalar / scalar * vec -> Scale (mul only)
        if op == "*" && lw > 1 && rw == 1 {
            self.emit(fx_vm_op::SCALE);
            self.emit(lw);
            return Ok(l);
        }
        if op == "*" && lw == 1 && rw > 1 {
            // stack is [scalar, vec]; Scale expects [vec, scalar]. Emit a swap
            // is awkward; instead broadcast the scalar was cheaper — but here we
            // reorder by recompiling isn't possible. Use element-wise after
            // broadcasting the scalar. Simpler: disallow and ask `vec * scalar`.
            return self.err("write `vec * scalar` (scalar on the right)");
        }
        // mixed widths for +,-,/ : broadcast scalar to vec width
        let (out_w, opc) = match op {
            "+" => (lw.max(rw), fx_vm_op::ADD),
            "-" => (lw.max(rw), fx_vm_op::SUB),
            "*" => (lw.max(rw), fx_vm_op::MUL),
            "/" => (lw.max(rw), fx_vm_op::DIV),
            _ => return self.err("bad operator"),
        };
        if lw != rw {
            return self.err("mismatched vector widths (broadcast: use vec*scalar for scaling)");
        }
        self.emit(opc);
        self.emit(out_w);
        Ok(Ty::vec_of(out_w))
    }

    fn unary(&mut self) -> Result<Ty, Diagnostic> {
        match self.cur().clone() {
            Tok::Sym('-') => {
                self.advance();
                let t = self.unary()?;
                self.emit(fx_vm_op::NEG);
                self.emit(t.width());
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
                let idx = self.const_idx(v);
                self.emit(fx_vm_op::PUSH_CONST);
                self.emit_u16(idx);
                Ok(if is_int { Ty::Int } else { Ty::Float })
            }
            Tok::Ident(id) if id == "true" || id == "false" => {
                self.advance();
                let idx = self.const_idx(if id == "true" { 1.0 } else { 0.0 });
                self.emit(fx_vm_op::PUSH_CONST);
                self.emit_u16(idx);
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
                    self.call(&id)
                } else {
                    self.load_ident(&id)
                }
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
        };
        self.emit(opc);
        self.emit(sym.slot);
        self.emit(sym.ty.width());
        Ok(sym.ty)
    }

    fn call(&mut self, name: &str) -> Result<Ty, Diagnostic> {
        self.expect_sym('(')?;
        // vecN constructor
        if let Some(cty) = Self::ty_from_ident(name) {
            let w = cty.width();
            let mut got = 0u8;
            loop {
                let at = self.expr()?;
                if at.width() == 1 {
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
                // broadcast: dup the scalar (w-1) more times via swizzle .xxx
                self.emit(fx_vm_op::SWIZZLE);
                self.emit(1);
                self.emit(w);
                for _ in 0..w {
                    self.emit(0);
                }
            } else if got != w {
                return self.err(format!("{name}() needs {w} components, got {got}"));
            }
            return Ok(cty);
        }
        // built-in functions
        let args = self.call_args()?;
        self.expect_sym(')')?;
        self.emit_builtin(name, &args)
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

    fn emit_builtin(&mut self, name: &str, args: &[Ty]) -> Result<Ty, Diagnostic> {
        use fx_vm_op::*;
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
            let a = self.arg1(args)?;
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
            self.emit(BIN_MATH);
            self.emit(f);
            self.emit(w);
            return Ok(Ty::vec_of(w));
        }
        match name {
            "clamp" => {
                self.need(args, 3)?;
                let w = args[0].width();
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
                self.arg1(args)?;
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
            _ => self.err(format!("unknown function '{name}'")),
        }
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

    fn emit_namespace(&mut self, ns: &str, field: &str) -> Result<Ty, Diagnostic> {
        let (id, ty) = match (ns, field) {
            ("led", "pos") => (fx_ctx::LED_POS, Ty::Vec3),
            ("led", "idx") => (fx_ctx::LED_IDX, Ty::Float),
            ("led", "count") => (fx_ctx::LED_COUNT, Ty::Float),
            ("led", "seg") => (fx_ctx::LED_SEG, Ty::Float),
            ("led", "s") => (fx_ctx::LED_S, Ty::Float),
            ("led", "branch") => (fx_ctx::LED_BRANCH, Ty::Bool),
            ("imu", "accel") => (fx_ctx::IMU_ACCEL, Ty::Vec3),
            ("imu", "gyro") => (fx_ctx::IMU_GYRO, Ty::Vec3),
            _ => return self.err(format!("no field {ns}.{field}")),
        };
        self.emit(fx_vm_op::LOAD_CTX);
        self.emit(id);
        Ok(ty)
    }

    fn coerce(&mut self, from: Ty, to: Ty) -> Result<(), Diagnostic> {
        if from == to {
            return Ok(());
        }
        // int/float interchangeable at the value level (both 1 slot)
        if from.width() == to.width() && from.is_num() && to.is_num() {
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
        b.extend_from_slice(b"FXB1");
        b.push(1); // version
        b.push(0); // flags
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
        b.extend_from_slice(&manifest);
        for c in &self.consts {
            b.extend_from_slice(&c.to_le_bytes());
        }
        b.extend_from_slice(&self.code);
        Compiled { fxb: b, uniforms: self.uniforms }
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
}
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
}
