import { Link } from 'react-router-dom';
import { KUNLUN_BRAND, containerLabel, isActiveOrder, modeLabel, money, pathFor, type FulfillMode, type MemberProfile, type WaterOrder } from '@kunlun/shared';
import { AddressBook, BatchCards, ChangePasswordDialog, CouponCards, Icon, Logo, useAuth, useDialogs, useLoader, useRun, useToast } from '@kunlun/ui';
import { OrderCard } from '../shared/OrderCard';
import { Loading } from '../shared/H5Shell';
import { useMemberData } from './data';

export interface MemberPageProps {
  profile: MemberProfile;
  go: (page: string) => void;
  openOrder: (mode: FulfillMode) => void;
  showPickup: (orderNo: string, code: string) => void;
  openAssets: () => void;
}

function MemberOrder({ order, showPickup }: { order: WaterOrder; showPickup: MemberPageProps['showPickup'] }) {
  const { api } = useAuth();
  const { refresh } = useMemberData();
  const toast = useToast();
  const run = useRun();
  const cancel = run(async () => {
    await api.cancelOrder(order.id, '会员取消订单');
    await refresh();
    toast(`水单 ${order.orderNo} 已取消，预占水票已释放`);
  });
  return (
    <OrderCard order={order} title={modeLabel(order.fulfillMode)} actions={isActiveOrder(order) && <>
      {order.pickupCode && <button type="button" className="btn sm" onClick={() => showPickup(order.orderNo, order.pickupCode!)}>取水码 {order.pickupCode}</button>}
      <button type="button" className="btn sm" onClick={cancel}>取消订单</button>
    </>} />
  );
}

export function MemberHome({ profile, openOrder, showPickup, openAssets }: MemberPageProps) {
  const { orders } = useMemberData();
  const active = orders.find(isActiveOrder);
  const tickets = [
    { value: profile.bucketDeliveryTickets, unit: '桶', label: '配送桶票可用', reserved: profile.reservedBucketDeliveryTickets },
    { value: profile.bucketPickupTickets, unit: '桶', label: '自提桶票可用' },
    { value: profile.bagPickupTickets, unit: '袋', label: '自提袋票可用' },
    { value: profile.bagDeliveryTickets, unit: '袋', label: '配送袋票可用' },
  ];
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
        <div className="wallet-head"><b>我的水票资产</b><button type="button" className="link" onClick={openAssets}>水票 / 优惠券 ›</button></div>
        <div className="ticket-grid">
          {tickets.map(t => (
            <div key={t.label} className="ticket-box">
              <div className="num">{t.value}<small>{t.unit}</small></div>
              <div className="label"><span>{t.label}</span>{t.reserved !== undefined && <em>预占 {t.reserved}</em>}</div>
            </div>
          ))}
        </div>
      </div>
      <div className="member-actions">
        <button type="button" className="member-action" onClick={() => openOrder('DELIVERY')}>
          <Icon name="truck" size="xl" /><span><b>送水到家</b><small>扣配送票 · 预约上门</small></span>
        </button>
        <button type="button" className="member-action aqua" onClick={() => openOrder('PICKUP')}>
          <Icon name="store" size="xl" /><span><b>到店自提</b><small>扣自提票 · 取水码核销</small></span>
        </button>
      </div>
      <div className="h5-section-head"><h3>进行中的水单</h3><Link to={pathFor('member', 'orders')}>全部水单 ›</Link></div>
      {active ? <MemberOrder order={active} showPickup={showPickup} /> : <div className="h5-card"><p className="membership-note">暂无进行中的水单</p></div>}
      <div className="h5-section-head"><h3>我的容器与押金</h3><Link to={pathFor('member', 'assets')}>查看明细 ›</Link></div>
      <div className="h5-card">
        <div className="asset-mini-grid">
          <div><b>{profile.heldBuckets}</b><small>持有周转桶</small></div>
          <div><b>{profile.heldBags}</b><small>持有周转水袋</small></div>
          <div><b>¥{Number(profile.depositAmount).toFixed(0)}</b><small>已交押金</small></div>
        </div>
      </div>
    </div>
  </>;
}

export function MemberOrders({ openOrder, showPickup }: MemberPageProps) {
  const { orders } = useMemberData();
  return <>
    <div className="mobile-top"><h2>我的水单</h2><button type="button" className="btn primary sm" onClick={() => openOrder('DELIVERY')}><Icon name="plus" size="sm" />预约用水</button></div>
    <div className="h5-body">
      {orders.length ? orders.map(o => <MemberOrder key={o.id} order={o} showPickup={showPickup} />) : <p className="membership-note">暂无水单</p>}
    </div>
  </>;
}

