import { createContext, useCallback, useContext, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { KUNLUN_BRAND, KunlunApi, type AppArea, type AuthSession, type CurrentUser, type PermissionCode } from '@kunlun/shared';
import { Field, FormDialog, useToast } from './feedback';
import { Logo } from './icons';

export interface AuthContextValue {
  api: KunlunApi;
  user: CurrentUser;
  /** UI hint only; the server re-checks every permission. */
  can(permission: PermissionCode): boolean;
  logout(): Promise<void>;
  /** Clears the local session after the server has revoked it (e.g. after a password change). */
  endSession(): void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('AuthGate is missing');
  return value;
}
export const useApi = () => useAuth().api;

const storageKey = (area: AppArea) => `kunlun_${area}_session`;
const AREA_LABEL: Record<AppArea, string> = { admin: '管理后台', staff: '员工工作台', member: '会员中心' };

function readSaved(area: AppArea): AuthSession | null {
  try { return JSON.parse(sessionStorage.getItem(storageKey(area)) || 'null'); } catch { return null; }
}
function forget(area: AppArea) {
  try { sessionStorage.removeItem(storageKey(area)); } catch { /* storage may be unavailable */ }
}

function assertArea(area: AppArea, me: CurrentUser) {
  const allowed = area === 'admin' ? me.subjectType === 'STAFF' && me.role === 'ADMIN'
    : area === 'staff' ? me.subjectType === 'STAFF' : me.subjectType === 'MEMBER';
  if (!allowed) throw new Error('当前账号不能登录此入口，请使用对应账号');
}

/** Requires a signed-in account for the given area; renders the login page until then. */
export function AuthGate({ area, children }: { area: AppArea; children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [restoring, setRestoring] = useState(true);
  const toast = useToast();
  const api = useMemo(() => new KunlunApi({ onUnauthorized: () => { forget(area); api.token = null; setUser(null); } }), [area]);

  const endSession = useCallback(() => { forget(area); api.token = null; setUser(null); }, [api, area]);

  useEffect(() => {
    const saved = readSaved(area);
    if (!saved) { setRestoring(false); return; }
    api.token = saved.accessToken;
    api.me().then(me => { assertArea(area, me); setUser(me); })
      .catch(() => endSession())
      .finally(() => setRestoring(false));
  }, [api, area, endSession]);

  const login = async (account: string, password: string) => {
    const session = area === 'member' ? await api.memberLogin(account, password) : await api.staffLogin(account, password, area === 'admin');
    api.token = session.accessToken;
    try {
      const me = await api.me();
      assertArea(area, me);
      sessionStorage.setItem(storageKey(area), JSON.stringify(session));
      setUser(me);
    } catch (e) { api.token = null; throw e; }
  };

  const value = useMemo<AuthContextValue | null>(() => user && {
    api,
    user,
    can: permission => user.subjectType === 'STAFF' && user.permissions.includes(permission),
    endSession,
    logout: async () => {
      try { await api.logout(); }
      catch (e) { if (api.token) { toast('退出失败，请重试：' + (e instanceof Error ? e.message : e)); return; } }
      endSession();
    },
  }, [api, endSession, toast, user]);

  if (restoring) return <div className="login-gate" aria-busy="true"><p className="membership-note">正在恢复登录状态…</p></div>;
  if (!value) return <LoginPage area={area} onLogin={login} />;
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function LoginPage({ area, onLogin }: { area: AppArea; onLogin: (account: string, password: string) => Promise<void> }) {
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    try { await onLogin(account.trim(), password); }
    catch (e) { setError(e instanceof Error ? e.message : '登录失败，请重试'); setBusy(false); }
  };
  return (
    <div className={`login-gate login-${area}`}>
      <div className="login-brand"><Logo /><h1>{KUNLUN_BRAND.store}</h1><p>{KUNLUN_BRAND.slogan}</p></div>
      <form className="login-card" onSubmit={submit}>
        <h2>{AREA_LABEL[area]}</h2>
        <p className="login-subtitle">使用用户名和密码登录</p>
        <label htmlFor="loginUsername">用户名</label>
        <input id="loginUsername" className="input" autoComplete="username" required maxLength={32} placeholder="请输入用户名" value={account} onChange={e => setAccount(e.target.value)} />
        <label htmlFor="loginPassword">密码</label>
        <div className="password-field">
          <input id="loginPassword" className="input" type={showPassword ? 'text' : 'password'} autoComplete="current-password" required maxLength={128} placeholder="请输入密码" value={password} onChange={e => setPassword(e.target.value)} />
          <button type="button" aria-label={showPassword ? '隐藏密码' : '显示密码'} onClick={() => setShowPassword(v => !v)}>{showPassword ? '隐藏' : '显示'}</button>
        </div>
        <p role="alert" className="account-error">{error}</p>
        <button className="btn primary login-submit" type="submit" disabled={busy}>{busy ? '正在登录…' : '登录'}</button>
        <p className="login-help">{area === 'admin' ? '仅限水站管理员' : '首次使用或忘记密码，请联系水站设置账号'}</p>
      </form>
    </div>
  );
}

export function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const { api, endSession } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  return (
    <FormDialog title="修改密码" className="account-dialog" onClose={onClose} onSubmit={async () => { await api.changePassword(current, next); endSession(); }}>
      <Field label="原密码" htmlFor="oldPassword"><input id="oldPassword" className="input" type="password" autoComplete="current-password" required value={current} onChange={e => setCurrent(e.target.value)} /></Field>
      <Field label="新密码" htmlFor="newPassword"><input id="newPassword" className="input" type="password" autoComplete="new-password" minLength={8} maxLength={128} required value={next} onChange={e => setNext(e.target.value)} /></Field>
    </FormDialog>
  );
}

/** Sets or resets the username/password of a member or staff account. */
export function CredentialsDialog({ subjectType, id, initialUsername = '', title, onClose, onSaved }: {
  subjectType: 'STAFF' | 'MEMBER';
  id: string;
  initialUsername?: string;
  title?: string;
  onClose: () => void;
  onSaved?: () => void | Promise<void>;
}) {
  const { api } = useAuth();
  const toast = useToast();
  const [username, setUsername] = useState(initialUsername);
  const [password, setPassword] = useState('');
  return (
    <FormDialog
      title={title ?? (subjectType === 'MEMBER' ? '设置会员登录账号' : '设置员工登录账号')}
      className="account-dialog"
      onClose={onClose}
      onSubmit={async () => {
        await api.setCredentials(subjectType, id, username.trim(), password);
        await onSaved?.();
        toast(subjectType === 'MEMBER' ? '账号已保存，请将用户名和密码告知会员' : '员工账号已保存');
      }}
    >
      <Field label="用户名" htmlFor="credentialUsername"><input id="credentialUsername" className="input" autoComplete="off" pattern="[A-Za-z0-9][A-Za-z0-9_.\-]{2,31}" required value={username} onChange={e => setUsername(e.target.value)} /></Field>
      <Field label="初始密码 / 重置密码" htmlFor="credentialPassword"><input id="credentialPassword" className="input" type="password" autoComplete="new-password" minLength={8} maxLength={128} required value={password} onChange={e => setPassword(e.target.value)} /></Field>
    </FormDialog>
  );
}
