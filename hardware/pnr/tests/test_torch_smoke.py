"""Task 0 acceptance — prove PyTorch is available and differentiable under Bazel.

The placement engine (design doc §4/§8) is a PyTorch autograd program, so before
building it we land ``torch`` in the root lockfile and prove it imports and runs
here. CPU-only by design (determinism + no GPU in CI). This is deliberately tiny:
a forward + backward pass whose gradient we can check in closed form.
"""

import unittest

import torch


class TorchSmokeTest(unittest.TestCase):
    def test_imports_and_runs_on_cpu(self):
        x = torch.ones(3, 3)
        y = (x * 2.0).sum()
        self.assertAlmostEqual(y.item(), 18.0)

    def test_autograd_gradient_is_correct(self):
        # d/dx (sum(x^2)) = 2x — the backward pass the placer relies on.
        x = torch.tensor([1.0, 2.0, 3.0], requires_grad=True)
        (x * x).sum().backward()
        self.assertTrue(torch.allclose(x.grad, torch.tensor([2.0, 4.0, 6.0])))

    def test_lse_wirelength_is_differentiable(self):
        # A weighted-average / log-sum-exp HPWL surrogate (the smooth wirelength
        # the placement loss minimizes) has a finite gradient everywhere.
        pos = torch.tensor([0.0, 1.0, 3.0], requires_grad=True)
        gamma = 1.0
        lse = gamma * (torch.logsumexp(pos / gamma, 0) + torch.logsumexp(-pos / gamma, 0))
        lse.backward()
        self.assertIsNotNone(pos.grad)
        self.assertEqual(pos.grad.shape, pos.shape)
        self.assertFalse(torch.isnan(pos.grad).any())


if __name__ == "__main__":
    unittest.main()
