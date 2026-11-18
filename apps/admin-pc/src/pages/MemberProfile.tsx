import { useEffect, useState, type ReactNode } from 'react';
import {
  KUNLUN_PERMISSIONS as P, containerLabel, containerUnit, isPricedBatch, modeLabel, money, orderStatusLabel, payMethodLabel, shortDateTime,
  ticketGroups, unitOf, waterFallbackLabel,
  type DepositFlowType, type DepositLedgerRow, type DepositSummaryRow, type MemberProfile, type Paged, type RechargeLedgerRow,
  type TicketBatch, type WaterOrder,
} from '@kunlun/shared';
import {
  AddressBook, MemberDamageReviews, BatchCards, Icon, RefundBatchDialog, SettlementDialog, SettlementRecords, canSettle, useAuth, useDialogs, useLoader,
  useRun, useSettlements,
} from '@kunlun/ui';
import { StatCard, useOperations } from '../common';
import { useAdminData } from '../data';
import { useMemberStatusActions } from '../memberStatus';
import { OpeningCard, OpeningDialog } from '../opening';

/** Rows shown in each tab of 最近记录. */
const RECENT = 8;

/**
 * 会员 360° 档案：一位会员的水票与充值批次、押金与桶袋、资料地址和最近记录在一个整页里看全，常用办理放在页头。
 * 「可能要退的钱」= 已交押金 + 没用完的水费（剩余付费票按原实付单价折算），与工作台的全站合计同一口径。
 */
export function MemberProfilePage({ memberId, onBack }: { memberId: string; onBack: () => void }) {
  const { api } = useAuth();
  const { version, setSelectedMemberId } = useAdminData();
  // Operation dialogs opened elsewhere preselect this member.
  useEffect(() => { setSelectedMemberId(memberId); }, [memberId, setSelectedMemberId]);
  // Every refresh after an operation bumps `version`, so the page re-reads whatever the operation changed.
  const profile = useLoader(() => api.memberProfile(memberId), [api, memberId, version]);
  const member = profile.data?.id === memberId ? profile.data : null;
  return <>
    <button type="button" className="back-link" onClick={onBack}><Icon name="back" size="sm" />返回会员列表</button>
    {member ? <Profile member={member} />
      : <div className="card profile-placeholder">{profile.error ? <p className="account-error" role="alert">{profile.error}</p> : <p className="membership-note">正在读取会员档案…</p>}</div>}
  </>;
}

/** A batch whose tickets are still in use: active with tickets left. */
const inUse = (b: TicketBatch) => b.status === 'ACTIVE' && b.remainingBuy + b.remainingGift > 0;

