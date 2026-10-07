# sharedrive

Ein selbstgehosteter Dateitransfer mit **echter Ende-zu-Ende-Verschlüsselung** und
einer warmen, farbenfrohen Oberfläche. Gebaut, um auf dem eigenen Server zu laufen —
auf Unraid als Docker-Container, hinter einem Reverse Proxy oder direkt mit TLS.

Der Kern in einem Satz: **Dateien werden im Browser verschlüsselt, der Schlüssel steht
nur im Link, und der Server sieht ihn nie.**

Diese Fassung ist bewusst eigenständig und schlank: **ein einziger Container**, SQLite
statt Datenbank- und Objektspeicher-Diensten, keine npm-Abhängigkeiten. Statt einer
optionalen Verschlüsselung ist hier **jeder** Transfer Ende-zu-Ende-verschlüsselt —
wer den Schlüssel nicht hat, kann auch als Betreiber nicht mitlesen.

---

## Inhalt

- [Was es kann](#was-es-kann)
- [Schnellstart](#schnellstart)
- [Unraid](#unraid)
- [HTTPS ist Pflicht](#https-ist-pflicht)
- [Konfiguration](#konfiguration)
- [Benachrichtigungen](#benachrichtigungen)
- [Upload-Portale (Reverse Share)](#upload-portale-reverse-share)
- [Sicherheitsmodell](#sicherheitsmodell)
- [Aufbau des Projekts](#aufbau-des-projekts)
- [Entwicklung und Tests](#entwicklung-und-tests)
- [Wenn etwas nicht klappt](#wenn-etwas-nicht-klappt)

---

## Was es kann

**Senden**
- Mehrere Dateien oder ganze Ordner per Ziehen, Klicken oder Einfügen – Ordnerstrukturen bleiben erhalten
- Verschlüsselung im Browser (AES-256-GCM), 4-MiB-Chunks, paralleler Upload
- Fortschritt pro Datei, Geschwindigkeit, Restzeit, Pause und Fortsetzen
- Automatische Wiederholversuche; bereits übertragene Teile werden nicht erneut gesendet
- Ablaufzeit (1 Stunde bis 30 Tage), Download-Limit pro Empfänger
- Optionales Passwort als zweite Schicht
- Nachricht an die Empfänger – ebenfalls verschlüsselt
- Link kopieren, QR-Code, Teilen-Menü, E-Mail-Vorlage

**Empfangen**
- Übersichtsseite mit entschlüsselten Dateinamen, Größen und Nachricht
- Einzel-Download oder „alle herunterladen“
- Mit File System Access API (Chrome, Edge) schreibt „In Ordner speichern“ direkt
  gestreamt in einen gewählten Ordner – auch bei mehreren GB ohne Speicherprobleme
- Vorschau für Bilder, Videos und Audio, direkt aus dem entschlüsselten Strom
- Der Schlüssel wird nach dem Entschlüsseln sofort aus der Adresszeile entfernt

**Verwalten (`/admin`)**
- Übersicht: Anzahl Transfers, belegter Speicher, Downloads, Portale
- Verlauf der Downloads der letzten 14 Tage
- Alle Transfers mit Größe, Dateien, Zugriffen, Ablauf; Notizen, Verlängern, Limit, Löschen
- Zugriffsprotokoll pro Transfer (Zeit, Client, IP nur als Prüfsumme)
- Upload-Portale anlegen, verwalten, Schlüssel sichern
- Erscheinungsbild ändern (Name, Untertitel, Farbwelt)
- Wartung: Aufräumen, Test-Benachrichtigung, aktuelle Konfiguration

**Betrieb**
- Abgelaufene Transfers werden stündlich automatisch entfernt (Dateien, Datenbank, Protokoll)
- Download-Log wird nach der eingestellten Frist gelöscht
- Speicher-Quota, maximale Transfergröße, Rate-Limits
- Optionale Benachrichtigungen bei Download oder neuem Portal-Upload
- Vier Farbschemata, heller und dunkler Modus, installierbar als App (PWA)

---

## Schnellstart

Voraussetzung: **Node.js 24 (mindestens 22.13)**. Es gibt keine npm-Abhängigkeiten —
der Server nutzt ausschließlich eingebaute Node-Module, darunter die eingebaute
SQLite-Unterstützung (`node:sqlite`), die erst ab Node 22.13 ohne Schalter verfügbar
ist. Bei älteren Versionen bricht der Start mit einem entsprechenden Hinweis ab.

```bash
cp .env.example .env
# ADMIN_PASSWORD in der .env setzen!
npm start
```

Danach im Browser öffnen: <http://localhost:3000> – Dashboard unter
<http://localhost:3000/admin>.

`localhost` gilt als sicherer Kontext, deshalb funktioniert die Verschlüsselung dort
auch ohne HTTPS. Für jede andere Adresse ist HTTPS nötig (siehe unten).

### Mit Docker

```bash
docker compose up -d --build
```

Die Beispieldatei [`docker-compose.yml`](docker-compose.yml) enthält alle wichtigen
Schalter als Kommentar. Der Ordner `./data` wird als Volume eingebunden.

### Fertiges Abbild ziehen

Bei jedem Push nach `main` wird das Abbild automatisch getestet, gebaut und
veröffentlicht. Es braucht keine npm-Abhängigkeiten und keinen Bau-Schritt:

```bash
docker pull ghcr.io/gottschalkfelix4-source/sharedrive-cozy:latest
```

Das veröffentlichte Abbild ist **rund 59 MB** groß, läuft als Benutzer `node`
statt als root und bringt einen Healthcheck mit.

Es wird für `linux/amd64` gebaut — das passt für praktisch jeden Unraid-Server.
Auf einem ARM-Rechner lässt sich in
[`.github/workflows/container.yml`](.github/workflows/container.yml) eine Zeile
`platforms: linux/amd64,linux/arm64` ergänzen (dann zusätzlich
`docker/setup-qemu-action` einbinden).

### Ohne Docker

```bash
node server/index.js
```

Für einen dauerhaften Betrieb eignet sich ein systemd-Service oder ein Prozessmanager;
der Server beendet sich bei `SIGTERM` sauber.

---

## Unraid

### Empfohlen: Template in die WebGUI importieren

Das fertige Abbild liegt öffentlich auf ghcr.io – Unraid kann es ohne Anmeldung
ziehen. Im **Webterminal** des Servers (oder per SSH) eine Zeile ausführen:

```bash
mkdir -p /boot/config/plugins/dockerMan/templates-user && \
curl -fsSL -o /boot/config/plugins/dockerMan/templates-user/my-sharedrive-cozy.xml \
  https://raw.githubusercontent.com/gottschalkfelix4-source/sharedrive-cozy/main/unraid-template.xml
```

Danach in der WebGUI: **Docker → Add Container**, im Auswahlfeld *Template* unter
**User templates** den Eintrag **sharedrive-cozy** wählen. (Unraid beschriftet die
Einträge mit dem Dateinamen ohne `my-` und `.xml` – deshalb taucht dort
nicht der Dateiname `my-sharedrive-cozy` auf.) Alle Felder sind vorbereitet:

| Feld | Was eintragen |
|---|---|
| Weboberfläche | Host-Port, Standard **3080** (intern bleibt es 3000) |
| Datenordner | `/mnt/user/appdata/sharedrive-cozy` – am besten auf SSD oder Cache-Pool |
| **Admin-Passwort** | **Pflicht.** Bleibt es leer, verweigert der Server das Dashboard |
| Öffentliche Adresse | z. B. `https://share.example.com` (für korrekte Links und QR-Codes) |
| Hinter Reverse Proxy | `1`, sobald ein Proxy davorsteht |
| Maximale Transfergröße | Standard 20 GiB |

Zum Aktualisieren des Templates später einfach den `curl`-Befehl wiederholen.

### Ohne Template, direkt auf der Kommandozeile

Wer nicht auf die WebGUI warten will – Achtung, so angelegte Container verwaltet
Unraid nicht mit (kein Autostart nach Neustart):

```bash
docker run -d --name sharedrive-cozy --restart unless-stopped -p 3080:3000 \
  -v /mnt/user/appdata/sharedrive-cozy:/data \
  -e ADMIN_PASSWORD='dein-passwort' \
  -e INSTANCE_NAME='sharedrive' \
  ghcr.io/gottschalkfelix4-source/sharedrive-cozy:latest
```

### Selbst bauen statt ziehen

Das [`docker-compose.yml`](docker-compose.yml) im Projekt baut das Abbild selbst.
Es verwendet bewusst den Container-Namen `sharedrive-cozy` und Host-Port **3080**,
damit eine andere Instanz auf Port 3000 unberührt bleibt:

```bash
git clone https://github.com/gottschalkfelix4-source/sharedrive-cozy.git
cd sharedrive-cozy
# ADMIN_PASSWORD in docker-compose.yml eintragen!
docker compose up -d --build
```

### Danach: HTTPS einrichten

**Für den Zugriff aus dem Internet** einen Reverse Proxy mit TLS davorsetzen —
auf Unraid ist Cloudflare Tunnel oder SWAG/nginx-proxy-manager üblich. Dabei:
- `PUBLIC_URL` auf die öffentliche Adresse setzen, z. B. `https://share.example.com`
- `TRUST_PROXY=1` setzen

**Innerhalb des LAN** funktioniert `http://192.168.x.x:3080` bewusst nicht für
die Verschlüsselung (siehe nächster Abschnitt). Zwei Wege:
- die Instanz ebenfalls über den Reverse Proxy mit gültigem Zertifikat erreichen, oder
- direktes TLS im Container aktivieren: Zertifikat nach `/mnt/user/appdata/sharedrive-cozy/certs`
  legen, diesen Ordner als Pfad einbinden und `TLS_CERT`/`TLS_KEY` darauf zeigen lassen.

Die Vorlage selbst liegt im Projekt als [`unraid-template.xml`](unraid-template.xml).

---

## HTTPS ist Pflicht

Browser stellen die Verschlüsselungs-API (`crypto.subtle`) **nur in sicheren
Kontexten** bereit: `https://`, `localhost` und `127.0.0.1`. Über eine nackte
LAN-IP wie `http://192.168.188.129:3080` gibt es sie nicht – und ohne sie kann
sharedrive nicht arbeiten.

Die Oberfläche prüft das und sagt es deutlich, statt stillschweigend unverschlüsselt
zu senden. Für den Zugriff von außen ist HTTPS ohnehin nötig und richtig.

Drei Wege zu HTTPS:

| Weg | Wann sinnvoll |
|---|---|
| Cloudflare Tunnel | Kein Port freigeben, Zertifikat inklusive, funktioniert auch im LAN über den Hostnamen |
| Reverse Proxy (SWAG, Nginx Proxy Manager) mit Let's Encrypt | Klassisch, wenn Port 80/443 erreichbar ist |
| `TLS_CERT` + `TLS_KEY` direkt setzen | Kein Proxy, direktes HTTPS mit eigenem Zertifikat |

---

## Konfiguration

Alles läuft über Umgebungsvariablen oder die `.env`-Datei. Die vollständige Liste
steht in [`.env.example`](.env.example); die wichtigsten:

| Variable | Standard | Bedeutung |
|---|---|---|
| `PORT` | `3000` | Port der Weboberfläche |
| `DATA_DIR` | `./data` | Ablage für verschlüsselte Chunks und Datenbank |
| `PUBLIC_URL` | – | Öffentliche Adresse für Links und QR-Codes |
| `TRUST_PROXY` | `0` | Hinter Reverse Proxy auf `1` setzen |
| `ADMIN_PASSWORD` | – | **Pflicht.** Passwort für `/admin` |
| `MAX_TRANSFER_BYTES` | 20 GiB | Maximale Größe eines Transfers |
| `STORAGE_QUOTA_BYTES` | `0` | Obergrenze für alles zusammen, `0` = unbegrenzt |
| `DEFAULT_EXPIRY_HOURS` | `168` | Standard-Ablauf (7 Tage) |
| `MAX_EXPIRY_HOURS` | `720` | Obergrenze (30 Tage) |
| `DOWNLOAD_LOG_RETENTION_DAYS` | `30` | Aufbewahrung der Zugriffseinträge |
| `TLS_CERT`, `TLS_KEY` | – | Direktes HTTPS ohne Proxy |

Der Standard-Chunk ist 4 MiB. Der Speicherbedarf im Browser beim Senden liegt damit bei
rund 20 MiB, unabhängig von der Dateigröße.

Das Session-Secret für die Admin-Anmeldung wird beim ersten Start automatisch erzeugt
und in `DATA_DIR/session.secret` abgelegt. Es steht bewusst nicht in der `.env` und
gehört nicht ins Repository.

---

## Benachrichtigungen

`NOTIFY_TYPE` wählt den Weg, alles andere folgt daraus:

**ntfy** (z. B. die Unraid-App, empfohlen für Handy-Push)
```
NOTIFY_TYPE=ntfy
NOTIFY_URL=https://ntfy.sh/mein-thema
```

**Discord**
```
NOTIFY_TYPE=discord
NOTIFY_URL=https://discord.com/api/webhooks/...
```

**Beliebiger Webhook** (bekommt JSON mit `subject`, `body`, `kind`, `transferId`)
```
NOTIFY_TYPE=json
NOTIFY_URL=https://example.com/hook
```

**E-Mail ohne Zusatzpaket** – es ist ein kleiner SMTP-Client eingebaut
(STARTTLS, implizites TLS und unverschlüsselt):
```
NOTIFY_TYPE=smtp
NOTIFY_EMAIL_TO=ich@example.com
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=benutzer
SMTP_PASS=passwort
SMTP_FROM=sharedrive@example.com
```
Im Dashboard unter *Wartung* gibt es einen Testknopf.

---

## Upload-Portale (Reverse Share)

Ein Upload-Portal ist ein Link, über den **andere dir** Dateien schicken können.

Technisch läuft das über das Schlüsselpaar des Eigentümers:

1. Beim Anlegen erzeugt dein Browser ein ECDH-Schlüsselpaar (P-256).
   Der **öffentliche** Teil landet im Link für die Uploader, der **private** bleibt
   ausschließlich im Browserspeicher.
2. Jeder Upload erzeugt ein eigenes, flüchtiges Schlüsselpaar und leitet daraus per
   ECDH einen gemeinsamen Schlüssel ab.
3. Nur du – mit dem privaten Schlüssel – kannst diesen Upload wieder öffnen.

Daraus folgt: **Uploader können gegenseitig nicht mitlesen**, und der Server kann es
ohnehin nicht. Es folgt aber auch, dass du den privaten Schlüssel sichern musst:
**verschwindet er, sind eingegangene Uploads nicht mehr lesbar.** Das Dashboard bietet
dafür einen Export an (Button *Schlüssel exportieren*) und erinnert nach dem Anlegen
daran. Auf einem anderen Gerät lässt sich die Datei wieder importieren.

---

## Sicherheitsmodell

### Was der Server sieht

| Angabe | Sichtbar für den Server? |
|---|---|
| Dateiinhalte | **Nein** – AES-256-GCM, Schlüssel nur im Browser |
| Dateinamen, Ordnernamen, Dateitypen | **Nein** – liegen verschlüsselt in den Metadaten |
| Nachricht an die Empfänger | **Nein** – Teil der verschlüsselten Metadaten |
| Der Schlüssel | **Nie** – steckt im URL-Fragment, das Browser nie übertragen |
| Passwort | **Nie** – wird nur im Browser ausgewertet |
| Größe, Anzahl und Anzahl der Chunks | Ja (technisch unvermeidbar) |
| Zeitpunkte von Erstellung und Abruf | Ja |
| IP-Adresse | Nur als HMAC-Prüfsumme |

### Wie es gebaut ist

- **Schlüssel**: 32 zufällige Bytes pro Transfer, ausschließlich im URL-Fragment (`#k=…`).
  Das Fragment wird von Browsern nicht an einen Server gesendet – nicht bei der
  Anfrage, nicht im Referer, nicht in Logs.
- **Chunks**: je Datei ein eigener Schlüssel, abgeleitet per HKDF-SHA256. Der
  Initialisierungsvektor ist ein Zähler über die Chunk-Nummer; da jeder Dateischlüssel
  nur einmal vorkommt, kann sich kein (Schlüssel, IV)-Paar wiederholen. Ein
  Nonce-Reuse-Fehler – der klassische Bruch von GCM – ist damit strukturell ausgeschlossen.
- **Metadaten**: eigenes HKDF-Zweig, AES-GCM mit zufälligem IV. Jede Manipulation
  an Namen oder Größen fällt über das GCM-Tag auf.
- **Passwortschutz**: PBKDF2-SHA256 mit 600.000 Runden und zufälligem Salt erzeugt
  einen Schlüssel, der den eigentlichen Schlüssel umhüllt. Auf dem Server liegt nur
  diese Hülle.
- **Uploads**: signierte Tokens, widerrufbar mit dem Server-Secret; Größenangaben
  werden serverseitig auf Konsistenz geprüft.
- **Absicherung der API**: strenge Content-Security-Policy ohne Inline-Skripte und
  ohne Inline-Styles, `X-Content-Type-Options`, `Referrer-Policy: no-referrer`,
  Herkunftsprüfung bei schreibenden Anfragen, `SameSite=Strict` für die Admin-Sitzung,
  Rate-Limits pro IP und Sitzung, `noindex` für alle Transfer-Seiten.
- **Keine Dritten**: keine externen Schriften, Skripte, Analysen oder Tracker. Die
  einzige Fremdkomponente ist eine mitgelieferte QR-Bibliothek (siehe
  [`THIRD-PARTY.md`](THIRD-PARTY.md)).

### Ehrliche Grenzen

- **Passwortschutz ist stark, aber nicht unknackbar.** Wer die Hülle kennt, kann
  offline Passwörter durchprobieren. Die 600.000 PBKDF2-Runden machen das teuer, ein
  schwaches Passwort bleibt schwach. Deshalb: Link und Passwort getrennt übermitteln.
- **Metadaten sind minimiert, aber nicht null.** Der Server weiß, wie viele Dateien
  wie groß zu welcher Zeit heruntergeladen wurden. Das ist für den Betrieb und die
  Anzeige nötig; wer das ausschließen will, braucht einen anderen Aufbau (etwa reinen
  Peer-to-Peer-Transfer).
- **Der Link ist der Schlüssel.** Wer ihn hat, kommt an die Dateien. Es gibt bewusst
  keine Hintertür und keine Schlüsselkopie – verlorene Links sind verlorene Daten.
- **Kein Virenscan.** Dateien sind verschlüsselt, ein serverseitiger Scan ist damit
  grundsätzlich nicht möglich.
- **Kein Konto-System.** Es gibt ein Admin-Passwort für genau eine Person; mehrere
  Benutzer mit eigenen Konten sind nicht vorgesehen.

---

## Aufbau des Projekts

```
server/
  index.js         HTTP-Server, Routen, Sicherheits-Header, Herkunftsprüfung
  config.js        Konfiguration aus Umgebungsvariablen, .env-Lader
  db.js            SQLite-Schema, Migrationen und alle Abfragen
  crypto.js        scrypt-Hashing, signierte Tokens, Sitzungen, Rate-Limits
  storage.js       Ablage der verschlüsselten Chunks
  http.js          Mini-Router, Antworten, statische Dateien
  cleanup.js       Aufräumen abgelaufener Transfers
  notifications.js Benachrichtigungen (json, ntfy, discord, smtp)
  smtp.js          kleiner SMTP-Client
  api/
    transfers.js   Anlegen, Upload, Download, Zählung
    requests.js    Upload-Portale
    admin.js       Anmeldung, Übersicht, Verwaltung
public/
  index.html       Senden
  t.html           Empfangen
  r.html           Upload-Portal
  admin.html       Verwaltung
  legal.html       Rechtliches und Datenschutz
  css/style.css    Design-System (vier Farbwelten, hell/dunkel)
  js/
    sr-crypto.js   gesamte Kryptografie im Browser
    sr-upload.js   verschlüsselter, wiederaufnehmbarer Upload
    sr-receive …   Empfangen, Zusammenführen, Vorschau
    sr-manifest.js Metadaten mit Serverangaben zusammenführen
    sr-picker.js   Dateiauswahl und Fortschrittsanzeige
    sr-shell.js    Kopfzeile, Erscheinungsbild, Dialoge
    sr-portal.js   lokaler Portal-Schlüssel
    app-*.js       Logik der einzelnen Seiten
  vendor/qrcode.js mitgelieferte QR-Bibliothek (MIT)
test/              automatische Tests (Kryptografie, API, Zusammenführung)
```

Der Code ist bewusst ohne Baukasten und ohne npm-Pakete geschrieben: damit lässt sich
die Sicherheit nachlesen, das Docker-Abbild klein halten und die Verschlüsselung
direkt testen, weil dieselben Module im Browser und in Node laufen.

---

## Entwicklung und Tests

```bash
npm start          # Server starten
npm run dev        # mit automatischem Neustart
npm test           # alle Tests
npm run test:crypto
npm run test:api
```

Die Tests prüfen nicht nur, dass Code läuft, sondern die zugesagten Eigenschaften –
unter anderem:

- Ver- und Entschlüsselung über Chunk-Grenzen, leere Dateien, Umlaute und Ordnernamen
- Manipulierte Chunks, falsche Schlüssel und falsche Chunk-Indizes werden erkannt
- Im URL-Fragment steckt der Schlüssel, in den Serverantworten **kein** Klartext
- Ein falsches Passwort öffnet nichts; zwei Empfänger erzeugen verschiedene Hüllen
- Download-Limit zählt pro Empfänger und sperrt danach
- Upload-Token ist Pflicht, Größenangaben werden geprüft
- Fremde Herkunft wird bei schreibenden Anfragen abgewiesen
- Reverse Share: nur der Schlüssel des Eigentümers öffnet einen Upload
- Abgelaufenes wird von Platte **und** Datenbank entfernt
- Datenbank-Migrationen laufen auf einem älteren Stand durch

---

## Wenn etwas nicht klappt

**„Ohne HTTPS steht die Browser-Verschlüsselung nicht bereit."**
Die Seite läuft über eine nackte IP ohne TLS. Siehe [HTTPS ist Pflicht](#https-ist-pflicht).

**Links zeigen auf die falsche Adresse**
`PUBLIC_URL` setzen, damit Links und QR-Codes stimmen.

**Anmeldung am Dashboard schlägt fehl**
`ADMIN_PASSWORD` prüfen und den Container neu starten. Ohne gesetztes Passwort bleibt
das Dashboard gesperrt; im Log steht ein entsprechender Hinweis.

**Hinter dem Proxy erscheinen alle Zugriffe mit derselben IP**
`TRUST_PROXY=1` setzen, damit `X-Forwarded-For` ausgewertet wird.

**Upload bleibt hängen**
Der Fortschritt bleibt stehen und nach einigen Versuchen erscheint ein Fehler. Prüfen,
ob der Reverse Proxy große Anfragen durchlässt (`client_max_body_size` in nginx,
Puffergrößen), und ob genug Speicher frei ist. Ein Neustart des Browsers hilft nicht –
das Aufräumen entfernt abgebrochene Uploads nach 48 Stunden automatisch.

**Kein Platz mehr**
`STORAGE_QUOTA_BYTES` setzen oder im Dashboard unter *Wartung* aufräumen. Belegter
Speicher und freier Platz stehen in der Übersicht.

---

## Lizenz

MIT. Die mitgelieferte QR-Bibliothek steht unter eigener MIT-Lizenz
(siehe [`THIRD-PARTY.md`](THIRD-PARTY.md)).
