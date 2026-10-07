# Fremdkomponenten

sharedrive selbst hat **keine** npm-Abhängigkeiten – der Server läuft ausschließlich
mit den eingebauten Node-Modulen. Eine einzige Fremdkomponente ist mitgeliefert:

## qrcode-generator

- Dateien: `public/vendor/qrcode.js`, `public/vendor/qrcode-utf8.js`
- Version: 1.4.4
- Autor: Kazuhiko Arase
- Lizenz: MIT — http://www.opensource.org/licenses/mit-license.php
- Quelle: https://www.npmjs.com/package/qrcode-generator

Der Lizenzhinweis steht unverändert am Anfang beider Dateien. Die Bibliothek wird
nur benutzt, um den Teil-Link als QR-Code zu zeichnen. Sie ist bewusst
mitgeliefert statt per CDN geladen, damit die strenge Content-Security-Policy
(keine externen Skripte) eingehalten wird und keine Verbindung zu Dritten
entsteht.

> „QR Code“ ist eine eingetragene Marke der DENSO WAVE INCORPORATED.
