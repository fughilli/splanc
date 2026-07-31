# pi deploy secrets (never committed)

Everything in this directory is gitignored except this README and `.gitignore`.
It holds the per-operator, locally-generated/provisioned secrets for the `pi/*`
rigs. None of it is baked into the nix store or git.

| file                | what it is                                        | how to (re)create |
|---------------------|---------------------------------------------------|-------------------|
| `deploy_key[.pub]`  | SSH key for `deploy_live` / `hitl.ssh` (root@rig) | `bazel run //pi/hitl:hitl.keys -- init` |
| `tailscale-authkey` | Tailscale auth key, pre-seeded to the rig         | mint at https://login.tailscale.com/admin/settings/keys |
| `wifi-seed.yaml`    | extra WiFi networks seeded onto the rig at runtime| hand-written (schema below) |

## Runtime WiFi (`wifi-seed.yaml`)

The rig's *baked* WiFi (BigVibes/FugLink) is in `pi/hitl/wifi.yaml`, compiled into
the image. To add networks to a running rig **without a rebuild** — and have them
survive redeploys — seed them as a persistent layer. Put extra networks here
(same schema as `wifi.yaml`):

```yaml
- ssid: CoffeeShop
  psk: latte12345
  priority: 25
- ssid: OpenGuest      # open network — omit psk
  priority: 15
```

Then apply them (composes with the baked set by priority):

```sh
pi/hitl/scripts/seed-wifi.sh                     # seed all of wifi-seed.yaml
pi/hitl/scripts/seed-wifi.sh --ssid X --psk Y    # one-off, no file
pi/hitl/scripts/seed-wifi.sh --list              # show seeded networks
pi/hitl/scripts/seed-wifi.sh --remove CoffeeShop
```

Seeded networks live in `/etc/NetworkManager/system-connections` on the rig;
`switch-to-configuration` never touches that dir, so a redeploy won't clobber them.

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
