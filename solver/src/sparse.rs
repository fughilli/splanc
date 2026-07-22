//! Column-compressed sparse matrix + LSMR (Fong & Saunders).
//!
//! One iterative least-squares kernel serves both places the Python
//! reference used one: the known-rotation linear init (scipy.sparse lsqr —
//! LSMR solves the same problem) and the LM trust-region subproblem
//! (scipy least_squares tr_solver="lsmr"). LSMR's built-in `damp` gives the
//! Levenberg damping for free: min ||A x − b||² + damp²·||x||².

/// CSC storage: the finite-difference Jacobian fills naturally column-by-
/// column, and both matvec (scatter) and rmatvec (gather) are cheap.
pub struct Csc {
    pub rows: usize,
    pub cols: usize,
    pub indptr: Vec<usize>,  // len cols+1
    pub indices: Vec<usize>, // row index per nnz
    pub data: Vec<f64>,
}

impl Csc {
    /// Build the structure (data zeroed) from per-column sorted row lists.
    pub fn from_pattern(rows: usize, col_rows: &[Vec<usize>]) -> Csc {
        let cols = col_rows.len();
        let mut indptr = Vec::with_capacity(cols + 1);
        indptr.push(0);
        let mut indices = Vec::new();
        for rs in col_rows {
            indices.extend_from_slice(rs);
            indptr.push(indices.len());
        }
        let nnz = indices.len();
        Csc {
            rows,
            cols,
            indptr,
            indices,
            data: vec![0.0; nnz],
        }
    }

    pub fn from_triplets(rows: usize, cols: usize, triplets: &[(usize, usize, f64)]) -> Csc {
        let mut per_col: Vec<Vec<(usize, f64)>> = vec![Vec::new(); cols];
        for &(r, c, v) in triplets {
            per_col[c].push((r, v));
        }
        let mut indptr = Vec::with_capacity(cols + 1);
        indptr.push(0);
        let mut indices = Vec::new();
        let mut data = Vec::new();
        for entries in per_col.iter_mut() {
            entries.sort_by_key(|e| e.0);
            // Sum duplicates (the linear init emits += triplets).
            let mut i = 0;
            while i < entries.len() {
                let r = entries[i].0;
                let mut v = entries[i].1;
                let mut j = i + 1;
                while j < entries.len() && entries[j].0 == r {
                    v += entries[j].1;
                    j += 1;
                }
                indices.push(r);
                data.push(v);
                i = j;
            }
            indptr.push(indices.len());
        }
        Csc {
            rows,
            cols,
            indptr,
            indices,
            data,
        }
    }

    /// y = A x, with per-column scaling: y = A diag(1/col_scale) x when
    /// `col_scale` is provided (the LM subproblem's variable scaling).
    pub fn matvec(&self, x: &[f64], col_scale: Option<&[f64]>, y: &mut [f64]) {
        y.fill(0.0);
        for c in 0..self.cols {
            let xc = match col_scale {
                Some(d) => x[c] / d[c],
                None => x[c],
            };
            if xc == 0.0 {
                continue;
            }
            for k in self.indptr[c]..self.indptr[c + 1] {
                y[self.indices[k]] += self.data[k] * xc;
            }
        }
    }

    /// z = A^T u (scaled like matvec when col_scale is provided).
    pub fn rmatvec(&self, u: &[f64], col_scale: Option<&[f64]>, z: &mut [f64]) {
        for c in 0..self.cols {
            let mut s = 0.0;
            for k in self.indptr[c]..self.indptr[c + 1] {
                s += self.data[k] * u[self.indices[k]];
            }
            z[c] = match col_scale {
                Some(d) => s / d[c],
                None => s,
            };
        }
    }

    /// Euclidean norm of each column.
    pub fn col_norms(&self) -> Vec<f64> {
        (0..self.cols)
            .map(|c| {
                self.data[self.indptr[c]..self.indptr[c + 1]]
                    .iter()
                    .map(|v| v * v)
                    .sum::<f64>()
                    .sqrt()
            })
            .collect()
    }
}

fn dnorm(v: &[f64]) -> f64 {
    v.iter().map(|x| x * x).sum::<f64>().sqrt()
}

