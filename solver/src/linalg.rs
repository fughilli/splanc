//! Small fixed-size linear algebra (Vec3/Mat3) + a dense least-squares solve.
//!
//! Hand-rolled instead of pulling nalgebra: the solver's hot paths are all
//! 3-vectors/3x3s and one moderately sized dense normal-equations solve, and
//! zero external math deps keeps the wasm build small and the Bazel crate
//! graph trivial.

pub type Vec3 = [f64; 3];
pub type Mat3 = [[f64; 3]; 3];

pub const ZERO3: Vec3 = [0.0; 3];

pub fn add(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

pub fn sub(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

pub fn scale(a: Vec3, s: f64) -> Vec3 {
    [a[0] * s, a[1] * s, a[2] * s]
}

pub fn dot(a: Vec3, b: Vec3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

pub fn cross(a: Vec3, b: Vec3) -> Vec3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

pub fn norm(a: Vec3) -> f64 {
    dot(a, a).sqrt()
}

pub fn normalize(a: Vec3) -> Vec3 {
    let n = norm(a);
    if n == 0.0 {
        a
    } else {
        scale(a, 1.0 / n)
    }
}

pub const EYE3: Mat3 = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];

pub fn mat_vec(m: &Mat3, v: Vec3) -> Vec3 {
    [
        m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
        m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
        m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
    ]
}

/// m^T v (applies the inverse of a rotation).
pub fn mat_tvec(m: &Mat3, v: Vec3) -> Vec3 {
    [
        m[0][0] * v[0] + m[1][0] * v[1] + m[2][0] * v[2],
        m[0][1] * v[0] + m[1][1] * v[1] + m[2][1] * v[2],
        m[0][2] * v[0] + m[1][2] * v[1] + m[2][2] * v[2],
    ]
}

pub fn mat_mul(a: &Mat3, b: &Mat3) -> Mat3 {
    let mut out = [[0.0; 3]; 3];
    for (i, row) in out.iter_mut().enumerate() {
        for (j, cell) in row.iter_mut().enumerate() {
            *cell = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
        }
    }
    out
}

pub fn transpose(m: &Mat3) -> Mat3 {
    let mut out = [[0.0; 3]; 3];
    for (i, row) in out.iter_mut().enumerate() {
        for (j, cell) in row.iter_mut().enumerate() {
            *cell = m[j][i];
        }
    }
    out
}

pub fn trace(m: &Mat3) -> f64 {
    m[0][0] + m[1][1] + m[2][2]
}

/// Solve the symmetric positive-(semi)definite 3x3 system `a x = b` via
/// Cholesky with a relative ridge fallback. Errors when the system is too
/// close to singular to trust (the caller treats that like numpy's
/// LinAlgError paths — skip and move on).
pub fn solve3_spd(a: &Mat3, b: Vec3) -> Result<Vec3, &'static str> {
    let scale_ref = trace(a).abs().max(1e-300);
    let mut m = *a;
    for attempt in 0..2 {
        if attempt == 1 {
            for (k, row) in m.iter_mut().enumerate() {
                row[k] += 1e-9 * scale_ref;
            }
        }
        if let Some(l) = cholesky3(&m, 1e-12 * scale_ref) {
            return Ok(chol_solve3(&l, b));
        }
    }
    Err("singular 3x3 system")
}

fn cholesky3(a: &Mat3, min_pivot: f64) -> Option<Mat3> {
    let mut l = [[0.0; 3]; 3];
    for i in 0..3 {
        for j in 0..=i {
            let mut s = a[i][j];
            for k in 0..j {
                s -= l[i][k] * l[j][k];
            }
            if i == j {
                if s <= min_pivot {
                    return None;
                }
                l[i][j] = s.sqrt();
            } else {
                l[i][j] = s / l[j][j];
            }
        }
    }
    Some(l)
}

fn chol_solve3(l: &Mat3, b: Vec3) -> Vec3 {
    let mut y = [0.0; 3];
    for i in 0..3 {
        let mut s = b[i];
        for k in 0..i {
            s -= l[i][k] * y[k];
        }
        y[i] = s / l[i][i];
    }
    let mut x = [0.0; 3];
    for i in (0..3).rev() {
        let mut s = y[i];
        for k in (i + 1)..3 {
            s -= l[k][i] * x[k];
        }
        x[i] = s / l[i][i];
    }
    x
}

/// Dense least squares `min ||A x - b||` via normal equations + Cholesky with
/// a progressive ridge (the systems this solver builds are well-scaled; the
/// ridge only engages on genuinely rank-deficient corner cases, where numpy's
/// SVD lstsq would return the min-norm solution — close enough for the
/// initialization stages that use this).
pub struct DenseMat {
    pub rows: usize,
    pub cols: usize,
    pub data: Vec<f64>, // row-major
}

impl DenseMat {
    pub fn zeros(rows: usize, cols: usize) -> Self {
        DenseMat {
            rows,
            cols,
            data: vec![0.0; rows * cols],
        }
    }

    #[inline]
    pub fn at(&self, r: usize, c: usize) -> f64 {
        self.data[r * self.cols + c]
    }

    #[inline]
    pub fn set(&mut self, r: usize, c: usize, v: f64) {
        self.data[r * self.cols + c] = v;
    }
}

pub fn lstsq_dense(a: &DenseMat, b: &[f64]) -> Vec<f64> {
    let n = a.cols;
    // Normal equations: G = A^T A, h = A^T b.
    let mut g = vec![0.0; n * n];
    let mut h = vec![0.0; n];
    for r in 0..a.rows {
        let row = &a.data[r * n..(r + 1) * n];
        for i in 0..n {
            let ri = row[i];
            if ri == 0.0 {
                continue;
            }
            h[i] += ri * b[r];
            for (j, rj) in row.iter().enumerate().skip(i) {
                g[i * n + j] += ri * rj;
            }
        }
    }
    for i in 0..n {
        for j in 0..i {
            g[i * n + j] = g[j * n + i];
        }
    }
    let mut ridge = 0.0;
    let scale_ref: f64 = (0..n).map(|i| g[i * n + i]).sum::<f64>().max(1e-300) / n as f64;
    loop {
        if let Some(x) = cholesky_solve_dense(&g, &h, n, ridge) {
            return x;
        }
        ridge = if ridge == 0.0 {
            1e-12 * scale_ref
        } else {
            ridge * 100.0
        };
        assert!(
            ridge < scale_ref,
            "lstsq_dense: system irrecoverably singular"
        );
    }
}

/// Least squares over sparse rows (each row a list of (col, val)): the
/// normal-equations assembly skips zeros, so long thin block-sparse systems
/// (the inertial alignment) stay cheap. Same Cholesky+ridge core as
/// `lstsq_dense`.
pub fn lstsq_rows(rows: &[Vec<(usize, f64)>], b: &[f64], n_cols: usize) -> Vec<f64> {
    let n = n_cols;
    let mut g = vec![0.0; n * n];
    let mut h = vec![0.0; n];
    for (r, row) in rows.iter().enumerate() {
        for &(i, vi) in row {
            h[i] += vi * b[r];
            for &(j, vj) in row {
                if j >= i {
                    g[i * n + j] += vi * vj;
                }
            }
        }
    }
    for i in 0..n {
        for j in 0..i {
            g[i * n + j] = g[j * n + i];
        }
    }
    let mut ridge = 0.0;
    let scale_ref: f64 = (0..n).map(|i| g[i * n + i]).sum::<f64>().max(1e-300) / n as f64;
    loop {
        if let Some(x) = cholesky_solve_dense(&g, &h, n, ridge) {
            return x;
        }
        ridge = if ridge == 0.0 {
            1e-12 * scale_ref
        } else {
            ridge * 100.0
        };
        assert!(
            ridge < scale_ref,
            "lstsq_rows: system irrecoverably singular"
        );
    }
}

fn cholesky_solve_dense(g: &[f64], h: &[f64], n: usize, ridge: f64) -> Option<Vec<f64>> {
    let mut l = vec![0.0; n * n];
    for i in 0..n {
        for j in 0..=i {
            let mut s = g[i * n + j] + if i == j { ridge } else { 0.0 };
            for k in 0..j {
                s -= l[i * n + k] * l[j * n + k];
            }
            if i == j {
                if s <= 0.0 {
                    return None;
                }
                l[i * n + i] = s.sqrt();
            } else {
                l[i * n + j] = s / l[j * n + j];
            }
        }
    }
    let mut y = vec![0.0; n];
    for i in 0..n {
        let mut s = h[i];
        for k in 0..i {
            s -= l[i * n + k] * y[k];
        }
        y[i] = s / l[i * n + i];
    }
    let mut x = vec![0.0; n];
    for i in (0..n).rev() {
        let mut s = y[i];
        for k in (i + 1)..n {
            s -= l[k * n + i] * x[k];
        }
        x[i] = s / l[i * n + i];
    }
    Some(x)
}

/// Eigendecomposition of a symmetric 3x3 via cyclic Jacobi rotations.
/// Returns (eigenvalues, eigenvectors-as-columns), descending order.
pub fn eig_sym3(a: &Mat3) -> (Vec3, Mat3) {
    let mut m = *a;
    let mut v = EYE3;
    for _ in 0..50 {
        // Largest off-diagonal element.
        let mut p = 0;
        let mut q = 1;
        let mut max = m[0][1].abs();
        if m[0][2].abs() > max {
            p = 0;
            q = 2;
            max = m[0][2].abs();
        }
        if m[1][2].abs() > max {
            p = 1;
            q = 2;
            max = m[1][2].abs();
        }
        if max < 1e-15 * (trace(&m).abs() + 1e-300) {
            break;
        }
        let theta = 0.5 * (m[q][q] - m[p][p]) / m[p][q];
        let t = theta.signum() / (theta.abs() + (theta * theta + 1.0).sqrt());
        let c = 1.0 / (t * t + 1.0).sqrt();
        let s = t * c;
        // Apply the rotation G(p, q, θ) on both sides of m and accumulate v.
        let mut g = EYE3;
        g[p][p] = c;
        g[q][q] = c;
        g[p][q] = s;
        g[q][p] = -s;
        m = mat_mul(&transpose(&g), &mat_mul(&m, &g));
        v = mat_mul(&v, &g);
    }
    // Sort descending.
    let mut idx = [0usize, 1, 2];
    idx.sort_by(|&i, &j| m[j][j].partial_cmp(&m[i][i]).unwrap());
    let vals = [m[idx[0]][idx[0]], m[idx[1]][idx[1]], m[idx[2]][idx[2]]];
    let mut vecs = [[0.0; 3]; 3];
    for (col, &src) in idx.iter().enumerate() {
        for row in 0..3 {
            vecs[row][col] = v[row][src];
        }
    }
    (vals, vecs)
}

/// SVD of a general 3x3: a = U diag(s) V^T (singular values descending).
pub fn svd3(a: &Mat3) -> (Mat3, Vec3, Mat3) {
    let ata = mat_mul(&transpose(a), a);
    let (evals, v) = eig_sym3(&ata);
    let s = [
        evals[0].max(0.0).sqrt(),
        evals[1].max(0.0).sqrt(),
        evals[2].max(0.0).sqrt(),
    ];
    let av = mat_mul(a, &v);
    let mut u = [[0.0; 3]; 3];
    for c in 0..3 {
        let col = [av[0][c], av[1][c], av[2][c]];
        let col = if s[c] > 1e-12 * s[0].max(1e-300) {
            scale(col, 1.0 / s[c])
        } else {
            // Complete an orthonormal basis from the earlier columns.
            let u0 = [u[0][0], u[1][0], u[2][0]];
            let u1 = [u[0][1], u[1][1], u[2][1]];
            normalize(cross(u0, u1))
        };
        for r in 0..3 {
            u[r][c] = col[r];
        }
    }
    (u, s, transpose(&v))
}

pub fn det3(m: &Mat3) -> f64 {
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn svd3_reconstructs_matrix() {
        let a: Mat3 = [[0.5, -1.2, 0.3], [2.0, 0.1, -0.7], [-0.4, 0.9, 1.5]];
        let (u, s, vt) = svd3(&a);
        let mut recon = [[0.0; 3]; 3];
        for i in 0..3 {
            for j in 0..3 {
                for k in 0..3 {
                    recon[i][j] += u[i][k] * s[k] * vt[k][j];
                }
            }
        }
        for i in 0..3 {
            for j in 0..3 {
                assert!((recon[i][j] - a[i][j]).abs() < 1e-9, "{recon:?}");
            }
        }
        assert!(s[0] >= s[1] && s[1] >= s[2] && s[2] >= 0.0);
    }

    #[test]
    fn lstsq_recovers_exact_solution() {
        // Overdetermined consistent system.
        let mut a = DenseMat::zeros(4, 2);
        let xs = [0.0, 1.0, 2.0, 3.0];
        for (r, x) in xs.iter().enumerate() {
            a.set(r, 0, 1.0);
            a.set(r, 1, *x);
        }
        let b: Vec<f64> = xs.iter().map(|x| 2.0 + 0.5 * x).collect();
        let sol = lstsq_dense(&a, &b);
        assert!((sol[0] - 2.0).abs() < 1e-12 && (sol[1] - 0.5).abs() < 1e-12);
    }

    #[test]
    fn solve3_spd_matches_direct() {
        let a: Mat3 = [[4.0, 1.0, 0.5], [1.0, 3.0, 0.2], [0.5, 0.2, 2.0]];
        let x_true = [1.0, -2.0, 0.5];
        let b = mat_vec(&a, x_true);
        let x = solve3_spd(&a, b).unwrap();
        for i in 0..3 {
            assert!((x[i] - x_true[i]).abs() < 1e-10);
        }
    }
}
