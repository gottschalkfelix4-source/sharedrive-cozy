/* Klassisches Script (kein Modul), damit es vor dem ersten Rendern laeuft
   und ein Aufblitzen des falschen Farbschemas verhindert. */
(function () {
  var root = document.documentElement;
  try {
    var theme = localStorage.getItem('sharedrive.theme');
    var mode = localStorage.getItem('sharedrive.mode');
    if (theme) root.setAttribute('data-theme', theme);
    if (mode) root.setAttribute('data-mode', mode);
  } catch (e) {
    /* Speicher gesperrt - Standardwerte bleiben aktiv */
  }
  if (!root.getAttribute('data-theme')) root.setAttribute('data-theme', 'sunset');
})();
