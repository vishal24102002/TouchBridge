#!/bin/bash
# One-time Linux setup so TouchBridge can control a Wayland (or X11) desktop
# through /dev/uinput. Run with:  sudo ./setup_uinput.sh

set -e

if [ "$(id -u)" -ne 0 ]; then
    echo "Please run as root:  sudo ./setup_uinput.sh"
    exit 1
fi

echo "Setting up Linux uinput..."

# Load uinput kernel module
modprobe uinput

# Enable uinput on every boot
echo "uinput" > /etc/modules-load.d/uinput.conf

# Create dedicated group
if ! getent group uinput >/dev/null; then
    groupadd uinput
fi

# Add current user to uinput group
USER_NAME="${SUDO_USER:-$USER}"
usermod -aG uinput "$USER_NAME"

# Configure device permissions
cat > /etc/udev/rules.d/99-uinput.rules <<'RULE'
KERNEL=="uinput", MODE="0660", GROUP="uinput"
RULE

# Reload udev rules
udevadm control --reload-rules
udevadm trigger

echo ""
echo "uinput setup completed!"
echo "User: $USER_NAME"
echo "IMPORTANT: Log out and log back in."