export function MemberAssets({ profile }: MemberPageProps) {
  const { api } = useAuth();
  const toast = useToast();
  const { data: rows, error, reload } = useLoader(() => api.depositSummary(profile.id), [api, profile.id]);
  return <>
    <div className="mobile-top"><h2>押金与容器资产</h2><Link to={pathFor('member', 'records')} style={{ fontSize: 12 }}>全部流水 ›</Link></div>
    {!rows ? <Loading error={error} onRetry={reload} /> : (
      <div className="h5-body">
        <div className="h5-card" style={{ background: 'var(--grad-card)', color: '#fff' }}>
          <small style={{ opacity: 0.8 }}>我的在池押金总额</small>
          <div className="num" style={{ fontSize: 30, fontWeight: 700, margin: '4px 0' }}>¥ {money(rows.reduce((sum, r) => sum + r.paidAmount, 0))}</div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, opacity: 0.88 }}>
            {rows.map(r => <span key={r.containerType}>{r.containerType === 'BUCKET' ? '桶押金' : '袋押金'} ¥{money(r.paidAmount)}（{r.paidQty}个）</span>)}
          </div>
        </div>
        {rows.map(r => (
          <div key={r.containerType}>
            <div className="h5-section-head"><h3>{containerLabel(r.containerType)}</h3><span className={`tag ${r.heldQty <= r.paidQty ? 'green' : 'orange'}`}>{r.heldQty <= r.paidQty ? '押金已覆盖' : '需补交押金'}</span></div>
            <div className="h5-card">
              <div className="detail-row"><span>已交未退押金（按原收款批次）</span><b>{r.paidQty} 个 / ¥{money(r.paidAmount)}</b></div>
              <div className="detail-row"><span>当前实际持有</span><b>{r.heldQty} 个</b></div>
              <div className="detail-row"><span>当前可退押金（已交 − 持有）</span><b style={{ color: 'var(--brand-600)' }}>{r.refundableQty} 个 / ¥{money(r.refundableAmount)}</b></div>
            </div>
          </div>
        ))}
        <button type="button" className="btn block" onClick={() => toast('请先将空桶归还至绿麒麟水站或交由送水员登记收回，即可退还对应押金')}>如何退押金？</button>
      </div>
    )}
  </>;
}

export function MemberRecords({ profile, go }: MemberPageProps) {
  const { api } = useAuth();
  const { data, error, reload } = useLoader(() => Promise.all([api.ticketBatches(profile.id), api.memberCoupons(profile.id)]), [api, profile.id]);
  return <>
    <div className="mobile-top"><h2>业务变动流水</h2><button type="button" className="btn sm" onClick={() => go('home')}>返回</button></div>
    {!data ? <Loading error={error} onRetry={reload} /> : (
      <div className="h5-body">
        <h3>充值与退款记录</h3>
        <BatchCards batches={data[0]} />
        <h3>我的优惠券</h3>
        <CouponCards coupons={data[1]} />
      </div>
    )}
  </>;
}

export function MemberProfilePage({ profile, go }: MemberPageProps) {
  const { logout } = useAuth();
  const dialogs = useDialogs();
  return <>
    <div className="mobile-top"><h2>个人中心</h2><span className="tag gold">麒麟会员</span></div>
    <div className="h5-body">
      <div className="h5-card" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <Logo style={{ width: 46, height: 46 }} />
        <div><b style={{ fontSize: 16, color: 'var(--ink)' }}>{profile.name}</b><div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 2 }}>{profile.phone} · {profile.memberNo}</div></div>
      </div>
      <div className="profile-list">
        <div className="profile-row" role="button" tabIndex={0} onClick={() => go('addresses')} onKeyDown={e => e.key === 'Enter' && go('addresses')}>
          <Icon name="location" /><span>我的收货地址</span><small>{profile.defaultAddress || '未设置'}</small><Icon name="chevron" />
        </div>
        <div className="profile-row" role="button" tabIndex={0} onClick={() => go('records')} onKeyDown={e => e.key === 'Enter' && go('records')}>
          <Icon name="order" /><span>充值与用水记录</span><Icon name="chevron" />
        </div>
        <div className="profile-row" role="button" tabIndex={0} onClick={() => dialogs.open(close => <ChangePasswordDialog onClose={close} />)} onKeyDown={e => e.key === 'Enter' && dialogs.open(close => <ChangePasswordDialog onClose={close} />)}>
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

export function MemberAddresses({ profile, go }: MemberPageProps) {
  const { refresh } = useMemberData();
  return <>
    <div className="mobile-top"><h2>我的收货地址</h2><button type="button" className="btn sm" onClick={() => go('profile')}><Icon name="back" size="sm" />返回</button></div>
    <div className="h5-body">
      <div className="address-hint"><Icon name="info" size="sm" /><span>新增地址时联系人和手机号默认带出本人信息，代收时可改为实际收货人。送水下单默认使用默认地址。</span></div>
      <AddressBook owner={{ id: profile.id, name: profile.name, phone: profile.phone }} onChanged={refresh} />
    </div>
  </>;
}
