import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AuthGate, IconSprite, ToastProvider } from '@kunlun/ui';
import { App } from './App';
import './admin.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <IconSprite />
        <AuthGate area="admin">
          <App />
        </AuthGate>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
);
