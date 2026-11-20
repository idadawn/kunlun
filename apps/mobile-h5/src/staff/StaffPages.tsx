import { KUNLUN_BRAND, KUNLUN_PERMISSIONS as P, ROLE_LABELS, containerKind, containerLabel, isActiveOrder, money, shortDateTime, ticketGroups, type ContainerSummaryItem, type MobileFeature, type StaffRole, type WaterOrder } from '@kunlun/shared';
import {
  ChangePasswordDialog, CounterOrder, Icon, OrderCard, StockEditDialog, StockQuickDialog, WorkbenchHome, useAuth, useDialogs, useRun,
  type StockCount,
} from '@kunlun/ui';
import { AndroidAppVersion, Loading } from '../shared/H5Shell';
import { useMobileLayout, useStaffData } from './data';
import { useStaffOperations } from './operations';

export interface StaffPageProps { go: (page: string) => void }

function StaffOrder({ order }: { order: WaterOrder }) {
  const { members } = useStaffData();
  const { can } = useAuth();
  const ops = useStaffOperations();
  const title = members.find(m => m.id === order.memberId)?.name || order.addressSnapshot?.contactName || '会员';
  const accept = order.status === 'PENDING' && order.fulfillMode === 'DELIVERY' && can(P.OrderAccept);
  return (
    <OrderCard order={order} title={title} showContact actions={isActiveOrder(order) && <>
      {accept && <button type="button" className="btn sm" onClick={() => ops.accept(order)}>接单</button>}
      {can(P.OrderFulfill) && <button type="button" className="btn primary sm" onClick={() => ops.fulfill(order)}>{order.fulfillMode === 'PICKUP' ? '核销自提' : '确认交付'}</button>}
    </>} />
  );
}

/** 工作台：角色开通的功能按后台配置的顺序排列，和管理端「移动端配置」的手机预览一致。 */
export function StaffHome({ go }: StaffPageProps) {
  const { user } = useAuth();
  const { orders, memberTotal, containers, overview, loaded, error, refresh } = useStaffData();
  const ops = useStaffOperations();
  const open = (feature: MobileFeature) => {
    if (feature.page) { go(feature.page); return; }
    ops.open(feature.key);
  };
  return (
    <WorkbenchHome
      features={user.mobileFeatures ?? []}
      data={{
        name: user.displayName, account: user.codeOrNo,
        orders: loaded ? orders : undefined, memberTotal: loaded ? memberTotal : undefined,
        containers: loaded ? containers : undefined, overview,
      }}
      onOpen={open}
      renderOrder={o => <StaffOrder key={o.id} order={o} />}
      ordersFallback={<Loading error={error} onRetry={() => refresh().catch(() => undefined)} />}
    />
  );
}

