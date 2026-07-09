//! Quaternion <-> rotation matrix, matching reconstruction/camera.py exactly
//! (camera-to-world, `[x, y, z, w]` order).

use crate::linalg::{Mat3, Vec3};

pub type Quat = [f64; 4];

pub fn quat_to_rotmat(q: Quat) -> Mat3 {
    let [x, y, z, w] = q;
    let n = x * x + y * y + z * z + w * w;
    let s = if n == 0.0 { 0.0 } else { 2.0 / n };
    let (xx, yy, zz) = (x * x * s, y * y * s, z * z * s);
    let (xy, xz, yz) = (x * y * s, x * z * s, y * z * s);
    let (wx, wy, wz) = (w * x * s, w * y * s, w * z * s);
    [
        [1.0 - (yy + zz), xy - wz, xz + wy],
        [xy + wz, 1.0 - (xx + zz), yz - wx],
        [xz - wy, yz + wx, 1.0 - (xx + yy)],
    ]
}

pub fn rotmat_to_quat(m: &Mat3) -> Quat {
    let t = m[0][0] + m[1][1] + m[2][2];
    let (x, y, z, w);
    if t > 0.0 {
        let s = (t + 1.0).sqrt() * 2.0;
        w = 0.25 * s;
        x = (m[2][1] - m[1][2]) / s;
        y = (m[0][2] - m[2][0]) / s;
        z = (m[1][0] - m[0][1]) / s;
    } else if m[0][0] > m[1][1] && m[0][0] > m[2][2] {
        let s = (1.0 + m[0][0] - m[1][1] - m[2][2]).sqrt() * 2.0;
        w = (m[2][1] - m[1][2]) / s;
        x = 0.25 * s;
        y = (m[0][1] + m[1][0]) / s;
        z = (m[0][2] + m[2][0]) / s;
    } else if m[1][1] > m[2][2] {
        let s = (1.0 + m[1][1] - m[0][0] - m[2][2]).sqrt() * 2.0;
        w = (m[0][2] - m[2][0]) / s;
        x = (m[0][1] + m[1][0]) / s;
        y = 0.25 * s;
        z = (m[1][2] + m[2][1]) / s;
    } else {
        let s = (1.0 + m[2][2] - m[0][0] - m[1][1]).sqrt() * 2.0;
        w = (m[1][0] - m[0][1]) / s;
        x = (m[0][2] + m[2][0]) / s;
        y = (m[1][2] + m[2][1]) / s;
        z = 0.25 * s;
    }
    let n = (x * x + y * y + z * z + w * w).sqrt();
    [x / n, y / n, z / n, w / n]
}

/// Back-projected unit ray direction in world space (camera looks down -Z,
/// image v grows downward). Port of camera.back_project_ray.
pub fn back_project_dir(rot: &Mat3, k: [f64; 4], u: f64, v: f64) -> Vec3 {
    let [fx, fy, cx, cy] = k;
    let d_cam = [(u - cx) / fx, -(v - cy) / fy, -1.0];
    crate::linalg::normalize(crate::linalg::mat_vec(rot, d_cam))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::so3::so3_exp;

    #[test]
    fn quat_matrix_roundtrip() {
        for r in [[0.3, -0.6, 0.2], [2.5, 0.1, -1.0], [0.0, 0.0, 0.0]] {
            let m = so3_exp(r);
            let q = rotmat_to_quat(&m);
            let back = quat_to_rotmat(q);
            for i in 0..3 {
                for j in 0..3 {
                    assert!((m[i][j] - back[i][j]).abs() < 1e-12);
                }
            }
        }
    }
}
