import unittest
import numpy as np
import torch
from pnr.place.batched_cost import PaddedWirelength, BucketedWirelength, endpoint_cost_numpy, TorchEndpointCost

class BatchedCostTests(unittest.TestCase):

    def test_value_gradient_and_padding(self):
        torch.manual_seed(121)
        for dtype, tol in [(torch.float64, 1e-11), (torch.float32, 3e-05)]:
            xy = (torch.randn(17, 2, dtype=dtype) * 40).requires_grad_()
            nets = [[0, 1], [2, 4, 6, 8, 10], [1, 5, 9, 13, 16]]
            ref = sum((torch.logsumexp(xy[n, 0], 0) + torch.logsumexp(-xy[n, 0], 0) + torch.logsumexp(xy[n, 1], 0) + torch.logsumexp(-xy[n, 1], 0) for n in nets))
            grad = torch.autograd.grad(ref, xy, retain_graph=True)[0]
            got = PaddedWirelength(nets)(xy)
            self.assertTrue(torch.allclose(got, ref, atol=tol, rtol=tol))
            self.assertTrue(torch.allclose(torch.autograd.grad(got, xy)[0], grad, atol=tol, rtol=tol))

    def test_empty_and_batch(self):
        x = torch.zeros(3, 7, 2, requires_grad=True)
        y = PaddedWirelength([[], [2]])(x)
        self.assertEqual(tuple(y.shape), (3,))
        self.assertTrue(torch.equal(y, torch.zeros(3)))
        y.sum().backward()
        self.assertTrue(torch.equal(x.grad, torch.zeros_like(x)))
        with self.assertRaises(ValueError):
            PaddedWirelength([[0, 1]])(x, 0)

    def test_endpoint_padding_chunking(self):
        a = (np.array([[0.0, 0.0], [1.0, 2.0]]), np.array([[[4.0, 5.0], [0.0, 0.0]], [[2.0, 3.0], [7.0, 8.0]]]), np.array([[True, False], [True, True]]))
        p = np.array([[0.0, 0.0], [2.0, 3.0], [4.0, 7.0]])
        ref = np.array([sum((min((np.abs(pos + a[0][i] - q).sum() for q in a[1][i, a[2][i]])) for i in range(2))) for pos in p])
        self.assertTrue(np.array_equal(endpoint_cost_numpy(p, a, chunk=1), ref))
        self.assertTrue(np.array_equal(endpoint_cost_numpy(p, a, chunk=99), ref))
        self.assertTrue(np.array_equal(TorchEndpointCost(a)(torch.tensor(p, dtype=torch.float32)).numpy(), ref))
        empty = (np.empty((0, 2)), np.empty((0, 1, 2)), np.empty((0, 1), bool))
        self.assertTrue(np.array_equal(endpoint_cost_numpy(p, empty), np.zeros(3)))

class BucketTests(unittest.TestCase):

    def test_padding_value_gradient_and_batch(self):
        torch.manual_seed(121)
        nets = [list(range(n)) for n in [2, 3, 5, 17, 65]]
        for dtype, tol in [(torch.float64, 1e-11), (torch.float32, 3e-05)]:
            for batch in [False, True]:
                xy = (torch.randn((3, 70, 2) if batch else (70, 2), dtype=dtype) * 35).requires_grad_()
                padded = PaddedWirelength(nets)
                bucket = BucketedWirelength(nets)
                self.assertLess(bucket.padded_entries, 2 * bucket.actual_entries)
                for gamma in [0.2, 1.0, 5.0]:
                    ref = padded(xy, gamma)
                    got = bucket(xy, gamma)
                    self.assertTrue(torch.allclose(got, ref, atol=tol, rtol=tol))
                    a = torch.autograd.grad(ref.sum(), xy, retain_graph=True)[0]
                    b = torch.autograd.grad(got.sum(), xy, retain_graph=True)[0]
                    self.assertTrue(torch.allclose(a, b, atol=tol, rtol=tol))

    def test_invalid_and_empty(self):
        x = torch.zeros(3, 7, 2, requires_grad=True)
        y = BucketedWirelength([[], [2]])(x)
        self.assertTrue(torch.equal(y, torch.zeros(3)))
        y.sum().backward()
        self.assertTrue(torch.equal(x.grad, torch.zeros_like(x)))
        for cls in [PaddedWirelength, BucketedWirelength]:
            for gamma in [0, -1, float('nan'), float('inf')]:
                with self.assertRaises(ValueError):
                    cls([[0, 1]])(x, gamma)
if __name__ == '__main__':
    unittest.main()
