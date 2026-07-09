//! SO(3) exp/log (Rodrigues) — port of vio.py's helpers, including the
//! small-angle series guards and the near-π branch of `so3_log`.

use crate::linalg::{norm, scale, Mat3, Vec3, EYE3};

pub fn skew(v: Vec3) -> Mat3 {
    [[0.0, -v[2], v[1]], [v[2], 0.0, -v[0]], [-v[1], v[0], 0.0]]
}

pub fn unskew(m: &Mat3) -> Vec3 {
    [m[2][1], m[0][2], m[1][0]]
}

pub fn so3_exp(r: Vec3) -> Mat3 {
    let theta = norm(r);
    let theta2 = theta * theta;
    // Series-guarded coefficients (matches so3_exp_batch in the reference).
    let (a, b) = if theta > 1e-8 {
        (theta.sin() / theta, (1.0 - theta.cos()) / theta2)
    } else {
        (1.0 - theta2 / 6.0, 0.5 - theta2 / 24.0)
    };
    let kx = skew(r);
    let mut out = EYE3;
    for i in 0..3 {
        for j in 0..3 {
            let kx2 = kx[i][0] * kx[0][j] + kx[i][1] * kx[1][j] + kx[i][2] * kx[2][j];
            out[i][j] += a * kx[i][j] + b * kx2;
        }
    }
    out
}

pub fn so3_log(rot: &Mat3) -> Vec3 {
    let tr = rot[0][0] + rot[1][1] + rot[2][2];
    let cos_theta = ((tr - 1.0) / 2.0).clamp(-1.0, 1.0);
    let theta = cos_theta.acos();
    let w = [
        rot[2][1] - rot[1][2],
        rot[0][2] - rot[2][0],
        rot[1][0] - rot[0][1],
    ];
    if theta < 1e-9 {
        return scale(w, 0.5);
    }
    if (std::f64::consts::PI - theta).abs() < 1e-6 {
        // Near π: extract the axis from the symmetric part.
        let mut axis = [0.0; 3];
        for (i, ax) in axis.iter_mut().enumerate() {
            *ax = ((rot[i][i] + 1.0) / 2.0).max(0.0).sqrt();
        }
        let n = norm(axis) + 1e-15;
        axis = scale(axis, 1.0 / n);
        let m01 = (rot[0][1] + rot[1][0]) / 2.0;
        let m02 = (rot[0][2] + rot[2][0]) / 2.0;
        if m01 < 0.0 {
            axis[1] = -axis[1];
        }
        if m02 < 0.0 {
            axis[2] = -axis[2];
        }
        return scale(axis, theta);
    }
    scale(w, theta / (2.0 * theta.sin()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::linalg::{mat_mul, transpose};

    fn assert_mat_close(a: &Mat3, b: &Mat3, tol: f64) {
        for i in 0..3 {
            for j in 0..3 {
                assert!((a[i][j] - b[i][j]).abs() < tol, "{a:?} vs {b:?}");
            }
        }
    }

    #[test]
    fn exp_log_roundtrip() {
        for r in [
            [0.1, -0.2, 0.3],
            [1e-10, 0.0, 0.0],
            [0.0, 3.14, 0.0],
            [2.0, 1.0, -0.5],
        ] {
            let rot = so3_exp(r);
            let back = so3_exp(so3_log(&rot));
            assert_mat_close(&rot, &back, 1e-9);
        }
    }

    #[test]
    fn exp_is_orthonormal() {
        let rot = so3_exp([0.4, -1.1, 0.7]);
        let should_be_eye = mat_mul(&rot, &transpose(&rot));
        assert_mat_close(&should_be_eye, &crate::linalg::EYE3, 1e-12);
    }
}
