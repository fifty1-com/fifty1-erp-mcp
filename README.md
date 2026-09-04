# fifty1-erp-mcp

MCP-Server für das [fifty1 ERP](../fifty1-erp). Gibt Claude (Desktop wie Code) Zugriff auf Projekte, Projektcontrolling, Kunden, Rechnungen, Zeiteinträge und Stammdaten.

Der Server läuft **lokal beim Nutzer** über stdio und spricht per HTTPS mit `public/api.php` des ERP — mit einem API-Token aus dem ERP. Auf dem ERP-Server (Plesk) muss dafür nichts installiert werden.

Das bindet ihn zugleich an Clients, die lokale Server starten können. **ChatGPT gehört nicht dazu**: es akzeptiert MCP nur als Remote-Connector über eine öffentlich erreichbare HTTPS-Adresse mit OAuth. Dafür bräuchte es einen zusätzlichen Endpoint samt Anmeldung — bewusst nicht gebaut.

## Einrichtung

### 1. Token im ERP anlegen

**Der übliche Weg — persönlicher Token:** Im ERP unter **Profil → API-Tokens** einen Token erstellen (z.B. „Claude"). Dort steht auch eine fertige, bereits ausgefüllte Konfiguration zum Kopieren.

Ein persönlicher Token darf über die API genau das, was sein Besitzer auch im ERP darf — die `api.*`-Berechtigungen werden auf die Rollenrechte gemappt. Zwei Punkte, die dabei auffallen können:

- Wo es ein `_all`-Recht gibt, wird es verlangt (`projects.view_all` für `list_projects`). Wer nur `projects.view_own` hat, bekommt `403`, weil die Endpoints nicht zeilenweise gefiltert sind.
- `list_invoices` braucht beide Blickrichtungen: `invoices.view_ar_all` **und** `invoices.view_er_all`.

**Für Automatisierungen — Service-Token:** Unter **Einstellungen → API Tokens** (braucht `settings.edit`) mit explizit ausgewählten `api.*`-Berechtigungen. Sinnvoll für n8n und ähnliche Dienste, die keinem Mitarbeiter gehören. Ein Token ohne Auswahl bekommt Vollzugriff — das ist selten gewollt.

| Zweck | Berechtigungen (Service-Token) |
|---|---|
| Nur lesen | `api.projects.read`, `api.customers.read`, `api.invoices.read`, `api.timeentries.read`, `api.budgets.read`, `api.employees.read`, `api.expenses.read`, `api.projects.team.read`, `api.projects.milestones.read`, `api.projects.resourceplanning.read`, `api.projects.controlling.read` |
| Zusätzlich schreiben | `api.projects.update`, `api.projects.team.manage`, `api.projects.milestones.manage`, `api.projects.resourceplanning.manage`, `api.expenses.create`, `api.expenses.update`, `api.customers.create`, `api.customers.update`, `api.invoices.update`, `api.projects.create` |

In beiden Fällen wird der Token nur einmal angezeigt.

### 2. In den MCP-Client eintragen

Die Seite **Profil → API-Tokens** zeigt genau diesen Block bereits mit eingesetztem Token und der richtigen Base-URL — von dort kopieren spart das Ausfüllen.

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

`npx` holt das Repo beim ersten Start, baut es (`prepare`) und startet den Server — es muss nichts geklont oder installiert werden. Voraussetzung ist Lesezugriff auf das Repo; auf privaten Repos braucht der Rechner hinterlegte GitHub-Zugangsdaten (SSH-Key oder `gh auth login`).

**Wenn Claude den Server nicht startet** (`spawn npx ENOENT`): Programme mit Fenster erben unter macOS nicht den PATH der Kommandozeile, deshalb findet Claude Desktop ein über nvm installiertes Node nicht. Vollständigen Pfad mit `which npx` ermitteln und statt `"npx"` eintragen. In Claude Code tritt das nicht auf.

### Alternative: lokale Kopie

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
| `get_project_controlling` | Soll/Ist: Stunden, Umsatz, Kosten, DB1, Tagessatz, Budgetverbrauch |
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
- **Ein `403` ist meistens kein Fehler des Servers**, sondern eine fehlende Berechtigung: Bei einem persönlichen Token entscheiden die Rollen im ERP, bei einem Service-Token die beim Anlegen gesetzte Auswahl. Die Meldung nennt den fehlenden Slug.

## Entwicklung

```bash
npm test          # Vitest
npm run typecheck
npm run build
```

### Contributing

**Kein neues Tool ohne Test.** Jedes Tool braucht in `test/tools/` mindestens: korrekt aufgebauter Request (Pfad, Methode, Body), Ablehnung ungültiger Eingaben ohne HTTP-Roundtrip, und das erwartete Verhalten bei den ERP-Fehlercodes (403, 404, 422). Die Tests laufen gegen ein gestubbtes `fetch` — kein Testlauf spricht mit einem echten ERP.

Die API-Seite lebt im ERP-Repo (`src/Controllers/McpApiController.php`, dokumentiert in `docs/api.md`). Ändert sich dort ein Endpoint, gehören beide Seiten im selben Schritt angepasst.
