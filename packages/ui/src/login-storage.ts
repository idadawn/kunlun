import type { AppArea } from '@kunlun/shared';

export interface SavedLogin { accessToken: string; account?: string; password?: string }
interface LoginBridge extends EventTarget { postMessage(message: string): void }
type PasswordCredentialConstructor = new(data: { id: string; password: string }) => Credential;
type LoginDevice = Window & { kunlunSavedLogin?: LoginBridge; PasswordCredential?: PasswordCredentialConstructor };
let messageId = 0;

function nativeLogin(bridge: LoginBridge, origin: string, area: AppArea, action: 'read' | 'credentials' | 'save' | 'clear', login?: SavedLogin) {
  return new Promise<SavedLogin | null>((resolve, reject) => {
    const id = ++messageId;
    const handle = (event: Event) => {
      const reply = JSON.parse((event as MessageEvent<string>).data);
      if (reply.id !== id) return;
      cleanup();
      if (reply.ok) resolve(reply.login ?? null);
      else reject(new Error('无法访问设备保存的登录信息'));
    };
    const cleanup = () => { clearTimeout(timer); bridge.removeEventListener('message', handle); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('读取或保存设备登录信息超时')); }, 5000);
    bridge.addEventListener('message', handle);
    bridge.postMessage(JSON.stringify({ id, origin, area, action, login }));
  });
}

/** Old tab sessions contain the full login reply. Tab storage keeps only the token; passwords only go to a credential store. */
export function loginStorage(area: AppArea, apiBaseUrl: string) {
  const device = window as LoginDevice;
  const mobile = area !== 'admin' && /^https?:$/.test(device.location.protocol);
  const key = `kunlun_${area}_session` + (apiBaseUrl ? '_' + apiBaseUrl : '');
  const bridge = mobile ? device.kunlunSavedLogin : undefined;
  const origin = apiBaseUrl || device.location.origin;
  const read = (store: 'sessionStorage' | 'localStorage'): SavedLogin | null => {
    try {
      const value = JSON.parse(device[store].getItem(key) || 'null');
      return typeof value?.accessToken === 'string' ? { accessToken: value.accessToken, account: value.account } : null;
    } catch { return null; }
  };
  const browserPasswords = mobile && !!device.PasswordCredential && !!device.navigator.credentials;
  return {
    mobile,
    rememberByDefault() {
      try { return mobile && device.localStorage.getItem(key + '_remember') !== 'false'; }
      catch { return mobile; }
    },
    canRenew: !!bridge || browserPasswords,
    async read(): Promise<SavedLogin | null> {
      return read('sessionStorage') ?? (bridge ? await nativeLogin(bridge, origin, area, 'read') : mobile ? read('localStorage') : null);
    },
    async passwordFor(saved: SavedLogin): Promise<string | undefined> {
      if (bridge) {
        const stored = await nativeLogin(bridge, origin, area, 'credentials', { accessToken: saved.accessToken });
        return stored?.account === saved.account ? stored?.password : undefined;
      }
      if (!browserPasswords) return;
      const options = { password: true, mediation: 'silent' as const };
      const credential = await device.navigator.credentials.get(options).catch(() => null) as (Credential & { password?: string }) | null;
      return credential?.id === saved.account ? credential?.password : undefined;
    },
    async save(login: Required<SavedLogin>, remember: boolean, preference = remember) {
      const token = JSON.stringify({ accessToken: login.accessToken });
      if (mobile) {
        try { device.localStorage.setItem(key + '_remember', String(preference)); } catch { /* The preference is optional. */ }
      }
      if (mobile && remember) {
        if (bridge) await nativeLogin(bridge, origin, area, 'save', login);
        else device.localStorage.setItem(key, JSON.stringify({ accessToken: login.accessToken, account: login.account }));
        device.sessionStorage.removeItem(key);
      } else {
        if (bridge) await nativeLogin(bridge, origin, area, 'clear');
        if (mobile) device.localStorage.removeItem(key);
        device.sessionStorage.setItem(key, token);
      }
    },
    async offerPassword(account: string, password: string) {
      // Browsers that expose the password credential API decide whether to show a save prompt.
      if (!bridge && mobile && device.PasswordCredential && device.navigator.credentials) {
        try { await device.navigator.credentials.store(new device.PasswordCredential({ id: account, password })); }
        catch { /* The user or browser may decline to save a password. */ }
      }
    },
    async clear(expectedToken?: string) {
      if (!expectedToken || read('sessionStorage')?.accessToken === expectedToken) device.sessionStorage.removeItem(key);
      if (mobile && (!expectedToken || read('localStorage')?.accessToken === expectedToken)) device.localStorage.removeItem(key);
      if (bridge) await nativeLogin(bridge, origin, area, 'clear');
    },
  };
}

/** Only renew a naturally expired login after the server rejects it. Revocation requires an interactive sign-in. */
export function tokenExpired(token: string) {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return typeof payload.exp === 'number' && payload.exp <= Date.now() / 1000;
  } catch { return false; }
}
