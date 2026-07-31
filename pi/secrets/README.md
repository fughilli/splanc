# pi deploy secrets (never committed)

Everything in this directory is gitignored except this README and `.gitignore`.
It holds the per-operator, locally-generated/provisioned secrets for the `pi/*`
rigs. None of it is baked into the nix store or git.

| file                | what it is                                        | how to (re)create |
|---------------------|---------------------------------------------------|-------------------|
| `deploy_key[.pub]`  | SSH key for `deploy_live` / `hitl.ssh` (root@rig) | `bazel run //pi/hitl:hitl.keys -- init` |
| `tailscale-authkey` | Tailscale auth key, pre-seeded to the rig         | mint at https://login.tailscale.com/admin/settings/keys |

## Tailscale auth key

The rig reads its auth key from `/var/lib/tailscale/authkey` (see
`services.tailscale.authKeyFile` in `pi/hitl/nix/hitl-app.nix`). A **reflash wipes
`/var/lib`**, so after reflashing, re-seed it:

```sh
pi/hitl/scripts/seed-tailscale-authkey.sh hitl-rig.local
```

Keep the key here so it isn't lost. It's a reusable, standing secret — rotate it in
the Tailscale console if it's ever exposed, then overwrite `tailscale-authkey` with
the new value and re-seed.
