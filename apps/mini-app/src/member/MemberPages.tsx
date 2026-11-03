import { Link } from 'react-router-dom';
import { KUNLUN_BRAND, containerLabel, modeLabel, money, pathFor, type MemberProfile, type WaterOrder } from '@kunlun/shared';
import { BatchCards, ChangePasswordDialog, Icon, Logo, useAuth, useDialogs, useLoader } from '@kunlun/ui';
import { OrderCard } from '../shared/OrderCard';
import { Loading } from '../shared/H5Shell';
import { useMemberData } from './data';

export interface MemberPageProps {
  profile: MemberProfile;
  go: (page: string) => void;
}

const MemberOrder = ({ order }: { order: WaterOrder }) => <OrderCard order={order} title={modeLabel(order.fulfillMode)} />;

const StoreHint = () => (
  <div className="member-hint"><Icon name="info" size="sm" /><span>订水、充值、交退押金请到店里或找送水员办理，店员登记后这里随时可查。</span></div>
);

export function MemberHome({ profile }: MemberPageProps) {
  const { orders } = useMemberData();
  return <>
    <div className="member-hero">
      <div className="hero-top">
        <Logo />
        <div><b>{KUNLUN_BRAND.store}</b><small>{KUNLUN_BRAND.product}</small></div>
        <span className="vip-badge">麒麟会员 · {profile.name}</span>
      </div>
      <div className="hero-slogan"><b>{KUNLUN_BRAND.slogan}</b><span>{profile.memberNo}</span></div>
    </div>
    <div className="h5-body overlap">
      <div className="wallet-card">
        <div className="wallet-head"><b>我的水票</b><Link className="link" to={pathFor('member', 'records')}>充值记录 ›</Link></div>
        {profile.tickets.length ? (
          <div className="ticket-grid">
            {profile.tickets.map(t => (
              <div key={`${t.waterType}:${t.fulfillMode}`} className="ticket-box">
                <div className="num">{t.available}<small>{t.unit}</small></div>
                <div className="label"><span>{t.name} · {modeLabel(t.fulfillMode)}票</span>{t.reserved > 0 && <em>预占 {t.reserved}</em>}</div>
              </div>
            ))}
          </div>
        ) : <p className="membership-note">还没有水票，充值请到店里办理。</p>}
      </div>
      <StoreHint />
      <div className="h5-section-head"><h3>最近用水</h3><Link to={pathFor('member', 'orders')}>全部记录 ›</Link></div>
      {orders.length ? orders.slice(0, 3).map(o => <MemberOrder key={o.id} order={o} />) : <div className="h5-card"><p className="membership-note">还没有用水记录</p></div>}
      <div className="h5-section-head"><h3>我的桶和押金</h3><Link to={pathFor('member', 'assets')}>查看明细 ›</Link></div>
      <div className="h5-card">
        <div className="asset-mini-grid">
          <div><b>{profile.heldBuckets}</b><small>手里的周转桶</small></div>
          <div><b>{profile.heldBags}</b><small>手里的周转水袋</small></div>
          <div><b>¥{Number(profile.depositAmount).toFixed(0)}</b><small>已交押金</small></div>
        </div>
      </div>
    </div>
  </>;
}

export function MemberOrders() {
  const { orders } = useMemberData();
  return <>
    <div className="mobile-top"><h2>用水记录</h2><span className="tag green">{KUNLUN_BRAND.store}</span></div>
    <div className="h5-body">
      {orders.length ? orders.map(o => <MemberOrder key={o.id} order={o} />) : <p className="membership-note">还没有用水记录</p>}
      <StoreHint />
    </div>
  </>;
}

