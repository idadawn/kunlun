import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import {
  KUNLUN_PERMISSIONS, MOBILE_FEATURES, PERMISSION_TITLES, ROLE_LABELS, STAFF_ROLES, mobileLayout,
  type MobileFeature, type PermissionCode, type StaffRole,
} from '@kunlun/shared';
import {
  ConfirmDialog, Icon, WorkbenchHome, WorkbenchTabBar, useApi, useDialogs, useLoader, useRun, useToast, workbenchTabs, type IconName,
} from '@kunlun/ui';
import '@kunlun/ui/src/workbench.css';
import { useAdminData } from '../data';

const ALL_CODES = Object.values(KUNLUN_PERMISSIONS) as PermissionCode[];
const GROUPS = ['日常业务', '会员与收款', '桶袋', '经营'] as const;

/**
 * 移动端配置：按角色开通员工手机端的功能并排序，右侧手机框用同一个工作台组件实时预览首页和底部导航。
 * 店员、送水员保存后权限随功能变化（服务端立即生效）；管理员只改手机首页。
 */
export function MobileConfig() {
  const api = useApi();
  const config = useLoader(() => api.mobileRoles(), [api]);
  const staff = useLoader(() => api.listStaff(), [api]);
  const [role, setRole] = useState<StaffRole>('CLERK');
  const [drafts, setDrafts] = useState<Partial<Record<StaffRole, string[]>>>({});
  const [highlight, setHighlight] = useState<{ key: string; at: number } | null>(null);
  const dialogs = useDialogs();
  const run = useRun();
  const toast = useToast();

  const roles = config.data?.roles ?? [];
  const current = roles.find(r => r.role === role);
  const known = useMemo(() => new Set(config.data?.catalog.map(f => f.key) ?? []), [config.data]);
  const features = useMemo(() => MOBILE_FEATURES.filter(f => known.has(f.key)), [known]);
  const saved = current?.features ?? [];
  const draft = drafts[role] ?? saved;
  const dirtyRoles = roles.filter(r => drafts[r.role] && !sameList(drafts[r.role]!, r.features)).map(r => r.role);
  const dirty = dirtyRoles.includes(role);

  // Unsaved changes survive switching roles but not leaving the console page by accident.
  useEffect(() => {
    if (!dirtyRoles.length) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirtyRoles.length]);

  const flash = (key: string) => setHighlight({ key, at: Date.now() });
  useEffect(() => {
    if (!highlight) return;
    const timer = window.setTimeout(() => setHighlight(null), 1500);
    return () => window.clearTimeout(timer);
  }, [highlight]);

  const edit = (next: string[]) => setDrafts(d => ({ ...d, [role]: next }));
  const add = (key: string) => { edit([...draft, key]); flash(key); };
  const remove = (key: string) => edit(draft.filter(k => k !== key));
  const move = (key: string, delta: number) => {
    const from = draft.indexOf(key), to = from + delta;
    if (from < 0 || to < 0 || to >= draft.length) return;
    const next = [...draft];
    next.splice(to, 0, ...next.splice(from, 1));
    edit(next); flash(key);
  };

  const permsOf = (keys: readonly string[]) => {
    if (role === 'ADMIN') return ALL_CODES;
    const granted = new Set(keys.flatMap(k => config.data?.catalog.find(f => f.key === k)?.permissions ?? []));
    return ALL_CODES.filter(c => granted.has(c));
  };
  const before = permsOf(saved), after = permsOf(draft);
  const gained = after.filter(c => !before.includes(c));
  const lost = before.filter(c => !after.includes(c));

  const save = () => run(async () => {
    if (!current) return;
    const risky = draft.map(k => features.find(f => f.key === k)).filter((f): f is MobileFeature => !!f?.risk && !saved.includes(f.key));
    const label = ROLE_LABELS[role];
    if (role !== 'ADMIN' && (lost.length || risky.length) && current.staffCount > 0) {
      const confirmed = await dialogs.open<boolean>(close => <ConfirmDialog title={`保存「${label}」的手机端功能`} confirmLabel="确认保存" onClose={close}
        message={<>
          保存后立即对 {current.staffCount} 名{label}生效：<br />
          {lost.length > 0 && <>· 不能再办理：<b>{lost.map(c => PERMISSION_TITLES[c]).join('、')}</b><br /></>}
          {risky.map(f => <span key={f.key}>· 新开通「{f.label}」：{f.risk}<br /></span>)}
        </>}
        onConfirm={() => undefined} />);
      if (!confirmed) return;
    }
    const result = await api.saveMobileRole(role, draft);
    config.setData(data => data && { ...data, roles: data.roles.map(r => (r.role === role ? result : r)) });
    setDrafts(d => ({ ...d, [role]: undefined }));
    toast(role === 'ADMIN' ? '已保存管理员的手机首页' : `已保存，${result.staffCount} 名${label}刷新手机端即可看到新首页`);
  })();

  const layout = mobileLayout(draft);
  const placement = (f: MobileFeature) => (layout.tabs.includes(f) ? '底部导航' : f.card ? '首页卡片' : '快捷办理');
  const available = features.filter(f => !draft.includes(f.key));
  const sample = staff.data?.find(s => s.role === role && s.status === 'ACTIVE');

  return <>
    <div className="page-head">
      <div><h2>移动端配置</h2><p>按角色设置员工手机端能用的功能和首页顺序，右侧手机实时预览；店员、送水员开通哪些功能就拥有对应权限</p></div>
    </div>

    {config.error ? <p className="account-error" role="alert">{config.error}</p> : !config.data ? <p className="membership-note">正在加载…</p> : <>
      <div className="mc-toolbar">
        <div className="mc-roles" role="tablist" aria-label="选择角色">
          {STAFF_ROLES.map(r => {
            const info = roles.find(x => x.role === r.role);
            return (
              <button key={r.role} type="button" role="tab" aria-selected={role === r.role} className={`mc-role${role === r.role ? ' active' : ''}`} onClick={() => setRole(r.role)}>
                <span className="mc-role-name">{r.label}{dirtyRoles.includes(r.role) && <i className="mc-dirty" title="有未保存的修改" />}</span>
                <small>{info ? `${info.staffCount} 人 · ` : ''}{r.hint}</small>
              </button>
            );
          })}
        </div>
        <div className="head-actions">
          <button type="button" className="btn" disabled={!current || sameList(draft, current.defaults)} onClick={() => edit([...(current?.defaults ?? [])])}>恢复默认</button>
          <button type="button" className="btn" disabled={!dirty} onClick={() => setDrafts(d => ({ ...d, [role]: undefined }))}>放弃修改</button>
          <button type="button" className="btn primary" disabled={!dirty} onClick={save}><Icon name="check" size="sm" />保存配置</button>
        </div>
      </div>

      <div className="mc-layout">
        <div className="mc-editor">
          <section className="mc-card">
            <header className="mc-card-head">
              <div><b>已开通 {layout.features.length} 项</b><small>拖动或用箭头调整顺序：前 3 个有独立页面的功能放进底部导航，其余在首页「快捷办理」</small></div>
            </header>
            {layout.features.length === 0
              ? <p className="mc-empty">还没有开通任何功能，{ROLE_LABELS[role]}打开手机端只能看到工作台和「我的」。从下面添加功能。</p>
              : <EnabledList features={layout.features} placement={placement} highlight={highlight?.key} onMove={move} onRemove={remove} onReorder={edit} />}
          </section>

          <section className="mc-card">
            <header className="mc-card-head"><div><b>可添加的功能</b><small>{available.length ? '点「添加」立即出现在右侧手机首页' : '所有功能都已开通'}</small></div></header>
            {GROUPS.map(group => {
              const options = available.filter(f => f.group === group);
              if (!options.length) return null;
              return (
                <div key={group} className="mc-group">
                  <h4>{group}</h4>
                  <div className="mc-options">
                    {options.map(f => (
                      <article key={f.key} className="mc-option">
                        <span className={`mc-icon ${f.tone}`.trim()}><Icon name={f.icon as IconName} /></span>
                        <div className="mc-option-text">
                          <b>{f.label}{f.risk && role !== 'ADMIN' && <span className="tag orange" title={f.risk}>高风险</span>}</b>
                          <p>{f.summary}</p>
                        </div>
                        <button type="button" className="btn sm" aria-label={`添加${f.label}`} onClick={() => add(f.key)}><Icon name="plus" size="sm" />添加</button>
                      </article>
                    ))}
                  </div>
                </div>
              );
            })}
          </section>

          <section className="mc-card mc-perms">
            <header className="mc-card-head"><div><b>{role === 'ADMIN' ? '管理员权限' : `保存后${ROLE_LABELS[role]}的权限`}</b>
              <small>{role === 'ADMIN' ? '管理员在后台始终拥有全部权限，这里只决定手机首页显示哪些功能' : '服务端按这些权限放行，关掉的功能在手机端和接口上都不能再办理'}</small></div></header>
            {role !== 'ADMIN' && <>
              <div className="mc-chips">
                {after.length ? after.map(c => <span key={c} className={`tag ${gained.includes(c) ? 'green' : 'gray'}`}>{gained.includes(c) && '＋ '}{PERMISSION_TITLES[c]}</span>) : <span className="membership-note">没有任何业务权限</span>}
                {lost.map(c => <span key={c} className="tag red mc-lost">－ {PERMISSION_TITLES[c]}</span>)}
              </div>
              {(gained.length > 0 || lost.length > 0) && <p className="membership-note">绿色是这次新增的权限，红色是保存后会收回的权限。</p>}
            </>}
            {current?.updatedBy && <p className="membership-note">上次由 {current.updatedBy} 于 {new Date(current.updatedAt!).toLocaleString('zh-CN', { hour12: false })} 保存</p>}
          </section>

          {dirty && (
            <div className="mc-savebar" role="status">
              <span><Icon name="info" size="sm" />「{ROLE_LABELS[role]}」有未保存的修改{role !== 'ADMIN' && current ? `，保存后对 ${current.staffCount} 人立即生效` : ''}</span>
              <button type="button" className="btn" onClick={() => setDrafts(d => ({ ...d, [role]: undefined }))}>放弃修改</button>
              <button type="button" className="btn primary" onClick={save}><Icon name="check" size="sm" />保存配置</button>
            </div>
          )}
        </div>

        <aside className="mc-preview" aria-label={`${ROLE_LABELS[role]}手机端首页预览`}>
          <PhonePreview role={role} features={draft} name={sample?.name} account={sample?.staffNo}
            highlight={highlight?.key ?? null} onPick={key => flash(key)} />
          <p className="mc-preview-note">预览 · {ROLE_LABELS[role]}的工作台首页{dirty ? '（未保存）' : ''}，数字为当前真实数据</p>
        </aside>
      </div>
    </>}
  </>;
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Enabled features in workbench order: drag to reorder, arrows for the keyboard, remove to turn off. */
function EnabledList({ features, placement, highlight, onMove, onRemove, onReorder }: {
  features: MobileFeature[];
  placement: (f: MobileFeature) => string;
  highlight?: string;
  onMove: (key: string, delta: number) => void;
  onRemove: (key: string) => void;
  onReorder: (keys: string[]) => void;
}) {
  const [dragging, setDragging] = useState<string | null>(null);
  const items = useRef<Record<string, HTMLLIElement | null>>({});
  useEffect(() => { if (highlight) items.current[highlight]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [highlight]);
  const over = (e: DragEvent, target: string) => {
    if (!dragging || dragging === target) return;
    e.preventDefault();
    const keys = features.map(f => f.key) as string[];
    const from = keys.indexOf(dragging), to = keys.indexOf(target);
    keys.splice(to, 0, ...keys.splice(from, 1));
    onReorder(keys);
  };
  return (
    <ol className="mc-list">
      {features.map((f, i) => (
        <li key={f.key} ref={el => { items.current[f.key] = el; }} draggable
          className={`mc-item${dragging === f.key ? ' dragging' : ''}${highlight === f.key ? ' wb-flash' : ''}`}
          onDragStart={e => { setDragging(f.key); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', f.key); }}
          onDragOver={e => over(e, f.key)} onDragEnd={() => setDragging(null)} onDrop={e => { e.preventDefault(); setDragging(null); }}>
          <span className="mc-grip" aria-hidden="true">⋮⋮</span>
          <span className={`mc-icon ${f.tone}`.trim()}><Icon name={f.icon as IconName} /></span>
          <div className="mc-item-text">
            <b>{f.label}<span className={`tag ${placement(f) === '底部导航' ? 'aqua' : placement(f) === '首页卡片' ? 'gold' : 'gray'}`}>{placement(f)}</span>
              {f.key === 'orders' && <span className="tag gray">首页待办</span>}{f.key === 'inventory' && <span className="tag gray">首页库存</span>}</b>
            <p>{f.summary}</p>
          </div>
          <div className="mc-item-actions">
            <button type="button" className="icon-btn sm" aria-label={`${f.label}上移`} disabled={i === 0} onClick={() => onMove(f.key, -1)}><Icon name="down" size="sm" className="mc-up" /></button>
            <button type="button" className="icon-btn sm" aria-label={`${f.label}下移`} disabled={i === features.length - 1} onClick={() => onMove(f.key, 1)}><Icon name="down" size="sm" /></button>
            <button type="button" className="btn sm danger" aria-label={`移除${f.label}`} onClick={() => onRemove(f.key)}>移除</button>
          </div>
        </li>
      ))}
    </ol>
  );
}

/** A phone frame around the very workbench staff see, fed with the console's live numbers. */
function PhonePreview({ role, features, name, account, highlight, onPick }: {
  role: StaffRole;
  features: string[];
  name?: string;
  account?: string;
  highlight: string | null;
  onPick: (key: string) => void;
}) {
  const { orders, memberTotal, containers, overview, loaded } = useAdminData();
  const tabs = workbenchTabs(features);
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => { scroll.current?.scrollTo({ top: 0 }); }, [role]);
  return (
    <div className="mc-device">
      <div className="mc-screen">
        <div className="mc-camera" aria-hidden="true" />
        <div className="h5-navbar"><div className="h5-title">绿麒麟水站·员工工作台</div></div>
        <div className="h5-scroll" ref={scroll}>
          <div className="h5-page active">
            <WorkbenchHome features={features}
              data={{
                name: name ?? ROLE_LABELS[role], account: account ?? '示例账号',
                orders: loaded ? orders : undefined, memberTotal: loaded ? memberTotal : undefined,
                containers: loaded ? containers : undefined, overview,
              }}
              highlight={highlight} onOpen={f => onPick(f.key)} />
          </div>
        </div>
        <WorkbenchTabBar tabs={tabs} active="home" onNavigate={page => {
          const owner = MOBILE_FEATURES.find(f => f.page === page);
          if (owner) onPick(owner.key);
        }} />
      </div>
    </div>
  );
}
