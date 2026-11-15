# Deploying the Ronchi Connect server

One small Linux server runs everything: the website, the server the apps talk
to, and the relay. A 2 vCPU / 2 GB machine (about $12 a month at DigitalOcean,
Hetzner, Linode or AWS Lightsail) is plenty for a support team.

## What you need

1. A Linux server (Ubuntu 24.04 is fine) with a public IP address.
2. A domain name pointing at it, for example `connect.ronchiamerica.com`
   (an `A` record to the server's IP).
3. Docker: `curl -fsSL https://get.docker.com | sh`

## Firewall ports

| Port | Protocol | Purpose |
| --- | --- | --- |
| 80, 443 | TCP | Website and app connection (HTTPS) |
| 3478 | TCP and UDP | Relay (TURN) |
| 49160-49200 | UDP | Relay media ports |

## Start it

```bash
git clone <this repository> ronchi-connect
cd ronchi-connect/deploy
cp .env.example .env
nano .env                 # set DOMAIN, PUBLIC_IP, ADMIN_PASSWORD, TURN_SECRET
docker compose up -d --build
```

Open `https://<your domain>` to see the website. In the desktop app, sign in
as the administrator (username from `.env`) and add technicians under **Team**.

## Point the apps at your server

Set `serverUrl` in `brand/brand.json` to `wss://<your domain>/ws` before
building installers. (For a quick trial, the gear icon in the app lets you
type a server address by hand.)

## Publishing installers

Copy the installer files into `deploy/downloads/` on the server. The website
lists whatever is there, and picks the right one for each visitor:

```
deploy/downloads/RonchiConnect-0.1.0-win-x64.exe
deploy/downloads/RonchiConnect-0.1.0-mac-arm64.dmg
deploy/downloads/RonchiConnect-0.1.0-linux-x86_64.AppImage
```

## Backups

Everything worth keeping is in `deploy/data/`: accounts, team chat and the
session audit log (`sessions.jsonl`). Back that folder up.

## Updating

```bash
git pull && docker compose up -d --build
```

## Accounts from the command line

```bash
docker compose exec server node server/src/cli.js list-users
docker compose exec server node server/src/cli.js add-user jsmith "John Smith" "a-long-password"
docker compose exec server node server/src/cli.js set-password jsmith "another-long-password"
```
Restart the server after command-line changes: `docker compose restart server`.
