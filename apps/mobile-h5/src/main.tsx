import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AuthGate, IconSprite, ToastProvider } from '@kunlun/ui';

// One H5 bundle serves two independently signed-in areas; each area's code and styles load on demand.
const area = window.location.pathname.split('/')[1] === 'staff' ? 'staff' : 'member';
const AreaApp = lazy(() => area === 'staff'
  ? import('./staff/StaffApp').then(m => ({ default: m.StaffApp }))
  : import('./member/MemberApp').then(m => ({ default: m.MemberApp })));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <IconSprite />
        <AuthGate area={area}>
          <Suspense fallback={<div className="login-gate"><p className="membership-note">正在加载…</p></div>}>
            <AreaApp />
          </Suspense>
        </AuthGate>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
);
