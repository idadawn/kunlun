import { Link } from 'react-router-dom';
import { KUNLUN_BRAND, isActiveOrder, pathFor, type RoleCode, type WaterOrder } from '@kunlun/shared';
import { ChangePasswordDialog, Icon, useAuth, useDialogs, useRun, type IconName } from '@kunlun/ui';
import { OrderCard } from '../shared/OrderCard';
import { Loading } from '../shared/H5Shell';
import { useStaffData } from './data';
import { useStaffOperations } from './operations';

export interface StaffPageProps { go: (page: string) => void }

const ROLE_LABEL: Partial<Record<RoleCode, string>> = { ADMIN: '管理员', CLERK: '店员', COURIER: '送水员' };

function StaffOrder({ order }: { order: WaterOrder }) {
  const { members } = useStaffData();
  const ops = useStaffOperations();
  const title = members.find(m => m.id === order.memberId)?.name || order.addressSnapshot?.contactName || '会员';
  return (
    <OrderCard order={order} title={title} showContact actions={isActiveOrder(order) && <>
      {order.status === 'PENDING' && order.fulfillMode === 'DELIVERY' && <button type="button" className="btn sm" onClick={() => ops.accept(order)}>接单</button>}
      <button type="button" className="btn primary sm" onClick={() => ops.fulfill(order)}>{order.fulfillMode === 'PICKUP' ? '核销自提' : '确认交付'}</button>
    </>} />
  );
}

export function StaffHome({ go }: StaffPageProps) {
  const { user } = useAuth();
  const { orders, memberTotal, loaded, error, refresh } = useStaffData();
  const ops = useStaffOperations();
  const active = orders.filter(isActiveOrder);
  const quick: Array<[string, IconName, string, () => void]> = [
    ['水费充值', 'wallet', '', ops.recharge],
    ['交/退押金', 'deposit', 'gold', ops.deposit],
    ['代开水单', 'order', 'aqua', ops.order],
    ['自提核销', 'qr', 'orange', ops.pickup],
    ['登记领还', 'box', 'violet', ops.container],
    ['新建会员', 'users', '', ops.newMember],
  ];
  return <>
    <div className="h5-hero">
      <div className="h5-status">
        <div className="h5-greeting"><small>{KUNLUN_BRAND.signage}</small><h2>{user.displayName}，你好</h2></div>
        <button type="button" className="hero-bell" aria-label="待办水单" onClick={() => go('orders')}><Icon name="bell" />{active.length > 0 && <i className="dot" />}</button>
      </div>
      <div className="shift-card"><span>当前账号：{user.codeOrNo}</span><em>{KUNLUN_BRAND.slogan}</em></div>
    </div>
    <div className="h5-body overlap">
      <div className="h5-card">
        <div className="work-numbers">
          <div className="work-number"><b>{loaded ? active.length : '—'}</b><small>待履约水单</small></div>
          <div className="work-number"><b>{loaded ? orders.filter(o => o.status === 'COMPLETED').length : '—'}</b><small>当前列表已完成</small></div>
          <div className="work-number"><b>{loaded ? memberTotal : '—'}</b><small>当前查询会员</small></div>
        </div>
      </div>
      <div className="h5-section-head"><h3>快捷办理</h3><span>先选会员 · 独立记账</span></div>
      <div className="h5-card">
        <div className="quick-grid">
          {quick.map(([label, icon, tone, open]) => (
            <button key={label} type="button" className="quick-item" onClick={open}><span className={`quick-icon ${tone}`.trim()}><Icon name={icon} size="lg" /></span>{label}</button>
          ))}
        </div>
      </div>
      <div className="h5-section-head"><h3>待办水单</h3><Link to={pathFor('staff', 'orders')}>全部 {orders.length} 单 ›</Link></div>
      {!loaded ? <Loading error={error} onRetry={() => refresh().catch(() => undefined)} />
        : active.length ? active.slice(0, 3).map(o => <StaffOrder key={o.id} order={o} />)
        : <p className="membership-note">暂无待办水单</p>}
    </div>
  </>;
}