function Profile({ member: m }: { member: MemberProfile }) {
  const { api, can } = useAuth();
  const dialogs = useDialogs();
  const run = useRun();
  const ops = useOperations();
  const status = useMemberStatusActions();
  const { version, refresh } = useAdminData();
  // A disabled member cannot be served: the server refuses every business, so the page offers none until they are enabled again.
  // Disabling and deleting live in the member list's 操作 column; a disabled member's banner can enable them again.
  const disabled = m.status === 'DISABLED';
  const manage = can(P.MemberManage);
  const deposits = useLoader(() => api.depositSummary(m.id), [api, m.id, version]);
  const batches = useLoader(() => api.ticketBatches(m.id), [api, m.id, version]);
  const settlements = useSettlements(m.id, version);
  const [allBatches, setAllBatches] = useState(false);

  const tickets = ticketGroups(m.tickets);
  const available = m.tickets.reduce((sum, t) => sum + t.available, 0);
  const reserved = m.tickets.reduce((sum, t) => sum + t.reserved, 0);
  const rows = deposits.data;
  const held = (kind: 'BUCKET' | 'BAG') => rows
    ? rows.filter(r => r.containerKind === kind).reduce((sum, r) => sum + r.heldQty, 0)
    : kind === 'BUCKET' ? m.heldBuckets : m.heldBags;
  const depositPaid = rows?.[0]?.pool.total;
  const pool = rows?.[0]?.pool;
  const list = batches.data;
  // Packages recorded from before the system count at the price recorded with them; without one they stay unpriced.
  const unused = list?.reduce((sum, b) => sum + Number(b.remainingValue), 0);
  const unusedQty = list?.reduce((sum, b) => sum + (isPricedBatch(b) && b.status === 'ACTIVE' ? b.remainingBuy : 0), 0);
  const unpriced = list?.reduce((sum, b) => sum + (!isPricedBatch(b) && b.status === 'ACTIVE' ? b.remainingBuy + b.remainingGift : 0), 0) ?? 0;
  const owed = depositPaid !== undefined && unused !== undefined ? depositPaid + unused : undefined;
  const live = list?.filter(inUse) ?? [];
  const hidden = (list?.length ?? 0) - live.length;
  const shown = allBatches ? list ?? [] : live;
  const allowSettlement = !disabled && canSettle(can);
  const batchRefund = !disabled && !allowSettlement && (can(P.RechargeCreate) || can(P.RechargeRefund))
    ? (batch: TicketBatch) => run(() => dialogs.open(close => <RefundBatchDialog memberId={m.id} batch={batch} onClose={close} onDone={refresh} />))()
    : undefined;

  const settle = run(() => dialogs.open(close => <SettlementDialog memberId={m.id} memberName={m.name} onClose={close} onDone={refresh} />));

  return <>
    <section className="profile-hero" aria-label="会员概况">
      <div className="profile-avatar">{m.name[0]}</div>
      <div className="profile-id">
        <h2>{m.name}<span className={`tag ${m.status === 'ACTIVE' ? 'green' : 'gray'}`}>{m.status === 'ACTIVE' ? '正常' : '已停用'}</span></h2>
        <p><span>{m.memberNo}</span><span>{m.phone}</span><span>建档 {(m.createdAt || '').slice(0, 10) || '—'}</span></p>
      </div>
      {!disabled && <div className="profile-actions">
        <button type="button" className="btn primary" onClick={() => ops.order(m.id)}><Icon name="drop" />点单</button>
        <button type="button" className="btn" onClick={() => ops.recharge(m.id)}><Icon name="wallet" />水费充值</button>
        <button type="button" className="btn" onClick={() => ops.deposit('collect', m.id)}><Icon name="deposit" />收押金</button>
        <button type="button" className="btn" onClick={() => ops.deposit('refund', m.id)}><Icon name="refund" />退押金</button>
        <button type="button" className="btn" onClick={() => ops.movement(m.id)}><Icon name="swap" />登记领还</button>
        {allowSettlement && (
          <button type="button" className="btn" title="会员不再订水或搬家：一张退款单结清剩余水票、押金和手里的桶袋" onClick={settle}><Icon name="refund" />退款结算</button>
        )}
        {can(P.MemberOpening) && (
          <button type="button" className="btn" title="补录这位会员用系统之前买的套餐、交的押金和手里的桶"
            onClick={run(() => dialogs.open(close => <OpeningDialog member={m} onClose={close} onDone={refresh} />))}><Icon name="ledger" />补录历史数据</button>
        )}
      </div>}
    </section>
    {disabled && <DisabledBanner member={m} onEnable={manage ? () => status.enable(m) : undefined} />}

    <div className="stats-grid profile-stats-grid">
      <StatCard label="可用水票" icon="ticket" value={<>{available}<small>张</small></>}
        foot={reserved ? `另有 ${reserved} 张被未完成的水单占用` : tickets.length ? `${tickets.length} 种水品，按自提 / 配送分开` : '还没有水票'} />
      <StatCard label="手里的桶袋" icon="box" tone="blue" value={<>{held('BUCKET')}<small>桶</small> {held('BAG')}<small>袋</small></>}
        foot={pool ? `按现行标准需押金 ¥${money(pool.required)}` : "正在核对…"} />
      <StatCard label="已交押金" icon="deposit" tone="gold" value={depositPaid === undefined ? '—' : `¥ ${money(depositPaid)}`}
        foot={deposits.error || (!pool ? '正在核对…' : pool.shortfall > 0 ? `欠押金 ¥${money(pool.shortfall)}` : `押金已覆盖 · 可退 ¥${money(pool.available)}`)} />
      <StatCard label="没用完的水费" icon="wallet" value={unused === undefined ? '—' : `¥ ${money(unused)}`}
        foot={batches.error || (unusedQty === undefined ? '正在核对…' : `剩余付费水票 ${unusedQty} 张，按原实付单价折算`)} />
      <StatCard label="可能要退的钱" icon="refund" tone="orange" value={owed === undefined ? '—' : `¥ ${money(owed)}`}
        foot={unpriced ? `押金 + 没用完的水费；另有 ${unpriced} 张历史余额未计价` : '押金 + 没用完的水费，会员要回去时得退，不算收入'} />
    </div>

    <div className="profile-grid">
      <div className="profile-col">
        <section className="card">
          <div className="card-head">
            <div className="card-title">水票与充值批次 <small>一种水的票只能换这种水，先充的批次先用</small></div>
            {can(P.RechargeCreate) && !disabled && <button type="button" className="btn sm primary" onClick={() => ops.recharge(m.id)}><Icon name="plus" size="sm" />充值</button>}
          </div>
          <div className="profile-card-body">
            {tickets.length ? (
              <table className="profile-table">
                <thead><tr><th>水品</th><th>自提票</th><th>配送票</th><th>未完成水单占用</th></tr></thead>
                <tbody>{tickets.map(g => (
                  <tr key={g.waterType}>
                    <td>{g.name}</td><td><b>{g.pickup}</b> {g.unit}</td><td><b>{g.delivery}</b> {g.unit}</td>
                    <td>{g.reserved > 0 ? <span className="tag orange">{g.reserved} {g.unit}</span> : <span className="profile-muted">—</span>}</td>
                  </tr>
                ))}</tbody>
              </table>
            ) : <p className="membership-note">暂无水票，可先充值再点单。</p>}
            <div className="profile-subhead">
              <b>充值批次</b>
              {allowSettlement && <button type="button" className="btn sm" onClick={settle}>退款（全部结算）</button>}
              {hidden > 0 && <button type="button" className="text-btn" onClick={() => setAllBatches(v => !v)}>{allBatches ? '只看在用的批次' : `显示已用完 / 已退款的 ${hidden} 个批次`}</button>}
            </div>
            {batches.error ? <p className="account-error" role="alert">{batches.error}</p>
              : !list ? <p className="membership-note">正在加载充值批次…</p>
              : !shown.length && hidden > 0 ? <p className="membership-note">没有在用的批次，水票都已用完或退款。</p>
              : <div className="profile-batches"><BatchCards batches={shown} onRefund={batchRefund} /></div>}
          </div>
        </section>
        <RecentRecords member={m} />
      </div>

      <div className="profile-col">
        <section className="card">
          <div className="card-head">
            <div className="card-title">押金与桶袋 <small>按会员余额收退</small></div>
            {!disabled && <div className="profile-head-actions">
              <button type="button" className="text-btn" onClick={() => ops.deposit('collect', m.id)}>收押金</button>
              <button type="button" className="text-btn" onClick={() => ops.deposit('refund', m.id)}>退押金</button>
            </div>}
          </div>
          <div className="profile-card-body profile-containers">
            {deposits.error ? <p className="account-error" role="alert">{deposits.error}</p>
              : !rows ? <p className="membership-note">正在核对押金…</p>
              : <>{pool && <p className={pool.shortfall ? 'profile-warn' : 'membership-note'}>现有押金 ¥{money(pool.total)} · 持有桶袋需 ¥{money(pool.required)} · {pool.shortfall > 0 ? `欠押金 ¥${money(pool.shortfall)}` : '已覆盖'}
                {pool.pendingCollect > 0 && ` · 收款待审核 ¥${money(pool.pendingCollect)}`}{pool.pending > 0 && ` · 退款待审核 ¥${money(pool.pending)}`}</p>}
                {rows.map(r => <ContainerDeposit key={r.containerType} row={r} />)}</>}
          </div>
        </section>
        <MemberDamageReviews key={m.id} memberId={m.id} version={version} />
        {settlements.data && settlements.data.length > 0 && (
          <section className="card">
            <div className="card-head"><div className="card-title">退款结算单 <small>一次结清水票、押金和桶袋的单子</small></div></div>
            <div className="profile-card-body"><SettlementRecords slips={settlements.data} /></div>
          </section>
        )}
        <section className="card">
          <div className="card-head">
            <div className="card-title">基础资料</div>
          </div>
          <div className="profile-card-body">
            <div className="detail-row"><span>会员编号</span><b>{m.memberNo}</b></div>
            <div className="detail-row"><span>联系电话</span><b>{m.phone}</b></div>
            <div className="detail-row"><span>默认收货地址</span><b className="detail-wrap">{m.defaultAddress || '未设置'}</b></div>
            <div className="detail-row"><span>建档时间</span><b>{(m.createdAt || '').slice(0, 10) || '—'}</b></div>
            {m.remark && <div className="detail-row"><span>备注</span><b className="detail-wrap">{m.remark}</b></div>}
          </div>
        </section>
        <section className="card">
          <div className="profile-card-body"><AddressBook key={m.id} owner={m} onChanged={refresh} compact /></div>
        </section>
        <OpeningCard member={m} />
      </div>
    </div>
  </>;
}