/** 门店点单：找到顾客后像点外卖一样选水；自提即当场交付并换桶，配送则生成待送水单。 */
export function StaffCounter() {
  const { can } = useAuth();
  const layout = useMobileLayout();
  const { products, selectedMemberId, setSelectedMemberId, refresh } = useStaffData();
  const ops = useStaffOperations();
  return <>
    <div className="mobile-top"><h2>门店点单</h2><span className="tag green">到店取水 · 送水上门</span></div>
    <div className="h5-body">
      {can(P.OrderCreate)
        ? <CounterOrder products={products} memberId={selectedMemberId} onMemberChange={setSelectedMemberId}
          onRecharge={layout.has('recharge') && can(P.RechargeCreate) ? ops.rechargeFor : undefined}
          onNewMember={layout.has('newMember') && can(P.MemberWrite) ? ops.createMember : undefined} onPlaced={refresh} />
        : <p className="account-error" role="alert">当前账号没有点单权限</p>}
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
  const layout = useMobileLayout();
  const ops = useStaffOperations();
  const run = useRun();
  const canCreate = layout.has('newMember');
  return <>
    <div className="mobile-top"><h2>会员查询与办理</h2>{canCreate && <button type="button" className="btn primary sm" onClick={ops.newMember}><Icon name="plus" size="sm" />新建</button>}</div>
    <div className="h5-body">
      <label className="field-search" style={{ marginBottom: 12 }}><Icon name="search" /><input placeholder="输入姓名、手机号或会员编号" aria-label="搜索会员" value={query} onChange={e => setQuery(e.target.value)} /></label>
      <div className="h5-section-head"><h3>{query.trim() ? '搜索结果' : '常用会员'}</h3><span>{loaded ? `共 ${memberTotal} 位 · ` : ''}点击查看与办理</span></div>
      {!loaded ? <Loading error={error} onRetry={() => refresh().catch(() => undefined)} /> : members.length === 0 ? <p className="membership-note">{canCreate ? '未找到会员，可点击右上角新建' : '未找到会员'}</p> : members.map(m => (
        <div key={m.id} className="h5-card" role="button" tabIndex={0} style={{ cursor: 'pointer' }} onClick={() => ops.detail(m)} onKeyDown={e => e.key === 'Enter' && ops.detail(m)}>
          <div className="member-cell">
            <div className="member-avatar">{m.name[0]}</div>
            <div><b>{m.name}</b><small>{m.phone} · {m.memberNo}</small></div>
            {m.status === 'DISABLED'
              ? <span className="tag gray" style={{ marginLeft: 'auto' }}>已停用</span>
              : <span className="tag green" style={{ marginLeft: 'auto' }}>查看 ›</span>}
          </div>
          <div className="wallet-tickets">
            {m.tickets.length === 0 && <span>暂无水票</span>}
            {ticketGroups(m.tickets).map(g => <span key={g.waterType}>{g.name}<span>自提 <b>{g.pickup}</b> · 配送 <b>{g.delivery}</b> {g.unit}</span></span>)}
          </div>
          <div className="wallet-sub">
            <span>押金 <b>¥{Number(m.depositAmount).toFixed(2)}</b></span>
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

/** 袋桶库存：每种桶袋三个数，点数字直接改；新购、报废一步登记。 */
export function StaffInventory() {
  const { containers, loaded, error, refresh } = useStaffData();
  const { can } = useAuth();
  const dialogs = useDialogs();
  const run = useRun();
  const manage = can(P.ContainerInventoryManage);
  const low = containers.filter(c => c.lowStockWarning).length;
  const edit = (config: ContainerSummaryItem, focus: StockCount) => run(() => dialogs.open(close => <StockEditDialog config={config} focus={focus} onClose={close} onDone={refresh} />))();
  const quick = (config: ContainerSummaryItem, action: 'RECEIVE' | 'SCRAP') => run(() => dialogs.open(close => <StockQuickDialog config={config} action={action} onClose={close} onDone={refresh} />))();
  return <>
    <div className="mobile-top"><h2>袋桶库存</h2><button type="button" className="btn sm" onClick={run(refresh)}><Icon name="refresh" size="sm" />刷新</button></div>
    {!loaded ? <Loading error={error} onRetry={run(refresh)} /> : (
      <div className="h5-body">
        <p className="membership-note stock-lead">{low ? `有 ${low} 种桶袋店里偏少，记得补货。` : '新买的点「新购」，坏了扔掉的点「报废」，数量不对点数字直接改。'}</p>
        {containers.length === 0 && <p className="membership-note">还没有水品和配套桶袋。</p>}
        {containers.map(c => (
          <article key={c.containerType} className={`h5-card m-stock${c.lowStockWarning ? ' low' : ''}`}>
            <header>
              <span className={`quick-icon ${containerKind(c.containerType) === 'BAG' ? 'aqua' : 'blue'}`}><Icon name="drop" /></span>
              <div><b>{containerLabel(c.containerType)}</b><small>押金 ¥{money(c.unitDeposit)} / 个{c.countedAt ? ` · ${shortDateTime(c.countedAt)} 改过` : ''}</small></div>
              {c.lowStockWarning && <span className="tag orange">店里偏少</span>}
            </header>
            <div className="m-stock-tiles">
              <StockTile label="店里" value={c.inStationQty} note={c.warnThreshold > 0 ? `少于 ${c.warnThreshold} 提醒` : '空的满的都算'} warn={c.lowStockWarning} onEdit={manage ? () => edit(c, 'inStationQty') : undefined} />
              <StockTile label="客户手里" value={c.withCustomersQty} note={`会员名下 ${c.memberHeldQty}`} onEdit={manage ? () => edit(c, 'withCustomersQty') : undefined} />
              <StockTile label="已报废" value={c.scrappedQty} note="累计" onEdit={manage ? () => edit(c, 'scrappedQty') : undefined} />
            </div>
            <footer>
              <span>合计 <b>{c.totalQty}</b> 个{c.damagedQty > 0 && <small> · 含待确认报废 {c.damagedQty}</small>}</span>
              {manage && <div className="membership-actions">
                <button type="button" className="btn sm" onClick={() => quick(c, 'RECEIVE')}><Icon name="plus" size="sm" />新购</button>
                <button type="button" className="btn sm" disabled={c.inStationQty === 0} onClick={() => quick(c, 'SCRAP')}><Icon name="trash" size="sm" />报废</button>
              </div>}
            </footer>
          </article>
        ))}
      </div>
    )}
  </>;
}

function StockTile({ label, value, note, warn, onEdit }: { label: string; value: number; note: string; warn?: boolean; onEdit?: () => void }) {
  const body = <><small>{label}</small><b>{value}</b><em>{note}</em></>;
  return onEdit
    ? <button type="button" className={`m-stock-tile${warn ? ' warn' : ''}`} aria-label={`修改${label}的数量，现在 ${value} 个`} onClick={onEdit}>{body}</button>
    : <div className={`m-stock-tile${warn ? ' warn' : ''}`}>{body}</div>;
}

export function StaffProfile() {
  const { user, logout } = useAuth();
  const layout = useMobileLayout();
  const dialogs = useDialogs();
  const changePassword = () => dialogs.open(close => <ChangePasswordDialog onClose={close} />);
  return <>
    <div className="mobile-top"><h2>我的工作台</h2><span className="tag green">当班中</span></div>
    <div className="h5-body">
      <div className="h5-card" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div className="member-avatar" style={{ width: 48, height: 48, fontSize: 17 }}>{user.displayName[0]}</div>
        <div><b style={{ fontSize: 16, color: 'var(--ink)' }}>{user.displayName}</b><div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 2 }}>{user.codeOrNo} · {ROLE_LABELS[user.role as StaffRole] ?? user.role}</div></div>
      </div>
      <div className="h5-section-head"><h3>我能办理的业务</h3><span>由管理员按角色开通</span></div>
      <div className="h5-card profile-features">
        {layout.features.length ? layout.features.map(f => <span key={f.key} className="tag green">{f.label}</span>) : <span className="membership-note">暂未开通手机端功能</span>}
      </div>
      <div className="profile-list">
        <div className="profile-row"><Icon name="store" /><span>所属水站</span><small>{KUNLUN_BRAND.store}</small></div>
        <div className="profile-row" role="button" tabIndex={0} onClick={changePassword} onKeyDown={e => e.key === 'Enter' && changePassword()}><Icon name="shield" /><span>修改密码</span><Icon name="chevron" /></div>
        <AndroidAppVersion />
        <div className="profile-row" role="button" tabIndex={0} style={{ color: 'var(--red-500)' }} onClick={() => void logout()} onKeyDown={e => e.key === 'Enter' && void logout()}>
          <Icon name="logout" /><span>退出登录 / 切换员工账号</span><small>{user.codeOrNo} ›</small>
        </div>
      </div>
    </div>
  </>;
}
