# pi/provisioning/secrets/ — deploy key store (gitignored)

This directory holds the LED Mapper **deploy SSH key pair**. Everything here
except this README is gitignored (`../.gitignore`). **Never commit a private
key.**

Files created by `scripts/manage_keys.sh init`:

| File             | Half    | Used by                                                     |
| ---------------- | ------- | ----------------------------------------------------------- |
| `deploy_key`     | private | `deploy_live` (`nixos-rebuild --target-host`)               |
| `deploy_key.pub` | public  | baked into the image's root `authorized_keys` at build time |

## Generate / rotate

```sh
bazel run //pi/provisioning:keys -- init     # idempotent
bazel run //pi/provisioning:keys -- rotate   # back up old, make new
```

## Alternative location (outside the repo)

Set `LEDMAPPER_DEPLOY_KEY_DIR=/path/to/dir` to keep the pair outside the
working tree entirely (e.g. in your user keystore). The image build reads the
public key from `$LEDMAPPER_DEPLOY_PUBKEY_FILE` if set (see
`../nix/modules/ssh-deploy.nix`).

See `../README.md` for the full rotation procedure on a fielded Pi.