/** 已停用会员的页头提示：谁、什么时候、为什么停用，以及停用后办不了什么、余额怎么办。 */
function DisabledBanner({ member: m, onEnable }: { member: MemberProfile; onEnable?: () => void }) {
  const who = [m.disabledAt && shortDateTime(m.disabledAt), m.disabledBy].filter(Boolean).join(' · ');
  return (
    <div className="member-disabled-note profile-disabled" role="status">
      <div>
        <b>这位会员已停用{m.disableReason ? `：${m.disableReason}` : ''}</b>
        {who && `${who} 停用。`}会员端登录不了，也不能充值、点单、收退押金、退款、登记领还和补录；水票、押金和桶袋都还在，重新启用后照常用、照常退。
      </div>
      {onEnable && <button type="button" className="btn sm" onClick={onEnable}>重新启用</button>}
    </div>
  );
}

/** One container's deposit: what the member holds, what they paid and what they could take back now. */
function ContainerDeposit({ row: r }: { row: DepositSummaryRow }) {
  const unit = containerUnit(r.containerType);
  return (
    <div className={`profile-container${r.containerKind === 'BAG' ? ' bag' : ''}`}>
      <div className="profile-container-head"><b>{containerLabel(r.containerType)}</b><small>现行押金 ¥{money(r.unitDeposit)}/个</small></div>
      <div className="profile-nums">
        <div><small>手里</small><b>{r.heldQty}</b><small>个{unit}</small></div>
        <div><small>持有价值</small><b>¥{money(r.heldQty * r.unitDeposit)}</b></div>
        <div><small>累计登记破损</small><b>{r.damageQty} 个</b></div>
      </div>
      {r.pendingDamageQty > 0 && <p className="membership-note">{r.pendingDamageQty} 个{unit}待确认报废，占用押金 ¥{money(r.pendingDamageAmount)}，确认报废后按原批次扣除。</p>}
    </div>
  );
}

