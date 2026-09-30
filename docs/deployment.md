# Betrieb des Remote-Servers

Der Remote-Modus (`dist/http.js`) macht den MCP-Server unter `https://erp.fifty1.com/mcp` erreichbar — für claude.ai, ChatGPT, Claude Code und alle anderen Clients, die MCP über Streamable HTTP mit OAuth sprechen.

## Wie die Teile zusammenspielen

```
Client (claude.ai, ChatGPT, …)
   │  HTTPS, Authorization: Bearer f51oa_…
   ▼
nginx auf erp.fifty1.com  ── /mcp ──►  Node: 127.0.0.1:3130/mcp  (dieser Server)
   │                                         │
   │  alles andere (PHP-ERP)                 │  GET /api/oauth/tokeninfo   (Token prüfen)
   ▼                                         │  /api/mcp/*                 (Tools, mit demselben Token)
ERP (public/api.php, OAuth-Server)  ◄────────┘
```

- **Das ERP ist der Autorisierungsserver.** Es übernimmt Anmeldung (Passkey oder Passwort + TOTP), Zustimmung, Token-Ausgabe und veröffentlicht die Metadaten unter `https://erp.fifty1.com/.well-known/oauth-protected-resource/mcp`.
- **Dieser Server prüft nur Tokens.** Jede Anfrage ohne gültigen Token bekommt `401` mit einem `WWW-Authenticate`-Header, der auf diese Metadaten zeigt — damit findet der Client den Weg zur Anmeldung selbst.
- **Jede Anfrage steht für sich** (stateless). Der Server baut pro Anfrage eine MCP-Instanz mit dem Token des Aufrufers und reicht diesen Token an die ERP-API weiter. Das ERP wendet dann die Rollenrechte genau dieses Mitarbeiters an. Es gibt keine Sitzungen, die ein Neustart verlieren könnte.
- Positive Token-Prüfungen werden bis zu 60 s zwischengespeichert. Ein im ERP widerrufener Token wirkt also spätestens nach einer Minute nicht mehr.

## Konfiguration

| Variable | Pflicht | Bedeutung |
|---|---|---|
| `MCP_PUBLIC_URL` | ja | Öffentliche URL des Endpoints, z.B. `https://erp.fifty1.com/mcp`. Muss exakt der Audience entsprechen, die das ERP in die Tokens schreibt — sonst lehnt der Server jeden Token ab. `http` nur für `localhost`. |
| `FIFTY1_API_BASE_URL` | ja | Basis-URL der ERP-API, z.B. `https://erp.fifty1.com/api`. |
| `PORT` | nein | Standard `3030`. **Auf fifty1-webserver `3130`** – dort belegt Grafana `127.0.0.1:3030`. |
| `HOST` | nein | Standard `127.0.0.1`. Nicht ändern, solange Apache auf demselben Rechner läuft — der Port soll von außen nicht erreichbar sein. |

Ein `FIFTY1_API_TOKEN` braucht der Remote-Modus nicht; jeder Nutzer bringt seinen eigenen OAuth-Token mit.

Fehlt eine Pflichtvariable oder ist sie ungültig, startet der Server nicht und nennt die Ursache.

## Installation auf dem Server

Voraussetzung: Node.js ≥ 20 unter `/usr/bin/node` (`node --version`).

```bash
# Eigener Systembenutzer ohne Login
sudo useradd --system --home /opt/fifty1-erp-mcp --shell /usr/sbin/nologin fifty1-mcp

# Code holen und bauen (npm ci führt über "prepare" auch tsc aus)
sudo git clone https://github.com/fifty1-com/fifty1-erp-mcp.git /opt/fifty1-erp-mcp
cd /opt/fifty1-erp-mcp
sudo npm ci
sudo chown -R root:fifty1-mcp /opt/fifty1-erp-mcp

# Konfiguration
sudo tee /etc/fifty1-erp-mcp.env > /dev/null <<'ENV'
MCP_PUBLIC_URL=https://erp.fifty1.com/mcp
FIFTY1_API_BASE_URL=https://erp.fifty1.com/api
PORT=3130
HOST=127.0.0.1
ENV
sudo chmod 640 /etc/fifty1-erp-mcp.env
sudo chown root:fifty1-mcp /etc/fifty1-erp-mcp.env
```

Der Code gehört `root` und ist für den Dienst nur lesbar; der Dienst schreibt nichts auf die Platte.

### systemd

Die Unit liegt im Repo unter [`deploy/fifty1-erp-mcp.service`](../deploy/fifty1-erp-mcp.service):

```ini
[Service]
User=fifty1-mcp
Group=fifty1-mcp
WorkingDirectory=/opt/fifty1-erp-mcp
EnvironmentFile=/etc/fifty1-erp-mcp.env
ExecStart=/usr/bin/node dist/http.js
Restart=always
```

```bash
sudo cp /opt/fifty1-erp-mcp/deploy/fifty1-erp-mcp.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fifty1-erp-mcp
sudo systemctl status fifty1-erp-mcp
journalctl -u fifty1-erp-mcp -f        # Logs
```

### Update

```bash
cd /opt/fifty1-erp-mcp
sudo git pull
sudo npm ci
sudo systemctl restart fifty1-erp-mcp
```

