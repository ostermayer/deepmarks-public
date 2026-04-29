# Deepmarks deploy

Three Linode boxes:

- **box-a** (VPC 10.0.0.2) — public edge: caddy, strfry, blossom-server, payment-proxy, redis, meilisearch
- **box-b** (VPC 10.0.0.3) — private worker: archive-worker (Playwright + SingleFile)
- **box-c** (VPC 10.0.0.4) — private signer: nsecBunker (holds brand + personal nsecs, talks NIP-46 to payment-proxy via strfry)

All three boxes share a Linode VPC (10.0.0.0/24). Box B reaches Redis + payment-proxy on Box A via the VPC; Box C reaches strfry on Box A via the VPC. No nsec ever lives on Box A — payment-proxy requests signatures from Box C over NIP-46.

## First-time setup on a fresh box

Everything needed to stand up a brand-new Box A or Box B is in `deploy/provision/`.

1. Create a Linode (Debian 13, Chicago `us-ord`). Copy `deploy/provision/stage1-harden.sh` to the box and run it **as root**:
   ```
   scp deploy/provision/stage1-harden.sh root@BOX_IP:/tmp/
   ssh root@BOX_IP 'bash /tmp/stage1-harden.sh a'     # Box A (public ports 80/443)
   # or 'bash /tmp/stage1-harden.sh b' for Box B (SSH-only, uses VPC).
   ```
   Then verify you can SSH as `dan@BOX_IP` before restarting sshd.

2. Run `stage2-docker.sh` as root to install Docker Engine + Compose.
   ```
   ssh dan@BOX_IP 'sudo bash /tmp/stage2-docker.sh'
   ```
   Log out + back in so `dan` picks up the `docker` group.

3. Run `stage3-clone.sh` as `dan` to generate the deploy key, add it to GitHub
   (it prints the public key), and clone the repo to `/opt/deepmarks-repo`.
   ```
   scp deploy/provision/stage3-clone.sh dan@BOX_IP:/tmp/
   ssh dan@BOX_IP 'bash /tmp/stage3-clone.sh'
   # prints the deploy-key to register; re-run after registering.
   ```

4. Copy the appropriate .env template and fill in secrets:
   ```
   ssh dan@BOX_IP 'cp /opt/deepmarks-repo/deploy/box-a/.env.example \
                       /opt/deepmarks-repo/deploy/box-a/.env && \
                    chmod 600 /opt/deepmarks-repo/deploy/box-a/.env && \
                    nano /opt/deepmarks-repo/deploy/box-a/.env'
   ```

5. First deploy:
   ```
   ssh dan@BOX_IP '/opt/deepmarks-repo/deploy/deploy.sh a'   # or b
   ```

## Subsequent deploys

From your laptop, use the one-command helper at repo root:

```
./deploy/push-deploy.sh                     # you've already committed; push + deploy both boxes
./deploy/push-deploy.sh -m "fix caddyfile"  # stage + commit everything, push, deploy
./deploy/push-deploy.sh -m "..." --only a   # Box A only
./deploy/push-deploy.sh --skip-remote       # push only (Cloudflare Pages rebuilds on its own)
```

Internally that does `git push`, then SSHes to each box and runs
`/opt/deepmarks-repo/deploy/deploy.sh {a|b}`, which does
`git pull --ff-only && docker compose build && docker compose up -d`.

Cloudflare Pages (frontend) **always** auto-rebuilds on push — no remote step needed there.

## Layout

```
deploy/
  deploy.sh              # one entry point, takes a|b|c
  box-a/
    compose.yml          # references ../../payment-proxy as build context
    Caddyfile
    strfry/{Dockerfile, strfry.conf, deepmarks.js}
    .env.example
    .env                 # gitignored; real secrets, chmod 600
  box-b/
    compose.yml          # references ../../archive-worker as build context
    .env.example
    .env                 # gitignored
  box-c/
    compose.yml          # references ../../bunker as build context
    setup-system.sh      # one-time: creates bunker:bunker uid 900 + dirs
    .env.example
    .env                 # gitignored
```

`.env` is per-box. Secrets never live in the repo.

### First-time Box C setup

Box C needs host-level init before the first compose build because
nsecs live outside the container image in bind-mounted host
directories:

```bash
sudo bash /opt/deepmarks-repo/deploy/box-c/setup-system.sh
# Drop the nsecs at /opt/deepmarks-bunker/nsecs/{brand,dan}.nsec
# chmod 400, owned by bunker:bunker.
cp deploy/box-c/.env.example deploy/box-c/.env   # chmod 600, fill in BUNKER_CLIENT_PUBKEY
/opt/deepmarks-repo/deploy/deploy.sh c
```
