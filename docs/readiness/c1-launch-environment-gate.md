# C1 Launch Environment Gate

**Date:** 2026-04-24
**Version:** v1.3.5
**Gate status:** BLOCKED — requires operator action

---

## Purpose

This gate verifies that each C0 node is deployed behind a reverse proxy with TLS termination and IP-based rate limiting before C1 invitations can be sent. This is decision-packet criterion #11.

## Why This Cannot Be Verified In-Repo

Reverse proxy deployment is an infrastructure action performed on each operator's host. It cannot be proven by test suites or local evidence collection. The commands and expected artifacts below define exactly what each operator must do and produce.

---

## Operator Action: Deploy Reverse Proxy

Each C0 operator must complete ALL steps below and submit evidence.

### Step 1: Install reverse proxy

Choose nginx or Caddy. Example with Caddy:

```bash
# Install Caddy (Debian/Ubuntu)
sudo apt install -y caddy

# Or install nginx
sudo apt install -y nginx
```

### Step 2: Configure rate limiting and TLS

**Caddy** (`/etc/caddy/Caddyfile`):

```
your-node.example.com {
    # TLS is automatic with Caddy

    # Rate limit unauthenticated endpoints: 30 req/min per IP
    @unauth path /myr/health /.well-known/myr-node /myr/peer/introduce
    rate_limit @unauth {
        zone unauth_zone {
            key {remote_host}
            events 30
            window 1m
        }
    }

    reverse_proxy localhost:3719
}
```

**nginx** (`/etc/nginx/sites-available/myr`):

```nginx
limit_req_zone $binary_remote_addr zone=myr_unauth:10m rate=30r/m;

server {
    listen 443 ssl;
    server_name your-node.example.com;

    ssl_certificate /etc/letsencrypt/live/your-node.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-node.example.com/privkey.pem;

    location ~ ^/(myr/health|\.well-known/myr-node|myr/peer/introduce) {
        limit_req zone=myr_unauth burst=5 nodelay;
        proxy_pass http://127.0.0.1:3719;
    }

    location / {
        proxy_pass http://127.0.0.1:3719;
    }
}
```

### Step 3: Verify TLS

```bash
curl -v https://YOUR_NODE_URL/myr/health 2>&1 | grep -E "(SSL|subject|issuer|HTTP/)"
```

Expected: valid TLS certificate, `HTTP/1.1 200` or `HTTP/2 200`.

### Step 4: Verify rate limiting

```bash
# Send 35 rapid requests to an unauthenticated endpoint
for i in $(seq 1 35); do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" https://YOUR_NODE_URL/myr/health)
  echo "Request $i: HTTP $CODE"
done
```

Expected: first ~30 requests return `200`, remaining return `429` (Too Many Requests).

### Step 5: Produce evidence

```bash
# Save TLS evidence
curl -v https://YOUR_NODE_URL/myr/health 2>&1 > /tmp/myr-tls-evidence.txt

# Save rate-limit evidence (capture the 429s)
for i in $(seq 1 35); do
  curl -s -o /dev/null -w "req=$i status=%{http_code}\n" https://YOUR_NODE_URL/myr/health
done > /tmp/myr-ratelimit-evidence.txt
```

Submit both files to the Escalation Contact for signoff.

---

## Evidence Artifacts

Each C0 operator must produce:

| Artifact | Contents | Submit to |
|----------|----------|-----------|
| `myr-tls-evidence.txt` | curl -v output showing valid TLS handshake and 200 response | Escalation Contact |
| `myr-ratelimit-evidence.txt` | 35-request burst showing 429 responses after limit | Escalation Contact |

## Signoff

| Node | Operator | TLS verified | Rate limit verified | Signed off by | Date |
|------|----------|-------------|--------------------|--------------|----- |
| n1 | _________ | [ ] | [ ] | _________ | _________ |
| n2 | _________ | [ ] | [ ] | _________ | _________ |
| n3 | _________ | [ ] | [ ] | _________ | _________ |

---

## Go/No-Go Consequence

- **If ALL 3 C0 nodes pass:** Criterion #11 is satisfied. Proceed to operator briefing gate.
- **If ANY node fails:** C1 invitations MUST NOT be sent. The failing operator must remediate and re-submit evidence.
- **Timeout:** If evidence is not submitted within 7 days of this gate being issued, escalate to project lead for a forced decision.