Laufende Tool-Aufrufe werden beim Neustart noch zu Ende geführt (bis zu 10 s); da der Server keine Sitzungen hält, merken die Clients davon nichts.

## Weiterleitung in Plesk (nginx)

In Plesk läuft nginx vor Apache. `/mcp` wird direkt in nginx an Node weitergereicht – so laufen die JSON-RPC-Anfragen nicht zusätzlich durch Apache und dessen ModSecurity-Regeln. In Plesk unter **Websites & Domains → erp.fifty1.com → Hosting & DNS → Apache & nginx Settings → „Additional nginx directives"**:

```nginx
# Remote-MCP-Server (fifty1-erp-mcp, systemd-Dienst fifty1-erp-mcp, Port 3130).
location = /mcp {
    proxy_pass http://127.0.0.1:3130;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_read_timeout 120s;
}
```

Dazu:

- **Nur über das Panel eintragen.** Plesk bindet eigene nginx-Direktiven nur ein, wenn sie dort gesetzt sind; die CLI (`plesk bin domain`) kennt dafür in Plesk Obsidian 18.0.80 keine Option, und die generierte `nginx.conf` wird bei jeder Neuerzeugung überschrieben.
- **`proxy_set_header Host $host` ist Pflicht.** Der Server lässt zum Schutz vor DNS-Rebinding nur Anfragen mit dem Host aus `MCP_PUBLIC_URL` (sowie `localhost`/`127.0.0.1` für Prüfungen auf dem Server selbst) zu; ohne die Zeile käme `127.0.0.1` an und die Prüfung liefe ins Leere.
- `location = /mcp` trifft genau diesen Pfad; der `Authorization`-Header wird von nginx unverändert weitergereicht.
- Die Metadaten unter `/.well-known/oauth-protected-resource/mcp` und die API unter `/api/…` bleiben beim ERP (Apache/PHP) – sie liegen nicht unter `/mcp`.
- Der Server antwortet mit einfachem JSON statt Server-Sent Events; `proxy_buffering off` schadet trotzdem nicht.

**Alternative ohne nginx** (reiner Apache): unter „Additional directives for HTTPS" `ProxyPreserveHost On`, `ProxyPass /mcp http://127.0.0.1:3130/mcp` und `ProxyPassReverse /mcp http://127.0.0.1:3130/mcp`.

## Prüfen

Auf dem Server selbst:

```bash
curl -s http://127.0.0.1:3130/healthz
# {"status":"ok"}
```

Von außen:

```bash
# Ohne Token: 401 mit Verweis auf die Metadaten
curl -si -X POST https://erp.fifty1.com/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
# HTTP/1.1 401 Unauthorized
# WWW-Authenticate: Bearer error="invalid_token", …, resource_metadata="https://erp.fifty1.com/.well-known/oauth-protected-resource/mcp"

# Die Metadaten selbst (liefert das ERP)
curl -s https://erp.fifty1.com/.well-known/oauth-protected-resource/mcp
```

Antwortet der erste Aufruf mit `404` oder einer ERP-Seite, greift die Apache-Direktive nicht. `502`/`503` heißt: Apache erreicht den Node-Prozess nicht (`systemctl status fifty1-erp-mcp`).

Eine Anfrage mit gültigem Token, die mit `500` und `server_error` endet, bedeutet: Der Server erreicht das ERP-Endpoint `/api/oauth/tokeninfo` nicht — `FIFTY1_API_BASE_URL` und die Logs prüfen. Absichtlich kein `401`, damit Clients bei einer ERP-Störung nicht in eine Schleife aus Neuanmeldungen geraten.

### Mit dem MCP Inspector

```bash
npx @modelcontextprotocol/inspector
```

Im Browser als Transport **Streamable HTTP** wählen, URL `https://erp.fifty1.com/mcp` eintragen und über **Open Auth Settings → Quick OAuth Flow** anmelden. Danach **Connect** und unter **Tools → List Tools** die Tools abrufen. Der Inspector registriert sich dabei als eigener OAuth-Client beim ERP — genau wie claude.ai oder ChatGPT.

### Lokal gegen den Docker-Stack des ERP

Der nginx des ERP-Docker-Stacks leitet `http://localhost:8080/mcp` an `host.docker.internal:3030` weiter – lokal liegt der MCP damit wie in Produktion unter der ERP-Adresse, und die Audience, die das ERP ableitet (`http://localhost:8080/mcp`), passt ohne weitere Konfiguration:

```bash
MCP_PUBLIC_URL=http://localhost:8080/mcp \
FIFTY1_API_BASE_URL=http://localhost:8080/api \
HOST=0.0.0.0 \
npm run start:http
```

`HOST=0.0.0.0` ist nötig, weil der nginx-Container den Prozess über das Docker-Netz erreicht, nicht über `127.0.0.1` (der Port ist damit auch im lokalen Netz offen – nur für die Entwicklung). Im Inspector bzw. mit `claude mcp add --transport http fifty1-erp-local http://localhost:8080/mcp` dann `http://localhost:8080/mcp` verwenden. Ein `502` von nginx heißt: der Node-Prozess läuft nicht.
