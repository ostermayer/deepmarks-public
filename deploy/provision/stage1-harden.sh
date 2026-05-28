#!/usr/bin/env bash
# Stage 1 — initial hardening for Deepmarks boxes.
# Run via: ssh root@BOX 'bash -s' < stage1.sh --role=a|b
set -euo pipefail

ROLE="${1:-a}"      # 'a' = public box (HTTP/HTTPS), 'b' = private worker (SSH only),
                    # 'c' = private signing box (SSH only — holds nsecBunker, no public ingress)
HUMAN_USER="dan"

echo "→ [$ROLE] updating apt + installing essentials"
export DEBIAN_FRONTEND=noninteractive
# Preseed grub-pc with the root disk so apt-upgrade doesn't choke on the
# interactive "install devices" prompt (Debian-only; Ubuntu uses grub-efi).
if dpkg -l grub-pc 2>/dev/null | grep -q '^ii\|^hi'; then
  ROOT_DISK="$(lsblk -no PKNAME "$(findmnt -n -o SOURCE /)" 2>/dev/null | head -1)"
  ROOT_DISK="${ROOT_DISK:-sda}"
  echo "grub-pc grub-pc/install_devices multiselect /dev/$ROOT_DISK" | debconf-set-selections
  dpkg --configure -a >/dev/null 2>&1 || true
fi
apt-get update -qq
apt-get upgrade -y -qq \
  -o Dpkg::Options::="--force-confdef" \
  -o Dpkg::Options::="--force-confold"
apt-get install -y -qq curl git ufw fail2ban unattended-upgrades ca-certificates gnupg

echo "→ creating $HUMAN_USER with sudo (if missing)"
if ! id "$HUMAN_USER" >/dev/null 2>&1; then
  adduser --gecos '' --disabled-password "$HUMAN_USER"
fi
usermod -aG sudo "$HUMAN_USER"

echo "→ copying root's authorized_keys to $HUMAN_USER"
mkdir -p "/home/$HUMAN_USER/.ssh"
cp /root/.ssh/authorized_keys "/home/$HUMAN_USER/.ssh/authorized_keys"
chown -R "$HUMAN_USER:$HUMAN_USER" "/home/$HUMAN_USER/.ssh"
chmod 700 "/home/$HUMAN_USER/.ssh"
chmod 600 "/home/$HUMAN_USER/.ssh/authorized_keys"

echo "→ configuring passwordless sudo for $HUMAN_USER"
echo "$HUMAN_USER ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/90-$HUMAN_USER"
chmod 440 "/etc/sudoers.d/90-$HUMAN_USER"

echo "→ tightening sshd (no root, no passwords) — NOT restarting yet"
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#\?ChallengeResponseAuthentication.*/ChallengeResponseAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#\?KbdInteractiveAuthentication.*/KbdInteractiveAuthentication no/' /etc/ssh/sshd_config
# /run/sshd is a runtime dir normally created at boot; `sshd -t` needs it.
mkdir -p /run/sshd
sshd -t  # validate config before we restart

echo "→ configuring UFW for role=$ROLE"
ufw --force reset >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow 22/tcp comment 'ssh'
case "$ROLE" in
  a)
    ufw allow 80/tcp  comment 'http'
    ufw allow 443/tcp comment 'https'
    ufw allow 443/udp comment 'http3'
    ;;
  b)
    # Box B is private — nothing public besides SSH. VPC firewall (configured
    # separately in Linode) governs its private-interface traffic with Box A.
    ;;
  c)
    # Box C is the signing box — nsecBunker only, never serves HTTP. Nothing
    # public besides SSH. Bunker traffic reaches the box via Box A's internal
    # strfry relay over the VPC, so no ingress port needed on the VPC side
    # either. Keys live only here; compromising Box A must never leak them.
    ;;
  *)
    echo "unknown role: $ROLE (expected a, b, or c)" >&2
    exit 2
    ;;
esac
ufw --force enable >/dev/null

echo "→ enabling fail2ban"
systemctl enable --now fail2ban >/dev/null 2>&1

echo "→ enabling unattended security upgrades"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF

echo "✓ stage 1 complete. sshd NOT yet restarted — verify $HUMAN_USER can log in first."
