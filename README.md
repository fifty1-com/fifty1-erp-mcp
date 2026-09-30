# fifty1-erp-mcp

MCP-Server für das [fifty1 ERP](../fifty1-erp). Gibt Claude (claude.ai, Desktop, Code), ChatGPT und Codex Zugriff auf Projekte, Projektcontrolling, Kunden, Rechnungen, Zeiteinträge und Stammdaten.

Es gibt zwei Wege, den Server zu nutzen:

- **Remote-Connector (empfohlen):** Der Server läuft auf dem ERP-Host unter `https://erp.fifty1.com/mcp`. Man trägt nur die URL ein und meldet sich im Browser beim ERP an — kein Token, keine lokale Installation. Funktioniert mit claude.ai, Claude Desktop, ChatGPT und Claude Code.
- **Lokal mit API-Token:** Der Server läuft über stdio auf dem eigenen Rechner und spricht mit einem API-Token aus dem ERP. Für Clients ohne Remote-MCP, für Automatisierungen und für die Arbeit am Server selbst.

## Einrichtung als Remote-Connector

Connector-URL: **`https://erp.fifty1.com/mcp`**

**claude.ai / Claude Desktop:** Einstellungen → Connectors → **Add custom connector**, Name z.B. „fifty1 ERP", URL eintragen. Beim Verbinden öffnet sich das ERP-Login; mit Passkey oder Passwort + TOTP anmelden und den Zugriff bestätigen. In claude.ai angelegte Connectors stehen auch in Claude Desktop zur Verfügung.

**ChatGPT:** Einstellungen → Connectors (bzw. Apps) → neuen Connector anlegen, URL eintragen, Authentifizierung **OAuth**. Die Anmeldung läuft wie oben im Browser über das ERP. Je nach ChatGPT-Plan muss dafür der Entwicklermodus aktiviert sein.

**Claude Code:**

```bash
claude mcp add --transport http fifty1-erp https://erp.fifty1.com/mcp
```

Danach in Claude Code `/mcp` aufrufen, `fifty1-erp` wählen und authentifizieren — der Browser öffnet das ERP-Login.

Der Client verwaltet die Anmeldung selbst und erneuert sie bei Bedarf. Wird der Zugriff im ERP widerrufen, greift das spätestens nach einer Minute.

## Berechtigungen

Ein Remote-Connector darf genau das, was der angemeldete Mitarbeiter auch im ERP darf — er verhält sich wie ein persönlicher Token: Die `api.*`-Berechtigungen der Endpoints werden auf die Rollenrechte gemappt. Zwei Punkte, die dabei auffallen können:

- Wo es ein `_all`-Recht gibt, wird es verlangt (`projects.view_all` für `list_projects`). Wer nur `projects.view_own` hat, bekommt `403`, weil die Endpoints nicht zeilenweise gefiltert sind.
- `list_invoices` braucht beide Blickrichtungen: `invoices.view_ar_all` **und** `invoices.view_er_all`.

Betrieb, Apache-Konfiguration und Fehlersuche auf dem Server: [`docs/deployment.md`](docs/deployment.md).

## Alternative: lokal mit API-Token

Der Server läuft dabei über stdio auf dem eigenen Rechner und spricht per HTTPS mit `public/api.php` des ERP. Das setzt einen Client voraus, der lokale Server starten kann — Claude Desktop, Claude Code und Codex tun das.

### 1. Token im ERP anlegen

