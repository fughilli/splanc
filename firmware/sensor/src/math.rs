//! Minimal f32 vector/quaternion math, `no_std` and libm-free.
//!
//! Conventions match indoor_localization's `swarm/core` (`math.rs`) so its
//! estimator can be dropped in behind [`crate::fusion::AttitudeFilter`]:
//! quaternions are scalar-first `[w, x, y, z]`, `q` rotates BODY (fixture)
//! vectors into the WORLD frame (`v_world = q * v_body * q^-1`), world is
//! z-up, and an accelerometer at rest reads `+g` along world up (the gravity
//! *reaction*, i.e. specific force).
//!
//! The C6 has no FPU: every f32 op here is a libgcc soft-float call, so the
//! helpers avoid divisions and square roots where a multiply will do
//! (`inv_sqrt` is a bit-seed + Newton, no `sqrtf`).

/// Standard gravity, m/s² (same constant as swarm_core::estimator::GRAVITY).
pub const GRAVITY: f32 = 9.80665;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Vec3 {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

impl Vec3 {
    pub const ZERO: Vec3 = Vec3 { x: 0.0, y: 0.0, z: 0.0 };
    pub const UP: Vec3 = Vec3 { x: 0.0, y: 0.0, z: 1.0 };

    pub const fn new(x: f32, y: f32, z: f32) -> Vec3 {
        Vec3 { x, y, z }
    }
    pub fn from_array(a: [f32; 3]) -> Vec3 {
        Vec3::new(a[0], a[1], a[2])
    }
    pub fn to_array(self) -> [f32; 3] {
        [self.x, self.y, self.z]
    }
    pub fn add(self, o: Vec3) -> Vec3 {
        Vec3::new(self.x + o.x, self.y + o.y, self.z + o.z)
    }
    pub fn sub(self, o: Vec3) -> Vec3 {
        Vec3::new(self.x - o.x, self.y - o.y, self.z - o.z)
    }
    pub fn scale(self, s: f32) -> Vec3 {
        Vec3::new(self.x * s, self.y * s, self.z * s)
    }
    pub fn mul(self, o: Vec3) -> Vec3 {
        Vec3::new(self.x * o.x, self.y * o.y, self.z * o.z)
    }
    pub fn dot(self, o: Vec3) -> f32 {
        self.x * o.x + self.y * o.y + self.z * o.z
    }
    pub fn cross(self, o: Vec3) -> Vec3 {
        Vec3::new(
            self.y * o.z - self.z * o.y,
            self.z * o.x - self.x * o.z,
            self.x * o.y - self.y * o.x,
        )
    }
    pub fn norm2(self) -> f32 {
        self.dot(self)
    }
    pub fn norm(self) -> f32 {
        let n2 = self.norm2();
        n2 * inv_sqrt(n2)
    }
}

/// 1/sqrt(x) for x > 0 (0 for x <= 0): bit-level seed + two Newton steps,
/// relative error < 5e-6 — far below MEMS noise.
pub fn inv_sqrt(x: f32) -> f32 {
    if x <= 0.0 {
        return 0.0;
    }
    let mut y = f32::from_bits(0x5f37_59df - (x.to_bits() >> 1));
    y = y * (1.5 - 0.5 * x * y * y);
    y * (1.5 - 0.5 * x * y * y)
}

pub fn sqrt(x: f32) -> f32 {
    x * inv_sqrt(x)
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Quat {
    pub w: f32,
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

impl Default for Quat {
    fn default() -> Quat {
        Quat::IDENTITY
    }
}

impl Quat {
    pub const IDENTITY: Quat = Quat { w: 1.0, x: 0.0, y: 0.0, z: 0.0 };

    pub const fn new(w: f32, x: f32, y: f32, z: f32) -> Quat {
        Quat { w, x, y, z }
    }
    pub fn from_array(a: [f32; 4]) -> Quat {
        Quat::new(a[0], a[1], a[2], a[3])
    }
    pub fn to_array(self) -> [f32; 4] {
        [self.w, self.x, self.y, self.z]
    }
    pub fn mul(self, o: Quat) -> Quat {
        Quat::new(
            self.w * o.w - self.x * o.x - self.y * o.y - self.z * o.z,
            self.w * o.x + self.x * o.w + self.y * o.z - self.z * o.y,
            self.w * o.y - self.x * o.z + self.y * o.w + self.z * o.x,
            self.w * o.z + self.x * o.y - self.y * o.x + self.z * o.w,
        )
    }
    pub fn conj(self) -> Quat {
        Quat::new(self.w, -self.x, -self.y, -self.z)
    }
    pub fn normalized(self) -> Quat {
        let n2 = self.w * self.w + self.x * self.x + self.y * self.y + self.z * self.z;
        if n2 <= 0.0 {
            return Quat::IDENTITY;
        }
        let k = inv_sqrt(n2);
        Quat::new(self.w * k, self.x * k, self.y * k, self.z * k)
    }
    /// Rotate a body vector into the world frame.
    pub fn rotate(self, v: Vec3) -> Vec3 {
        // v + 2w(u x v) + 2u x (u x v), u = (x, y, z): 15 mul + 15 add.
        let u = Vec3::new(self.x, self.y, self.z);
        let t = u.cross(v).scale(2.0);
        v.add(t.scale(self.w)).add(u.cross(t))
    }
    /// Rotate a world vector into the body frame.
    pub fn rotate_inv(self, v: Vec3) -> Vec3 {
        self.conj().rotate(v)
    }
    /// The world "up" axis expressed in the body frame (third row of R) —
    /// 6 mul, cheaper than `rotate_inv(UP)`.
    pub fn up_in_body(self) -> Vec3 {
        Vec3::new(
            2.0 * (self.x * self.z - self.w * self.y),
            2.0 * (self.y * self.z + self.w * self.x),
            self.w * self.w - self.x * self.x - self.y * self.y + self.z * self.z,
        )
    }
    /// Shortest-arc rotation taking unit vector `from` onto unit vector `to`.
    pub fn from_two_unit(from: Vec3, to: Vec3) -> Quat {
        let d = from.dot(to);
        if d < -0.999_999 {
            // Antiparallel: 180° about any axis orthogonal to `from`.
            let axis = if from.x.abs() < 0.9 { Vec3::new(1.0, 0.0, 0.0) } else { Vec3::new(0.0, 1.0, 0.0) };
            let a = from.cross(axis);
            return Quat::new(0.0, a.x, a.y, a.z).normalized();
        }
        let c = from.cross(to);
        Quat::new(1.0 + d, c.x, c.y, c.z).normalized()
    }
    /// Axis-angle (radians) — tests and calibration only (uses a Taylor
    /// sin/cos good to ~1e-4 for |angle| <= pi).
    pub fn from_axis_angle(axis: Vec3, angle: f32) -> Quat {
        let h = 0.5 * angle;
        let (s, c) = sin_cos_small(h);
        let a = axis.scale(inv_sqrt(axis.norm2()));
        Quat::new(c, a.x * s, a.y * s, a.z * s)
    }
    /// Angle between two orientations, radians (tests/diagnostics).
    pub fn angle_to(self, o: Quat) -> f32 {
        let d = self.conj().mul(o);
        let v = sqrt(d.x * d.x + d.y * d.y + d.z * d.z);
        2.0 * atan_pos(v, d.w.abs())
    }
}

/// sin/cos for |a| <= pi/2 (Taylor to x^9; error < 4e-6).
fn sin_cos_small(a: f32) -> (f32, f32) {
    let a2 = a * a;
    let s = a * (1.0 - a2 / 6.0 * (1.0 - a2 / 20.0 * (1.0 - a2 / 42.0 * (1.0 - a2 / 72.0))));
    let c = 1.0 - a2 / 2.0 * (1.0 - a2 / 12.0 * (1.0 - a2 / 30.0 * (1.0 - a2 / 56.0)));
    (s, c)
}

/// atan on [0, 1]: 11th-order minimax, |error| < 1e-5 rad.
fn atan_unit(a: f32) -> f32 {
    let a2 = a * a;
    a * (0.999_977_26
        + a2 * (-0.332_623_47 + a2 * (0.193_543_46 + a2 * (-0.116_432_87 + a2 * (0.052_653_32 + a2 * -0.011_721_20)))))
}

/// atan2(y, x) for y >= 0, x >= 0.
fn atan_pos(y: f32, x: f32) -> f32 {
    if y == 0.0 && x == 0.0 {
        return 0.0;
    }
    if y > x {
        core::f32::consts::FRAC_PI_2 - atan_unit(x / y)
    } else {
        atan_unit(y / x)
    }
}

/// Full-quadrant atan2, |error| < 1e-5 rad, no libm.
pub fn atan2(y: f32, x: f32) -> f32 {
    let r = atan_pos(y.abs(), x.abs());
    let r = if x < 0.0 { core::f32::consts::PI - r } else { r };
    if y < 0.0 {
        -r
    } else {
        r
    }
}

/// asin, input clamped to [-1, 1].
pub fn asin(x: f32) -> f32 {
    let x = x.clamp(-1.0, 1.0);
    atan2(x, sqrt(1.0 - x * x))
}

impl Quat {
    /// Intrinsic Z-Y-X (yaw, pitch, roll) Euler angles of this body->world
    /// rotation, returned as [roll, pitch, yaw] radians (aerospace order).
    /// Pitch saturates at ±pi/2 (gimbal lock); prefer the quaternion or the
    /// gravity vector in effects.
    pub fn to_euler(self) -> [f32; 3] {
        let (w, x, y, z) = (self.w, self.x, self.y, self.z);
        let roll = atan2(2.0 * (w * x + y * z), 1.0 - 2.0 * (x * x + y * y));
        let pitch = asin(2.0 * (w * y - z * x));
        let yaw = atan2(2.0 * (w * z + x * y), 1.0 - 2.0 * (y * y + z * z));
        [roll, pitch, yaw]
    }
}