/// LSMR: min ||A x − b||² + damp²||x||². Port of the scipy implementation's
/// core recurrences and its normr/normar stopping estimates (condition-number
/// stopping omitted — the systems here are pre-scaled).
pub fn lsmr(
    a: &Csc,
    col_scale: Option<&[f64]>,
    b: &[f64],
    damp: f64,
    atol: f64,
    btol: f64,
    max_iter: usize,
) -> Vec<f64> {
    let (m, n) = (a.rows, a.cols);
    let mut u = b.to_vec();
    let normb = dnorm(&u);
    let mut x = vec![0.0; n];
    let mut beta = normb;
    if beta > 0.0 {
        u.iter_mut().for_each(|e| *e /= beta);
    }
    let mut v = vec![0.0; n];
    let mut alpha = 0.0;
    if beta > 0.0 {
        a.rmatvec(&u, col_scale, &mut v);
        alpha = dnorm(&v);
        if alpha > 0.0 {
            v.iter_mut().for_each(|e| *e /= alpha);
        }
    }
    if alpha * beta == 0.0 {
        return x;
    }

    let mut zetabar = alpha * beta;
    let mut alphabar = alpha;
    let mut rho = 1.0;
    let mut rhobar = 1.0;
    let mut cbar = 1.0;
    let mut sbar = 0.0;

    let mut h = v.clone();
    let mut hbar = vec![0.0; n];

    // Stopping-estimate state.
    let mut betadd = beta;
    let mut betad = 0.0;
    let mut rhodold = 1.0;
    let mut tautildeold = 0.0;
    let mut thetatilde = 0.0;
    let mut zeta = 0.0;
    let mut d = 0.0;
    let mut norm_a2 = alpha * alpha;

    let mut tmp_m = vec![0.0; m];
    let mut tmp_n = vec![0.0; n];

    for _ in 0..max_iter {
        // Bidiagonalization.
        a.matvec(&v, col_scale, &mut tmp_m);
        for i in 0..m {
            u[i] = tmp_m[i] - alpha * u[i];
        }
        beta = dnorm(&u);
        if beta > 0.0 {
            u.iter_mut().for_each(|e| *e /= beta);
            a.rmatvec(&u, col_scale, &mut tmp_n);
            for i in 0..n {
                v[i] = tmp_n[i] - beta * v[i];
            }
            alpha = dnorm(&v);
            if alpha > 0.0 {
                v.iter_mut().for_each(|e| *e /= alpha);
            }
        }

        // Rotation to eliminate the damping parameter.
        let alphahat = (alphabar * alphabar + damp * damp).sqrt();
        let chat = alphabar / alphahat;
        let shat = damp / alphahat;

        // Plane rotations.
        let rhoold = rho;
        rho = (alphahat * alphahat + beta * beta).sqrt();
        let c = alphahat / rho;
        let s = beta / rho;
        let thetanew = s * alpha;
        alphabar = c * alpha;

        let rhobarold = rhobar;
        let zetaold = zeta;
        let thetabar = sbar * rho;
        let rhotemp = cbar * rho;
        rhobar = (rhotemp * rhotemp + thetanew * thetanew).sqrt();
        cbar = rhotemp / rhobar;
        sbar = thetanew / rhobar;
        zeta = cbar * zetabar;
        zetabar = -sbar * zetabar;

        // Update h, hbar, x.
        let hbar_coeff = thetabar * rho / (rhoold * rhobarold);
        let x_coeff = zeta / (rho * rhobar);
        let h_coeff = thetanew / rho;
        for i in 0..n {
            hbar[i] = h[i] - hbar_coeff * hbar[i];
            x[i] += x_coeff * hbar[i];
            h[i] = v[i] - h_coeff * h[i];
        }

        // Residual-norm estimates.
        let betaacute = chat * betadd;
        let betacheck = -shat * betadd;
        let betahat = c * betaacute;
        betadd = -s * betaacute;

        let thetatildeold = thetatilde;
        let rhotildeold = (rhodold * rhodold + thetabar * thetabar).sqrt();
        let ctildeold = rhodold / rhotildeold;
        let stildeold = thetabar / rhotildeold;
        thetatilde = stildeold * rhobar;
        rhodold = ctildeold * rhobar;
        betad = -stildeold * betad + ctildeold * betahat;

        tautildeold = (zetaold - thetatildeold * tautildeold) / rhotildeold;
        let taud = (zeta - thetatilde * tautildeold) / rhodold;
        d += betacheck * betacheck;
        let normr = (d + (betad - taud) * (betad - taud) + betadd * betadd).sqrt();

        norm_a2 += beta * beta;
        let norm_a = norm_a2.sqrt();
        norm_a2 += alpha * alpha;
        let normar = zetabar.abs();

        if normar <= atol * norm_a * normr {
            break;
        }
        if normr <= btol * normb + atol * norm_a * dnorm(&x) {
            break;
        }
    }

    if let Some(dsc) = col_scale {
        for i in 0..n {
            x[i] /= dsc[i];
        }
    }
    x
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lsmr_solves_overdetermined_system() {
        // 6x3 well-conditioned system with known LS solution (consistent).
        let triplets = vec![
            (0, 0, 2.0),
            (0, 1, 1.0),
            (1, 1, 3.0),
            (1, 2, -1.0),
            (2, 0, 1.0),
            (2, 2, 2.0),
            (3, 0, 0.5),
            (3, 1, 0.5),
            (3, 2, 0.5),
            (4, 1, 1.5),
            (5, 2, 1.0),
        ];
        let a = Csc::from_triplets(6, 3, &triplets);
        let x_true = [1.0, -2.0, 3.0];
        let mut b = vec![0.0; 6];
        a.matvec(&x_true, None, &mut b);
        let x = lsmr(&a, None, &b, 0.0, 1e-12, 1e-12, 100);
        for i in 0..3 {
            assert!((x[i] - x_true[i]).abs() < 1e-8, "{x:?}");
        }
    }

    #[test]
    fn lsmr_damping_shrinks_solution() {
        let triplets = vec![(0, 0, 1.0), (1, 1, 1.0)];
        let a = Csc::from_triplets(2, 2, &triplets);
        let b = vec![1.0, 1.0];
        let x = lsmr(&a, None, &b, 1.0, 1e-12, 1e-12, 50);
        // (A^T A + I) x = A^T b -> x = 0.5.
        assert!((x[0] - 0.5).abs() < 1e-8 && (x[1] - 0.5).abs() < 1e-8);
    }
}
