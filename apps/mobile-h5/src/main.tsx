import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AuthGate, IconSprite, ToastProvider } from '@kunlun/ui';

// One H5 bundle serves two independently signed-in areas; each area's code and styles load on demand.
const area = window.location.pathname.split('/')[1] === 'staff' ? 'staff' : 'member';
const isNativeApp = import.meta.env.VITE_NATIVE_APP === 'true';
const iosStaff = window as Window & {
  webkit?: { messageHandlers?: { staffApp?: { postMessage(action: 'review' | 'privacy' | 'support'): void } } };
  kunlunStaffReview?: boolean;
};
const staffApp = location.protocol === 'kunlun-staff:' ? iosStaff.webkit?.messageHandlers?.staffApp : undefined;
const nativeLoginFooter = staffApp ? (
  <div className="login-help">
    {!iosStaff.kunlunStaffReview && <button type="button" className="btn sm ghost" onClick={() => staffApp.postMessage('review')}>审核演示</button>}
    <button type="button" className="btn sm ghost" onClick={() => staffApp.postMessage('privacy')}>隐私政策</button>
    <button type="button" className="btn sm ghost" onClick={() => staffApp.postMessage('support')}>技术支持</button>
  </div>
) : isNativeApp ? (
  <p className="login-help"><a href={area === 'member' ? '/staff' : '/member'}>{area === 'member' ? '切换到员工登录' : '切换到会员登录'}</a></p>
) : undefined;
const AreaApp = lazy(() => area === 'staff'
  ? import('./staff/StaffApp').then(m => ({ default: m.StaffApp }))
  : import('./member/MemberApp').then(m => ({ default: m.MemberApp })));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <IconSprite />
        <AuthGate area={area} apiBaseUrl={isNativeApp ? import.meta.env.VITE_API_BASE_URL : undefined} loginFooter={nativeLoginFooter}>
          <Suspense fallback={<div className="login-gate"><p className="membership-note">正在加载…</p></div>}>
            <AreaApp />
          </Suspense>
        </AuthGate>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
);
