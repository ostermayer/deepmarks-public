(function () {
  var KEY = 'deepmarks-boot-recovery:v1';
  var WAIT_MS = 10000;

  function isNativeShell() {
    return location.protocol === 'capacitor:' || location.protocol === 'ionic:';
  }

  function shellStillVisible() {
    var shell = document.getElementById('boot-shell');
    return !!shell && getComputedStyle(shell).display !== 'none';
  }

  function setShellMessage(text) {
    var shell = document.getElementById('boot-shell');
    if (!shell) return;
    var nodes = shell.getElementsByTagName('div');
    if (nodes.length > 0) nodes[nodes.length - 1].textContent = text;
  }

  async function clearBrowserCaches() {
    try {
      if ('serviceWorker' in navigator) {
        var regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(function (reg) { return reg.unregister(); }));
      }
    } catch (_) {
      // Continue with cache clearing.
    }
    try {
      if ('caches' in window) {
        var keys = await caches.keys();
        await Promise.all(keys.filter(function (key) {
          return key.indexOf('deepmarks-') === 0;
        }).map(function (key) { return caches.delete(key); }));
      }
    } catch (_) {
      // Nothing else to clear.
    }
  }

  setTimeout(function () {
    if (!shellStillVisible()) return;
    if (!isNativeShell()) return;

    try {
      if (sessionStorage.getItem(KEY) === '1') {
        setShellMessage('loading took too long. force quit and reopen Deepmarks.');
        return;
      }
      sessionStorage.setItem(KEY, '1');
    } catch (_) {
      // Private storage should not block recovery.
    }

    setShellMessage('refreshing app cache...');
    clearBrowserCaches().finally(function () {
      location.reload();
    });
  }, WAIT_MS);
}());
