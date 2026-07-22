#!/usr/bin/env bash
# Lock the origin's published web ports (80/443) to Cloudflare's IP ranges only,
# so Hostinger's edge never sees client IPs (fixes the recurring client IP-blocks).
#
# The filtering lives in the DOCKER-USER iptables chain because Docker's own rules
# bypass ufw. IMPORTANT: the allow/deny rules are scoped to the EXTERNAL interface
# ($EXTIF) — otherwise a bare "dport 80,443 -j DROP" also drops CONTAINER→internet
# traffic (any outbound HTTPS/HTTP a container makes), which breaks image builds,
# the backend's FX-rate fetch, and the Gmail API mailer. Inbound-from-internet
# packets arrive on $EXTIF; container egress arrives on the docker bridge, so the
# interface match cleanly separates the two.
#
# Persisted by cf-lockdown.service (systemd, re-applies on boot). If Cloudflare
# rotates ranges, re-fetch cloudflare.com/ips-v4 + ips-v6 and update CF4/CF6.
set -euo pipefail

EXTIF="eth0"   # public NIC (default route); container traffic uses the docker bridge

CF4="173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 141.101.64.0/18 108.162.192.0/18 190.93.240.0/20 188.114.96.0/20 197.234.240.0/22 198.41.128.0/17 162.158.0.0/15 104.16.0.0/13 104.24.0.0/14 172.64.0.0/13 131.0.72.0/22"
CF6="2400:cb00::/32 2606:4700::/32 2803:f800::/32 2405:b500::/32 2405:8100::/32 2a06:98c0::/29 2c0f:f248::/32"

apply() {
  local ipt="$1" ranges="$2"
  "$ipt" -L DOCKER-USER >/dev/null 2>&1 || return 0
  "$ipt" -F DOCKER-USER
  # Allow Cloudflare edge in to the published web ports (inbound on the public NIC).
  for ip in $ranges; do
    "$ipt" -A DOCKER-USER -i "$EXTIF" -s "$ip" -p tcp -m multiport --dports 80,443 -j RETURN
  done
  # Drop any other inbound-from-internet hit on 80/443 (direct-to-origin bypass).
  "$ipt" -A DOCKER-USER -i "$EXTIF" -p tcp -m multiport --dports 80,443 -j DROP
  # Everything else (notably container egress on the docker bridge) is allowed.
  "$ipt" -A DOCKER-USER -j RETURN
}

apply iptables "$CF4"
apply ip6tables "$CF6"
