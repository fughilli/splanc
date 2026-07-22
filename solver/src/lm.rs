//! Sparse Levenberg–Marquardt with column-grouped finite-difference
//! Jacobians — the Rust stand-in for scipy `least_squares(..., jac_sparsity,
//! x_scale="jac", tr_solver="lsmr")` used by the Python reference.
//!
//! Same problem interface (residual closure + sparsity pattern + eval
//! budget), same variable scaling (Jacobian column norms, kept monotone
//! across iterations), same damped-LSMR subproblem. The step-control policy
//! is classic LM with Nielsen's gain-ratio update rather than scipy's
//! trust-region-reflective — with no bounds, both walk the same
//! Gauss-Newton/gradient interpolation family and land in the same basin;
//! the cross-language parity test pins that the SOLUTIONS agree.

use crate::sparse::{lsmr, Csc};

/// Per-column row lists (the transposed sparsity pattern).
pub struct Sparsity {
    pub n_res: usize,
    pub col_rows: Vec<Vec<usize>>,
}

impl Sparsity {
    pub fn new(n_res: usize, n_par: usize) -> Sparsity {
        Sparsity {
            n_res,
            col_rows: vec![Vec::new(); n_par],
        }
    }

    /// Mark a dense block of residuals [r0, r1) × parameters [c0, c1).
    pub fn block(&mut self, r0: usize, r1: usize, c0: usize, c1: usize) {
        for c in c0..c1 {
            for r in r0..r1 {
                self.col_rows[c].push(r);
            }
        }
    }

    fn finalize(&mut self) {
        for rs in &mut self.col_rows {
            rs.sort_unstable();
            rs.dedup();
        }
    }

    /// Greedy Curtis–Powell–Reid coloring: columns that share no residual
    /// row can be finite-differenced in one evaluation.
    fn group_columns(&self) -> Vec<Vec<usize>> {
        let words = self.n_res.div_ceil(64);
        let mut groups: Vec<Vec<usize>> = Vec::new();
        let mut masks: Vec<Vec<u64>> = Vec::new();
        for (c, rs) in self.col_rows.iter().enumerate() {
            let mut placed = false;
            'groups: for (gi, mask) in masks.iter_mut().enumerate() {
                for &r in rs {
                    if mask[r / 64] & (1u64 << (r % 64)) != 0 {
                        continue 'groups;
                    }
                }
                for &r in rs {
                    mask[r / 64] |= 1u64 << (r % 64);
                }
                groups[gi].push(c);
                placed = true;
                break;
            }
            if !placed {
                let mut mask = vec![0u64; words];
                for &r in rs {
                    mask[r / 64] |= 1u64 << (r % 64);
                }
                masks.push(mask);
                groups.push(vec![c]);
            }
        }
        groups
    }
}

pub struct LmOptions {
    pub max_nfev: usize, // trial-evaluation budget (scipy max_nfev semantics)
    pub ftol: f64,
}

pub struct LmResult {
    pub x: Vec<f64>,
    pub cost: f64,
}

/// Progress hook: called after every residual evaluation with the estimated
/// fraction of the evaluation budget consumed. Carriers throttle.
pub type EvalHook<'a> = &'a mut dyn FnMut(f64);

