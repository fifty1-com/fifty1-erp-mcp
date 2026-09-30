# Betrieb des Remote-Servers

Der Remote-Modus (`dist/http.js`) macht den MCP-Server unter `https://erp.fifty1.com/mcp` erreichbar — für claude.ai, ChatGPT, Claude Code und alle anderen Clients, die MCP über Streamable HTTP mit OAuth sprechen.

## Wie die Teile zusammenspielen

```
Client (claude.ai, ChatGPT, …)
   │  HTTPS, Authorization: Bearer f51oa_…
   ▼
Apache auf erp.fifty1.com  ── /mcp ──►  Node: 127.0.0.1:3030/mcp  (dieser Server)
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
| `PORT` | nein | Standard `3030`. |
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
PORT=3030
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

## Apache in Plesk

In Plesk unter **Websites & Domains → erp.fifty1.com → Apache & nginx Settings → Additional Apache directives → „Additional directives for HTTPS"**:

```apache
ProxyPreserveHost On
ProxyPass /mcp http://127.0.0.1:3030/mcp
ProxyPassReverse /mcp http://127.0.0.1:3030/mcp
```

Dazu:

- **`ProxyPreserveHost On` ist Pflicht.** Der Server lässt zum Schutz vor DNS-Rebinding nur Anfragen mit dem Host aus `MCP_PUBLIC_URL` (sowie `localhost`/`127.0.0.1` für Prüfungen auf dem Server selbst) zu; ein fremder Host wird mit `403` abgewiesen. Ohne die Direktive schickt Apache immer `Host: 127.0.0.1:3030` weiter — die Prüfung liefe dann ins Leere.
- **Der `Authorization`-Header wird von `mod_proxy` unverändert weitergereicht.** Anders als bei PHP über FastCGI ist dafür nichts zu konfigurieren.
- Die Rewrite-Regeln des ERP in `.htaccess` greifen für `/mcp` nicht, weil `ProxyPass` die Anfrage vorher an Node übergibt — `/mcp` erreicht nie PHP. `ProxyPass` wirkt als Präfix: Sollte das ERP je eigene Pfade wie `/mcp-…` bekommen, stattdessen `ProxyPassMatch "^/mcp$" "http://127.0.0.1:3030/mcp"` verwenden.
- Die Metadaten unter `/.well-known/oauth-protected-resource/mcp` und die API unter `/api/…` bleiben beim ERP — sie liegen nicht unter `/mcp`.
- Läuft in Plesk nginx als Proxy vor Apache (Standard), reicht nginx `/mcp` an Apache weiter; es ist nichts zusätzlich nötig. Der Server antwortet mit einfachem JSON statt Server-Sent Events, Pufferung durch nginx stört also nicht.
- Nur in den HTTPS-Direktiven eintragen: Über `http://` soll kein Bearer-Token übertragen werden.

## Prüfen

Auf dem Server selbst:

```bash
curl -s http://127.0.0.1:3030/healthz
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