type RecordTab = 'orders' | 'recharges' | 'deposits';
const RECORD_TABS: Array<[RecordTab, string]> = [['orders', '水单'], ['recharges', '充值'], ['deposits', '押金']];
type Records = ({ tab: 'orders' } & Paged<WaterOrder>) | ({ tab: 'recharges' } & Paged<RechargeLedgerRow>) | ({ tab: 'deposits' } & Paged<DepositLedgerRow>);
const FLOW_TAGS: Record<DepositFlowType, [string, string]> = { TRANSFER: ['水费转押金', 'blue'], COLLECT: ['收押金', 'green'], REFUND: ['退押金', 'blue'], DEDUCT: ['扣押金', 'orange'], OPENING: ['上系统前', 'gold'] };
const ORDER_TONES: Record<WaterOrder['status'], string> = { PENDING: 'orange', DISPATCHED: 'aqua', COMPLETED: 'gray', CANCELLED: 'red' };

/** The member's newest orders, recharges and deposit flows, one tab at a time. */
function RecentRecords({ member: m }: { member: MemberProfile }) {
  const { api } = useAuth();
  const { version } = useAdminData();
  const [tab, setTab] = useState<RecordTab>('orders');
  // The ledgers search by member number; numbers have one fixed shape, and rows are checked against it again below.
  const records = useLoader(async (): Promise<Records> => {
    if (tab === 'orders') return { tab, ...await api.ordersPage({ memberId: m.id, pageSize: RECENT }) };
    if (tab === 'recharges') return { tab, ...await api.rechargeLedger({ q: m.memberNo, pageSize: RECENT }) };
    return { tab, ...await api.depositLedger({ q: m.memberNo, pageSize: RECENT }) };
  }, [api, m.id, m.memberNo, tab, version]);
  const data = records.data?.tab === tab ? records.data : null;

  let body: ReactNode;
  if (records.error) body = <p className="account-error" role="alert">{records.error}</p>;
  else if (!data) body = <p className="membership-note">正在加载…</p>;
  else if (data.tab === 'orders') body = data.rows.length ? (
    <table className="profile-table">
      <thead><tr><th>水单号 / 时间</th><th>水品与数量</th><th>方式</th><th>状态</th></tr></thead>
      <tbody>{data.rows.map(o => (
        <tr key={o.id}>
          <td><span className="order-no">{o.orderNo}</span><small>{shortDateTime(o.createdAt)}</small></td>
          <td>{o.productSnapshot?.waterLabel || waterFallbackLabel(o.waterType)} × <b>{o.actualQty ?? o.orderQty}</b> {unitOf(o.waterType)}</td>
          <td>{modeLabel(o.fulfillMode)}</td>
          <td><span className={`tag ${ORDER_TONES[o.status] ?? 'gray'}`}>{orderStatusLabel(o)}</span></td>
        </tr>
      ))}</tbody>
    </table>
  ) : <p className="membership-note">还没有水单</p>;
  else if (data.tab === 'recharges') {
    const rows = data.rows.filter(r => r.memberNo === m.memberNo);
    body = rows.length ? (
      <table className="profile-table">
        <thead><tr><th>充值单号 / 时间</th><th>套餐</th><th>实付</th><th>到账水票</th></tr></thead>
        <tbody>{rows.map(r => (
          <tr key={r.rechargeNo}>
            <td><span className="order-no">{r.rechargeNo}</span><small>{shortDateTime(r.createdAt)}</small></td>
            <td>{r.planName}</td>
            <td><b>¥{money(r.paidAmount)}</b><small>{payMethodLabel(r.payMethod)}</small></td>
            <td>{r.buyQty}{r.giftQty > 0 ? ` + 赠 ${r.giftQty}` : ''} 张{r.refundNo && <> <span className="tag gray">已退 ¥{money(r.refundAmount ?? 0)}</span></>}</td>
          </tr>
        ))}</tbody>
      </table>
    ) : <p className="membership-note">还没有充值记录</p>;
  } else {
    const rows = data.rows.filter(r => r.memberNo === m.memberNo);
    body = rows.length ? (
      <table className="profile-table">
        <thead><tr><th>单号 / 时间</th><th>类型</th><th>桶袋</th><th>金额</th></tr></thead>
        <tbody>{rows.map(r => {
          const [label, tone] = FLOW_TAGS[r.flowType] ?? [r.flowType, 'gray'];
          return (
            <tr key={`${r.flowType}:${r.docNo}`}>
              <td><span className="order-no">{r.docNo}</span><small>{shortDateTime(r.createdAt)}</small></td>
              <td><span className={`tag ${tone}`}>{label}</span></td>
              <td>{r.containerType ? `${containerLabel(r.containerType)} × ${r.qty}` : '会员押金池'}</td>
              <td><b>{r.flowType === 'COLLECT' || r.flowType === 'OPENING' || r.flowType === 'TRANSFER' ? '' : '−'}¥{money(r.amount)}</b></td>
            </tr>
          );
        })}</tbody>
      </table>
    ) : <p className="membership-note">还没有押金记录</p>;
  }

  return (
    <section className="card">
      <div className="card-head">
        <div className="card-title">最近记录 <small>{data && data.total > RECENT ? `共 ${data.total} 条，显示最近 ${RECENT} 条` : '最近的办理记录'}</small></div>
        <div className="seg-switch profile-tabs" role="group" aria-label="记录类型">
          {RECORD_TABS.map(([id, label]) => <button key={id} type="button" aria-pressed={tab === id} onClick={() => setTab(id)}>{label}</button>)}
        </div>
      </div>
      <div className="profile-card-body">{body}</div>
    </section>
  );
}