**Persönlicher Token:** Im ERP unter **Profil → API-Tokens** einen Token erstellen (z.B. „Claude"). Dort steht auch eine fertige, bereits ausgefüllte Konfiguration zum Kopieren. Er hat dieselben Rechte wie ein Remote-Connector (siehe [Berechtigungen](#berechtigungen)).

**Für Automatisierungen — Service-Token:** Unter **Einstellungen → API Tokens** (braucht `settings.edit`) mit explizit ausgewählten `api.*`-Berechtigungen. Sinnvoll für n8n und ähnliche Dienste, die keinem Mitarbeiter gehören. Ein Token ohne Auswahl bekommt Vollzugriff — das ist selten gewollt.

| Zweck | Berechtigungen (Service-Token) |
|---|---|
| Nur lesen | `api.projects.read`, `api.customers.read`, `api.invoices.read`, `api.timeentries.read`, `api.budgets.read`, `api.employees.read`, `api.expenses.read`, `api.projects.team.read`, `api.projects.milestones.read`, `api.projects.resourceplanning.read`, `api.projects.controlling.read` |
| Zusätzlich schreiben | `api.projects.update`, `api.projects.team.manage`, `api.projects.milestones.manage`, `api.projects.resourceplanning.manage`, `api.expenses.create`, `api.expenses.update`, `api.customers.create`, `api.customers.update`, `api.invoices.update`, `api.projects.create` |

In beiden Fällen wird der Token nur einmal angezeigt.

### 2. In den MCP-Client eintragen

Die Seite **Profil → API-Tokens** zeigt beide Blöcke bereits mit eingesetztem Token und der richtigen Base-URL — von dort kopieren spart das Ausfüllen.

**Claude Desktop:** Einstellungen → Entwickler → Konfiguration bearbeiten (`claude_desktop_config.json`).
**Claude Code:** `.mcp.json` im Projektverzeichnis.

```json
{
  "mcpServers": {
    "fifty1-erp": {
      "command": "npx",
      "args": ["-y", "github:fifty1-com/fifty1-erp-mcp"],
      "env": {
        "FIFTY1_API_BASE_URL": "https://erp.fifty1.com/api",
        "FIFTY1_API_TOKEN": "<Token aus dem ERP>"
      }
    }
  }
}
```

**Codex:** in `~/.codex/config.toml` ergänzen (TOML statt JSON):

```toml
[mcp_servers.fifty1-erp]
command = "npx"
args = ["-y", "github:fifty1-com/fifty1-erp-mcp"]

[mcp_servers.fifty1-erp.env]
FIFTY1_API_BASE_URL = "https://erp.fifty1.com/api"
FIFTY1_API_TOKEN = "<Token aus dem ERP>"
```

Bei Codex muss unter `command` meist der vollständige Pfad zu `npx` stehen (`which npx`, z.B. `/Users/name/.nvm/versions/node/v24.18.1/bin/npx`).

`npx` holt das Repo beim ersten Start, baut es (`prepare`) und startet den Server — es muss nichts geklont oder installiert werden. Voraussetzung ist Lesezugriff auf das Repo; auf privaten Repos braucht der Rechner hinterlegte GitHub-Zugangsdaten (SSH-Key oder `gh auth login`).

**Wenn Claude den Server nicht startet** (`spawn npx ENOENT`): Programme mit Fenster erben unter macOS nicht den PATH der Kommandozeile, deshalb findet Claude Desktop ein über nvm installiertes Node nicht. Vollständigen Pfad mit `which npx` ermitteln und statt `"npx"` eintragen. In Claude Code tritt das nicht auf.

### Lokale Kopie

Für Arbeiten am Server selbst:

```bash
git clone git@github.com:fifty1-com/fifty1-erp-mcp.git
cd fifty1-erp-mcp
npm install          # baut gleich mit (prepare)
```

Dann in der Konfiguration `"command": "node"` und `"args": ["/absoluter/pfad/zu/fifty1-erp-mcp/dist/index.js"]` verwenden. Beide Werte lassen sich alternativ in einer `.env` setzen (siehe `.env.example`) — praktisch gegen eine lokale ERP-Instanz auf `http://localhost:8080/api`.

## Tools

### Projekte
| Tool | Zweck |
|---|---|
| `list_projects` | Projekte filtern (Status, Kunde, Freitext) |
| `get_project` | Projektdetail inkl. Tätigkeiten und erlaubter Status/Phasen |
| `update_project` | Stammdaten, Status und Phase ändern |
| `create_lead` | Lead anlegen, optional mit Kunde und Ansprechperson (mit Dedup) |

### Projektcontrolling
| Tool | Zweck |
|---|---|
| `get_project_controlling` | Soll/Ist: Stunden, Umsatz, externe Kosten (ER + Aufwände), DB1, Tagessatz, Budgetverbrauch |
| `get_project_team` / `add_project_team_member` / `update_project_team_member` / `remove_project_team_member` | Teamzusammensetzung |
| `get_project_milestones` / `create_project_milestone` / `update_project_milestone` | Abrechnungsmeilensteine inkl. Rechnungsverknüpfung |
| `get_project_resource_planning` / `set_project_resource_planning` / `delete_project_resource_planning` | Monatliche Ressourcenplanung (Soll neben Ist) |
| `get_project_expenses` / `create_project_expense` / `update_project_expense` | Projektausgaben |
| `list_budgets` | Budgetpositionen eines Projekts |

### Kunden, Rechnungen, Stammdaten
| Tool | Zweck |
|---|---|
| `list_customers` / `get_customer` / `create_customer` / `update_customer` | CRM |
| `list_invoices` / `get_invoice` / `update_invoice_status` | Rechnungen (Statuswechsel nur für AR) |
| `list_time_entries` | Zeiteinträge über alle Mitarbeiter |
| `list_employees` / `list_cost_centers` | Stammdaten |

## Verhalten, das man kennen sollte

- **Fehlermeldungen des ERP werden durchgereicht.** Lehnt eine Geschäftsregel etwas ab (`422`), ist ihre deutsche Meldung die Antwort — z.B. `Phase kann nur bei Status "Lead" geändert werden`. Bei `403` steht der fehlende Permission-Slug in der Meldung.
- **Eingaben werden vorab geprüft.** Ein unbekannter Meilenstein-Status oder eine FTE-Quote über 100 scheitert im Server, ohne das ERP zu behelligen.
- **Listen sagen, ob es mehr gibt.** Jede Liste liefert `total`, `returned` und `has_more`; die Textzusammenfassung nennt den nächsten `offset`.
- **Beträge tragen immer eine Währung**, IDs immer ein Label (`P-2026-4711 — Website Redesign`).
- **Zeiteinträge brauchen einen Filter.** Mindestens `employee_id`, `project_id` oder ein Zeitraum; der Zeitraum ist auf 92 Tage begrenzt.
- **Nur AR-Rechnungen** können den Status wechseln. Eingangsrechnungen lehnt das ERP ab, weil deren Workflow an eine Benutzersitzung gebunden ist.
- **Ein `403` ist meistens kein Fehler des Servers**, sondern eine fehlende Berechtigung: Beim Remote-Connector und bei einem persönlichen Token entscheiden die Rollen im ERP, bei einem Service-Token die beim Anlegen gesetzte Auswahl. Die Meldung nennt den fehlenden Slug.

## Entwicklung

```bash
npm test          # Vitest
npm run typecheck
npm run build
npm run start:http   # Remote-Modus lokal, Variablen siehe .env.example
```

### Contributing

**Kein neues Tool ohne Test.** Jedes Tool braucht in `test/tools/` mindestens: korrekt aufgebauter Request (Pfad, Methode, Body), Ablehnung ungültiger Eingaben ohne HTTP-Roundtrip, und das erwartete Verhalten bei den ERP-Fehlercodes (403, 404, 422). Die Tests laufen gegen ein gestubbtes `fetch` — kein Testlauf spricht mit einem echten ERP.

Die API-Seite lebt im ERP-Repo (`src/Controllers/McpApiController.php`, dokumentiert in `docs/api.md`). Ändert sich dort ein Endpoint, gehören beide Seiten im selben Schritt angepasst.