export function MemberAssets({ profile }: MemberPageProps) {
  const { api } = useAuth();
  const { data: rows, error, reload } = useLoader(() => api.depositSummary(profile.id), [api, profile.id]);
  return <>
    <div className="mobile-top"><h2>押金与桶</h2><Link to={pathFor('member', 'records')} style={{ fontSize: 12 }}>充值记录 ›</Link></div>
    {!rows ? <Loading error={error} onRetry={reload} /> : (
      <div className="h5-body">
        <div className="h5-card" style={{ background: 'var(--grad-card)', color: '#fff' }}>
          <small style={{ opacity: 0.8 }}>我的在池押金总额</small>
          <div className="num" style={{ fontSize: 30, fontWeight: 700, margin: '4px 0' }}>¥ {money(rows.reduce((sum, r) => sum + r.paidAmount, 0))}</div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, opacity: 0.88 }}>
            {rows.map(r => <span key={r.containerType}>{r.containerType === 'BUCKET' ? '桶押金' : '袋押金'} ¥{money(r.paidAmount)}（{r.paidQty}个）</span>)}
          </div>
        </div>
        {rows.map(r => { const covered = r.heldQty <= r.paidQty - r.pendingDamageQty; return (
          <div key={r.containerType}>
            <div className="h5-section-head"><h3>{containerLabel(r.containerType)}</h3><span className={`tag ${covered ? 'green' : 'orange'}`}>{covered ? '押金已覆盖' : '需补交押金'}</span></div>
            <div className="h5-card">
              <div className="detail-row"><span>剩余押金（按原收款批次）</span><b>{r.paidQty} 个 / ¥{money(r.paidAmount)}</b></div>
              <div className="detail-row"><span>当前手里有</span><b>{r.heldQty} 个</b></div>
              <div className="detail-row"><span>当前可退押金（已交 − 手里有）</span><b style={{ color: 'var(--brand-600)' }}>{r.refundableQty} 个 / ¥{money(r.refundableAmount)}</b></div>
              {r.pendingRefundQty > 0 && <p className="membership-note">退押申请审核中 {r.pendingRefundQty} 个，管理员审核通过后退款。</p>}
              {r.pendingDamageQty > 0 && <p className="membership-note">待报废 {r.pendingDamageQty} 个，占用押金 ¥{money(r.pendingDamageAmount)}，确认报废后扣除。</p>}
            </div>
          </div>
        ); })}
        <p className="membership-note">退押金：把空桶还到店里或交给送水员登记收回，店里核对后按原收款价退还。</p>
      </div>
    )}
  </>;
}

export function MemberRecords({ profile, go }: MemberPageProps) {
  const { api } = useAuth();
  const { data, error, reload } = useLoader(() => api.ticketBatches(profile.id), [api, profile.id]);
  return <>
    <div className="mobile-top"><h2>充值记录</h2><button type="button" className="btn sm" onClick={() => go('profile')}><Icon name="back" size="sm" />返回</button></div>
    {!data ? <Loading error={error} onRetry={reload} /> : (
      <div className="h5-body">
        <BatchCards batches={data} />
      </div>
    )}
  </>;
}

export function MemberProfilePage({ profile, go }: MemberPageProps) {
  const { logout } = useAuth();
  const dialogs = useDialogs();
  const changePassword = () => dialogs.open(close => <ChangePasswordDialog onClose={close} />);
  return <>
    <div className="mobile-top"><h2>个人中心</h2><span className="tag gold">麒麟会员</span></div>
    <div className="h5-body">
      <div className="h5-card" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <Logo style={{ width: 46, height: 46 }} />
        <div><b style={{ fontSize: 16, color: 'var(--ink)' }}>{profile.name}</b><div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 2 }}>{profile.phone} · {profile.memberNo}</div></div>
      </div>
      <div className="profile-list">
        <div className="profile-row" role="button" tabIndex={0} onClick={() => go('orders')} onKeyDown={e => e.key === 'Enter' && go('orders')}>
          <Icon name="order" /><span>用水记录</span><Icon name="chevron" />
        </div>
        <div className="profile-row" role="button" tabIndex={0} onClick={() => go('records')} onKeyDown={e => e.key === 'Enter' && go('records')}>
          <Icon name="wallet" /><span>充值记录</span><Icon name="chevron" />
        </div>
        <div className="profile-row" role="button" tabIndex={0} onClick={changePassword} onKeyDown={e => e.key === 'Enter' && changePassword()}>
          <Icon name="shield" /><span>修改密码</span><Icon name="chevron" />
        </div>
        <div className="profile-row" role="button" tabIndex={0} style={{ color: 'var(--red-500)' }} onClick={() => void logout()} onKeyDown={e => e.key === 'Enter' && void logout()}>
          <Icon name="logout" /><span>退出登录 / 切换账号</span><small>当前 {profile.phone} ›</small>
        </div>
      </div>
      <p style={{ textAlign: 'center', color: 'var(--muted)', fontSize: 11.5, marginTop: 18, letterSpacing: 1.5 }}>
        {KUNLUN_BRAND.signage}<br /><span style={{ color: 'var(--brand-600)' }}>{KUNLUN_BRAND.slogan}</span>
      </p>
    </div>
  </>;
}