pub fn least_squares_lm(
    fun: &mut dyn FnMut(&[f64], &mut [f64]),
    x0: &[f64],
    mut sparsity: Sparsity,
    opts: &LmOptions,
    hook: Option<EvalHook>,
) -> LmResult {
    sparsity.finalize();
    let n_res = sparsity.n_res;
    let n_par = sparsity.col_rows.len();
    let groups = sparsity.group_columns();
    let mut jac = Csc::from_pattern(n_res, &sparsity.col_rows);
    // nnz offsets are contiguous per column (CSC), so FD fills are direct.

    // Estimated total evals for progress: each iteration costs one Jacobian
    // (one eval per column group) + one trial eval.
    let est_total = (opts.max_nfev * (1 + groups.len())) as f64;
    let mut eval_count = 0usize;
    let mut hook = hook;
    let call = |fun: &mut dyn FnMut(&[f64], &mut [f64]),
                x: &[f64],
                out: &mut [f64],
                eval_count: &mut usize,
                hook: &mut Option<EvalHook>| {
        fun(x, out);
        *eval_count += 1;
        if let Some(h) = hook {
            h((*eval_count as f64 / est_total).min(0.99));
        }
    };

    let mut x = x0.to_vec();
    let mut f = vec![0.0; n_res];
    call(fun, &x, &mut f, &mut eval_count, &mut hook);
    let mut cost = 0.5 * f.iter().map(|v| v * v).sum::<f64>();

    let mut f_pert = vec![0.0; n_res];
    let mut x_pert = vec![0.0; n_par];
    let mut f_trial = vec![0.0; n_res];
    let mut scale_inv: Vec<f64> = vec![0.0; n_par]; // column norms, monotone

    const FD_REL: f64 = 1.4901161193847656e-8; // sqrt(machine eps)
    let mut lambda: f64 = 1e-4;
    let mut nu = 2.0;
    let mut nfev_trials = 0usize;

    while nfev_trials < opts.max_nfev {
        // ---- Jacobian by grouped 2-point differences --------------------
        for group in &groups {
            x_pert.copy_from_slice(&x);
            for &c in group {
                x_pert[c] += FD_REL * x[c].abs().max(1.0);
            }
            call(fun, &x_pert, &mut f_pert, &mut eval_count, &mut hook);
            for &c in group {
                let h = x_pert[c] - x[c];
                for k in jac.indptr[c]..jac.indptr[c + 1] {
                    let r = jac.indices[k];
                    jac.data[k] = (f_pert[r] - f[r]) / h;
                }
            }
        }
        // x_scale="jac": monotone max of column norms; zero columns -> 1.
        for (c, s) in jac.col_norms().into_iter().enumerate() {
            let s = if s == 0.0 { 1.0 } else { s };
            scale_inv[c] = scale_inv[c].max(s);
        }
        let neg_f: Vec<f64> = f.iter().map(|v| -v).collect();

        // ---- Damped steps until one is accepted -------------------------
        let mut accepted = false;
        while nfev_trials < opts.max_nfev {
            let z = lsmr(
                &jac,
                Some(&scale_inv),
                &neg_f,
                lambda.sqrt(),
                1e-6,
                1e-6,
                (n_par.min(n_res)).min(400),
            );
            // z is already unscaled to δ by lsmr's col_scale handling.
            let x_trial: Vec<f64> = x.iter().zip(&z).map(|(xi, di)| xi + di).collect();
            call(fun, &x_trial, &mut f_trial, &mut eval_count, &mut hook);
            nfev_trials += 1;
            let cost_trial = 0.5 * f_trial.iter().map(|v| v * v).sum::<f64>();

            // Predicted reduction from the linear model (with damping).
            let mut jd = vec![0.0; n_res];
            jac.matvec(&z, None, &mut jd);
            let mut predicted = 0.0;
            for r in 0..n_res {
                predicted -= jd[r] * (f[r] + 0.5 * jd[r]);
            }
            for (c, di) in z.iter().enumerate() {
                let sd = scale_inv[c] * di;
                predicted += 0.5 * lambda * sd * sd;
            }
            let actual = cost - cost_trial;
            let rho = if predicted > 0.0 {
                actual / predicted
            } else if actual > 0.0 {
                1.0
            } else {
                -1.0
            };

            if cost_trial < cost {
                let df = cost - cost_trial;
                x = x_trial;
                std::mem::swap(&mut f, &mut f_trial);
                let prev_cost = cost;
                cost = cost_trial;
                // Nielsen's update.
                lambda *= (1.0f64 / 3.0).max(1.0 - (2.0 * rho - 1.0).powi(3));
                lambda = lambda.max(1e-12);
                nu = 2.0;
                accepted = true;
                if df < opts.ftol * prev_cost {
                    return LmResult { x, cost };
                }
                break;
            }
            lambda *= nu;
            nu *= 2.0;
            if lambda > 1e12 {
                // The model can't produce a descent step: converged.
                return LmResult { x, cost };
            }
        }
        if !accepted {
            break;
        }
    }
    LmResult { x, cost }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lm_fits_exponential_decay() {
        // y = a * exp(-b t), noisy-free; start far from the solution.
        let ts: Vec<f64> = (0..40).map(|i| i as f64 * 0.1).collect();
        let (a_true, b_true) = (2.5, 1.3);
        let ys: Vec<f64> = ts.iter().map(|t| a_true * (-b_true * t).exp()).collect();
        let ts2 = ts.clone();
        let ys2 = ys.clone();
        let mut fun = move |x: &[f64], out: &mut [f64]| {
            for (i, (t, y)) in ts2.iter().zip(&ys2).enumerate() {
                out[i] = x[0] * (-x[1] * t).exp() - y;
            }
        };
        let mut spar = Sparsity::new(ts.len(), 2);
        spar.block(0, ts.len(), 0, 2);
        let res = least_squares_lm(
            &mut fun,
            &[1.0, 0.3],
            spar,
            &LmOptions {
                max_nfev: 100,
                ftol: 1e-12,
            },
            None,
        );
        assert!(
            (res.x[0] - a_true).abs() < 1e-6 && (res.x[1] - b_true).abs() < 1e-6,
            "{:?}",
            res.x
        );
    }

    #[test]
    fn grouping_respects_row_conflicts() {
        // Two columns sharing a row must be in different groups.
        let mut spar = Sparsity::new(3, 3);
        spar.block(0, 2, 0, 1); // col 0: rows 0,1
        spar.block(1, 3, 1, 2); // col 1: rows 1,2
        spar.block(2, 3, 2, 3); // col 2: row 2
        spar.finalize();
        let groups = spar.group_columns();
        let gi_of = |c: usize| groups.iter().position(|g| g.contains(&c)).unwrap();
        assert_ne!(gi_of(0), gi_of(1));
        assert_ne!(gi_of(1), gi_of(2));
        assert_eq!(gi_of(0), gi_of(2)); // no conflict: shared group
    }
}