export function StaffOrders() {
  const { orders, loaded, error, refresh } = useStaffData();
  const run = useRun();
  return <>
    <div className="mobile-top"><h2>水单履约</h2><button type="button" className="btn sm" onClick={run(refresh)}><Icon name="refresh" size="sm" />刷新</button></div>
    {!loaded ? <Loading error={error} onRetry={run(refresh)} /> : (
      <div className="h5-body">{orders.length ? orders.map(o => <StaffOrder key={o.id} order={o} />) : <p className="membership-note">暂无水单</p>}</div>
    )}
  </>;
}

export function StaffMembers() {
  const { members, memberTotal, loadMoreMembers, query, setQuery, loaded, error, refresh } = useStaffData();
  const ops = useStaffOperations();
  const run = useRun();
  return <>
    <div className="mobile-top"><h2>会员查询与办理</h2><button type="button" className="btn primary sm" onClick={ops.newMember}><Icon name="plus" size="sm" />新建</button></div>
    <div className="h5-body">
      <label className="field-search" style={{ marginBottom: 12 }}><Icon name="search" /><input placeholder="输入姓名、手机号或会员编号" aria-label="搜索会员" value={query} onChange={e => setQuery(e.target.value)} /></label>
      <div className="h5-section-head"><h3>{query.trim() ? '搜索结果' : '常用会员'}</h3><span>{loaded ? `共 ${memberTotal} 位 · ` : ''}点击快速办理业务</span></div>
      {!loaded ? <Loading error={error} onRetry={() => refresh().catch(() => undefined)} /> : members.length === 0 ? <p className="membership-note">未找到会员，可点击右上角新建</p> : members.map(m => (
        <div key={m.id} className="h5-card" role="button" tabIndex={0} style={{ cursor: 'pointer' }} onClick={() => ops.detail(m)} onKeyDown={e => e.key === 'Enter' && ops.detail(m)}>
          <div className="member-cell">
            <div className="member-avatar">{m.name[0]}</div>
            <div><b>{m.name}</b><small>{m.phone} · {m.memberNo}</small></div>
            <span className="tag green" style={{ marginLeft: 'auto' }}>办理 ›</span>
          </div>
          <div className="wallet-sub">
            <span>自提/配送桶 <b>{m.bucketPickupTickets}/{m.bucketDeliveryTickets}</b></span>
            <span>自提/配送袋 <b>{m.bagPickupTickets}/{m.bagDeliveryTickets}</b></span>
            <span>押金 <b>¥{Number(m.depositAmount).toFixed(0)}</b></span>
            <span>持桶/袋 <b>{m.heldBuckets}/{m.heldBags}</b></span>
          </div>
        </div>
      ))}
      {loaded && members.length < memberTotal && (
        <button type="button" className="btn block" onClick={run(loadMoreMembers)}>加载更多（已显示 {members.length} / {memberTotal} 位）</button>
      )}
    </div>
  </>;
}

export function StaffProfile() {
  const { user, logout } = useAuth();
  const dialogs = useDialogs();
  const changePassword = () => dialogs.open(close => <ChangePasswordDialog onClose={close} />);
  return <>
    <div className="mobile-top"><h2>我的工作台</h2><span className="tag green">当班中</span></div>
    <div className="h5-body">
      <div className="h5-card" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div className="member-avatar" style={{ width: 48, height: 48, fontSize: 17 }}>{user.displayName[0]}</div>
        <div><b style={{ fontSize: 16, color: 'var(--ink)' }}>{user.displayName}</b><div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 2 }}>{user.codeOrNo} · {ROLE_LABEL[user.role] ?? user.role}</div></div>
      </div>
      <div className="profile-list">
        <div className="profile-row"><Icon name="store" /><span>所属水站</span><small>{KUNLUN_BRAND.store}</small></div>
        <div className="profile-row" role="button" tabIndex={0} onClick={changePassword} onKeyDown={e => e.key === 'Enter' && changePassword()}><Icon name="shield" /><span>修改密码</span><Icon name="chevron" /></div>
        <div className="profile-row" role="button" tabIndex={0} style={{ color: 'var(--red-500)' }} onClick={() => void logout()} onKeyDown={e => e.key === 'Enter' && void logout()}>
          <Icon name="logout" /><span>退出登录 / 切换员工账号</span><small>{user.codeOrNo} ›</small>
        </div>
      </div>
    </div>
  </>;
}
