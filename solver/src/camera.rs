//! Pinhole projection + look-at, matching reconstruction/camera.py
//! conventions (camera-to-world pose, -Z look, image v grows downward).
//! Used by the pipeline's quality metrics and the synthetic benchmark
//! problem; the solver's hot path inlines its own projection.

use crate::linalg::{cross, mat_tvec, normalize, sub, Mat3, Vec3};

/// Project a world point; returns (u, v, depth). Depth <= 0 means behind.
pub fn project(rot: &Mat3, p: Vec3, k: [f64; 4], x: Vec3) -> (f64, f64, f64) {
    let xc = mat_tvec(rot, sub(x, p));
    let depth = -xc[2];
    let safe = if depth.abs() < 1e-12 { 1e-12 } else { depth };
    let [fx, fy, cx, cy] = k;
    (cx + fx * xc[0] / safe, cy - fy * xc[1] / safe, depth)
}

/// Camera-to-world rotation looking from `eye` toward `target` (y-up).
pub fn look_at(eye: Vec3, target: Vec3) -> Mat3 {
    let forward = normalize(sub(target, eye));
    let mut up = [0.0, 1.0, 0.0];
    let mut right = cross(forward, up);
    let rn = crate::linalg::norm(right);
    if rn < 1e-9 {
        up = if forward[1].abs() > 0.9 {
            [1.0, 0.0, 0.0]
        } else {
            [0.0, 1.0, 0.0]
        };
        right = cross(forward, up);
    }
    let right = normalize(right);
    let true_up = cross(right, forward);
    // Columns: right, up, -forward (camera +Z away from scene).
    [
        [right[0], true_up[0], -forward[0]],
        [right[1], true_up[1], -forward[1]],
        [right[2], true_up[2], -forward[2]],
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quat::back_project_dir;

    #[test]
    fn project_backproject_roundtrip() {
        let rot = look_at([1.0, 0.5, 2.0], [0.0, 0.0, 0.0]);
        let p = [1.0, 0.5, 2.0];
        let k = [800.0, 800.0, 640.0, 360.0];
        let x = [0.1, -0.2, 0.05];
        let (u, v, depth) = project(&rot, p, k, x);
        assert!(depth > 0.0);
        let dir = back_project_dir(&rot, k, u, v);
        // x should lie on p + t*dir.
        let t = crate::linalg::dot(sub(x, p), dir);
        let on_ray = crate::linalg::add(p, crate::linalg::scale(dir, t));
        for i in 0..3 {
            assert!((on_ray[i] - x[i]).abs() < 1e-9);
        }
    }
}
