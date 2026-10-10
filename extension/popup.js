/**
 * Toolbar popup: opens the config page in a tab.
 */
document.getElementById('openBtn')?.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('app.html') });
  window.close();
});
