import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { KUNLUN_BRAND, type AdminAlertSnapshot } from '@kunlun/shared';
import { Dialog, Icon, useAuth, useToast } from '@kunlun/ui';
import { newNotices, type AdminNotice, type AlertPage } from './alert-events';
import { useGo } from './common';
import { useAdminData } from './data';
import orderVoice from './assets/new-order-zh.mp3';

const POLL_MS = 15000;
const canNotify = () => window.isSecureContext && 'Notification' in window;
type Preferences = { desktop: boolean; voice: boolean };

function preferences(key: string): Preferences {
  try {
    const saved = JSON.parse(localStorage.getItem(key) || '{}');
    return { desktop: saved.desktop === true, voice: saved.voice === true };
  } catch { return { desktop: false, voice: false }; }
}

// Keep the page notice in every tab, but present each desktop alert and sound once per account.
async function announceOnce(key: string, notice: AdminNotice, announce: () => Promise<boolean> | boolean) {
  const claim = async () => {
    let recent: string[] = [];
    try { recent = JSON.parse(localStorage.getItem(key) || '[]'); } catch { /* Storage is optional. */ }
    if (notice.keys.every(id => recent.includes(id)) || !await announce()) return;
    try { localStorage.setItem(key, JSON.stringify([...new Set([...notice.keys, ...recent])].slice(0, 256))); } catch { /* Tab-local fallback. */ }
  };
  if (navigator.locks) await navigator.locks.request(key, claim);
  else await claim();
}

export function AdminAlerts() {
  const { api, user } = useAuth();
  const { refresh } = useAdminData();
  const go = useGo();
  const toast = useToast();
  const key = `kunlun.admin.alerts.${user.subjectId}`;
  const [settings, setSettings] = useState(false);
  const [prefs, setPrefs] = useState(() => preferences(key));
  const [requesting, setRequesting] = useState(false);
  const [permission, setPermission] = useState(() => canNotify() ? Notification.permission : null);
  const [notices, setNotices] = useState<AdminNotice[]>([]);
  const latest = useRef({ go, prefs, refresh });
  latest.current = { go, prefs, refresh };

  function changePrefs(change: Partial<Preferences>) {
    const next = { ...latest.current.prefs, ...change };
    latest.current.prefs = next;
    setPrefs(next);
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* Keep the choice in this tab. */ }
  }
  const audio = useRef<HTMLAudioElement | null>(null);
  const playVoice = useCallback(async () => {
    const player = audio.current ??= new Audio(orderVoice);
    try {
      player.currentTime = 0;
      await player.play();
      return true;
    } catch {
      toast('语音未能播放，请检查浏览器声音权限，再点「试听」。', 'error');
      return false;
    }
  }, [toast]);
  async function toggleDesktop() {
    if (!canNotify()) return;
    if (prefs.desktop && Notification.permission === 'granted') { changePrefs({ desktop: false }); return; }
    setRequesting(true);
    try {
      const result = await Notification.requestPermission();
      setPermission(result);
      changePrefs({ desktop: result === 'granted' });
    } catch { toast('浏览器未能开启桌面通知，请检查网站权限。', 'error'); }
    finally { setRequesting(false); }
  }

  useEffect(() => {
    const controller = new AbortController();
    let previous: AdminAlertSnapshot | null = null;
    let busy = false;
    const displayed = new Map<AlertPage, Notification>();
    const showDesktop = (notice: AdminNotice) => {
      if (controller.signal.aborted || !latest.current.prefs.desktop || !canNotify() || Notification.permission !== 'granted') return false;
      try {
        displayed.get(notice.page)?.close();
        const notification = new Notification(KUNLUN_BRAND.store, { body: notice.text, tag: key + notice.page });
        displayed.set(notice.page, notification);
        notification.onclick = () => {
          window.focus();
          setSettings(false);
          setNotices(old => old.filter(n => n.page !== notice.page));
          latest.current.go(notice.page);
          notification.close();
        };
        return true;
      } catch { return false; }
    };
    const poll = async () => {
      if (busy || controller.signal.aborted) return;
      busy = true;
      try {
        const snapshot = await api.adminAlerts(controller.signal);
        if (controller.signal.aborted) return;
        const added = newNotices(previous, snapshot);
        previous = snapshot;
        if (!added.length) return;
        setNotices(old => [...old.filter(n => !added.some(a => a.page === n.page)), ...added]);
        void latest.current.refresh().catch(() => {});
        for (const notice of added) {
          const { desktop, voice } = latest.current.prefs;
          if (desktop) await announceOnce(key + '.desktop', notice, () => showDesktop(notice));
          if (voice && notice.page === 'orders') {
            await announceOnce(key + '.voice', notice, () => !controller.signal.aborted && latest.current.prefs.voice && playVoice());
          }
        }
      } catch { /* Keep the last successful snapshot and catch up when the connection returns. */ }
      finally { busy = false; }
    };
    const focus = () => { setPermission(canNotify() ? Notification.permission : null); void poll(); };
    const sync = (e: StorageEvent) => { if (e.key === key || e.key === null) setPrefs(preferences(key)); };
    void poll();
    const timer = window.setInterval(poll, POLL_MS);
    window.addEventListener('focus', focus);
    window.addEventListener('online', poll);
    window.addEventListener('storage', sync);
    return () => {
      controller.abort();
      clearInterval(timer);
      window.removeEventListener('focus', focus);
      window.removeEventListener('online', poll);
      window.removeEventListener('storage', sync);
      displayed.forEach(n => n.close());
      audio.current?.pause();
    };
  }, [api, key, playVoice]);

  function visit(page: AlertPage) {
    setSettings(false);
    setNotices(old => old.filter(n => n.page !== page));
    go(page);
  }

  return <>
    <button type="button" className="icon-btn" aria-label="通知与提醒" title="通知与提醒" onClick={() => setSettings(true)}>
      <Icon name="bell" />{notices.length > 0 && <i className="dot" />}
    </button>
    {settings && <Dialog title="通知与提醒" description="保持管理后台打开，即可接收新水单和待审核申请提醒。" onClose={() => setSettings(false)}
      footer={<><button className="btn" onClick={() => visit('refunds')}>查看审核</button><button className="btn primary" onClick={() => visit('orders')}>查看水单</button></>}>
      <div className="alert-preferences">
        <label><input type="checkbox" checked={prefs.desktop && permission === 'granted'} disabled={!canNotify() || permission === 'denied' || requesting} onChange={toggleDesktop} />桌面通知</label>
        {!canNotify() && <small>当前浏览器环境不支持桌面通知，提醒会显示在页面左下角。</small>}
        {permission === 'denied' && <small>桌面通知已被阻止，可在浏览器的网站权限中允许通知。</small>}
        <div><label><input type="checkbox" checked={prefs.voice} onChange={e => {
          changePrefs({ voice: e.target.checked });
          if (e.target.checked) void playVoice(); else audio.current?.pause();
        }} />新单语音</label>
        <button type="button" className="text-btn" onClick={playVoice}>试听</button></div>
      </div>
    </Dialog>}
    {notices.length > 0 && createPortal(<aside className="admin-alerts" aria-label="业务提醒">
      <div role="status">{notices.map(n => <button key={n.page} type="button" className="text-btn" onClick={() => visit(n.page)}>{n.text} ›</button>)}</div>
      <button type="button" className="icon-btn" aria-label="关闭提醒" onClick={() => setNotices([])}><Icon name="close" /></button>
    </aside>, document.body)}
  </>;
}
