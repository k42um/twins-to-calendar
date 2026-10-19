'use strict';

// v1.0.0 で書き出した ICS の予定は、拡張機能を更新しても修正されない。
// 影響を受ける既存ユーザーに限り、v1.0.1 の更新時に案内を表示する。
chrome.runtime.onInstalled.addListener(({ reason, previousVersion }) => {
  if (reason !== 'update' || previousVersion !== '1.0.0') return;
  if (chrome.runtime.getManifest().version !== '1.0.1') return;

  // タブを見逃した場合も、次にポップアップを開いた際に案内できるよう残す。
  chrome.storage.local.set({ holidayCorrectionNoticeV101: true }, () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('update-notice.html') });
  });
});
