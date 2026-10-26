import { useEffect, useState } from 'react';
import { KUNLUN_PERMISSIONS as P, money, pageCount, type DepositSummaryRow, type MemberProfile } from '@kunlun/shared';
import { AddressBook, CredentialsDialog, Icon, useAuth, useDialogs, useLoader } from '@kunlun/ui';
import { EmptyRow, Pager, useExport, useOperations } from '../common';
import { MEMBER_PAGE_SIZE, useAdminData, type MemberFilter } from '../data';

const PALETTE = [
  undefined,
  { background: 'var(--aqua-50)', color: 'var(--aqua-600)' },
  { background: 'var(--gold-50)', color: 'var(--gold-600)' },
  { background: 'var(--violet-50)', color: 'var(--violet-500)' },
  { background: 'var(--orange-50)', color: 'var(--orange-500)' },
];
const bucketTickets = (m: MemberProfile) => m.bucketPickupTickets + m.bucketDeliveryTickets;
const bagTickets = (m: MemberProfile) => m.bagPickupTickets + m.bagDeliveryTickets;

export function Members() {
  const { members: rows, memberTotal, loaded, overview, memberQuery, setMemberQuery, memberFilter, setMemberFilter, memberPage, setMemberPage, setSelectedMemberId } = useAdminData();
  const ops = useOperations();
  const exportCsv = useExport();
  const [openId, setOpenId] = useState<string | null>(null);
  const open = rows.find(m => m.id === openId);
  const withTickets = rows.filter(m => bucketTickets(m) + bagTickets(m) > 0).length;
  const withContainers = rows.filter(m => m.heldBuckets + m.heldBags > 0).length;
  const filtered = !!(memberQuery.trim() || memberFilter.status || memberFilter.water);
  const filter = (key: keyof MemberFilter, value: string) => setMemberFilter({ ...memberFilter, [key]: value || undefined });
  // The list can shrink under the current page (e.g. a member was disabled while filtering for 正常).
  useEffect(() => {
    if (loaded && memberPage > 1 && rows.length === 0) setMemberPage(pageCount(memberTotal, MEMBER_PAGE_SIZE));
  }, [loaded, memberPage, rows.length, memberTotal, setMemberPage]);

  return <>
    <div className="page-head">
      <div><h2>会员管理</h2><p>集中查询会员四类水票、押金余额、实际持有桶袋、收货地址与历史变动流水</p></div>
      <div className="head-actions">
        <button type="button" className="btn" onClick={() => ops.issueCoupon()}>发放优惠券</button>
        <button type="button" className="btn primary" onClick={() => ops.newMember()}><Icon name="plus" />新建会员</button>
      </div>
    </div>
    <div className="summary-strip">
      <div className="summary-item"><small>会员总数</small><b>{overview?.memberCount ?? (filtered ? '—' : memberTotal)}</b></div>
      <div className="summary-item"><small>本月新增</small><b>{overview?.newMembersMonth ?? '—'}</b></div>
      <div className="summary-item"><small>持有水票会员</small><b>{overview?.membersWithTickets ?? withTickets}</b></div>
      <div className="summary-item"><small>持有容器会员</small><b>{overview?.membersWithContainers ?? withContainers}</b></div>
    </div>
    <div className="filter-card">
      <label className="field-search"><Icon name="search" /><input placeholder="搜索姓名、手机号或会员编号" aria-label="搜索会员" value={memberQuery} onChange={e => setMemberQuery(e.target.value)} /></label>
      <select className="select" aria-label="水品偏好" value={memberFilter.water ?? ''} onChange={e => filter('water', e.target.value)}>
        <option value="">全部水品偏好</option><option value="BUCKET">15L 桶装水</option><option value="BAG">5L 袋装水</option>
      </select>
      <select className="select" aria-label="会员状态" value={memberFilter.status ?? ''} onChange={e => filter('status', e.target.value)}>
        <option value="">全部状态</option><option value="ACTIVE">正常</option><option value="DISABLED">已停用</option>
      </select>
      <div className="filter-spacer" />
      <button type="button" className="btn" onClick={() => exportCsv('members')}><Icon name="export" />导出会员</button>
    </div>
    <div className="table-card">
      <div className="table-toolbar"><div><b>会员列表</b><small>{filtered ? `符合条件 ${memberTotal} 位会员` : `共 ${memberTotal} 位会员`} · 可按姓名、手机号或会员编号搜索</small></div></div>
      <div style={{ overflowX: 'auto' }}>
        <table>
          <thead><tr><th>会员</th><th>联系电话</th><th>默认收货地址</th><th>自提/配送桶票</th><th>自提/配送袋票</th><th>押金余额</th><th>持有桶 / 袋</th><th>建档时间</th><th>操作</th></tr></thead>
          <tbody>
            {rows.length === 0 ? <EmptyRow colSpan={9}>{loaded ? '没有符合条件的会员' : '正在加载会员…'}</EmptyRow> : rows.map((m, i) => {
              const reserved = m.reservedBucketDeliveryTickets + m.reservedBucketPickupTickets;
              return (
                <tr key={m.id}>
                  <td><div className="member-cell"><div className="member-avatar" style={PALETTE[i % PALETTE.length]}>{m.name[0]}</div><div><b>{m.name}</b><small>{m.memberNo}</small></div></div></td>
                  <td>{m.phone}</td>
                  <td style={{ whiteSpace: 'normal', minWidth: 180, maxWidth: 260 }}>{m.defaultAddress || <span style={{ color: 'var(--muted)' }}>未设置</span>}</td>
                  <td><b>{m.bucketPickupTickets}</b> / <b>{m.bucketDeliveryTickets}</b> 桶{reserved > 0 && <> <span className="tag orange">预占 {reserved}</span></>}</td>
                  <td><b>{m.bagPickupTickets}</b> / <b>{m.bagDeliveryTickets}</b> 袋</td>
                  <td>¥ {money(m.depositAmount)}</td>
                  <td>{m.heldBuckets} 桶 / {m.heldBags} 袋</td>
                  <td>{(m.createdAt || '').slice(0, 10) || '—'}</td>
                  <td><button type="button" className="link" onClick={() => { setOpenId(m.id); setSelectedMemberId(m.id); }}>360° 详情</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="table-footer"><span>共 {memberTotal} 条记录 · 每页 {MEMBER_PAGE_SIZE} 条</span><Pager page={memberPage} total={memberTotal} pageSize={MEMBER_PAGE_SIZE} onChange={setMemberPage} /></div>
    </div>
    {open && <MemberDrawer member={open} onClose={() => setOpenId(null)} />}
  </>;
}

function MemberDrawer({ member: m, onClose }: { member: MemberProfile; onClose: () => void }) {
  const { api, can } = useAuth();
  const dialogs = useDialogs();
  const ops = useOperations();
  const { version, refresh } = useAdminData();
  const [deposits, setDeposits] = useState<DepositSummaryRow[] | null>(null);
  const reports = can(P.ReportExport);
  const recharges = useLoader(() => reports ? api.rechargeLedger({ q: m.memberNo, pageSize: 5 }) : Promise.resolve(null), [api, reports, m.memberNo, version]);

  useEffect(() => {
    let alive = true;
    setDeposits(null);
    api.depositSummary(m.id).then(rows => { if (alive) setDeposits(rows); }).catch(() => undefined);
    return () => { alive = false; };
  }, [api, m.id, m.depositAmount, m.heldBags, m.heldBuckets]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('dialog[open]')) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const recent = recharges.data?.rows.filter(r => r.memberNo === m.memberNo) ?? [];
  const refundable = deposits ? deposits.reduce((sum, r) => sum + Number(r.refundableAmount), 0) : null;
  return (
    <div className="drawer-mask open" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="drawer" role="dialog" aria-modal="true" aria-label="会员 360° 档案">
        <div className="drawer-head"><h3>会员 360° 档案</h3><button type="button" className="modal-close" aria-label="关闭" onClick={onClose}><Icon name="close" /></button></div>
        <div className="drawer-body">
          <div className="member-profile">
            <div className="avatar">{m.name[0]}</div>
            <div><h2>{m.name}</h2><p>{m.memberNo} · 麒麟会员 · {(m.createdAt || '').slice(0, 10) || '档案'}</p></div>
            <span className={`tag ${m.status === 'ACTIVE' ? 'green' : 'gray'}`} style={{ marginLeft: 'auto' }}>{m.status === 'ACTIVE' ? '正常' : '停用'}</span>
          </div>
          <div className="profile-stats">
            <div><b>{bucketTickets(m)}</b><small>桶装水票</small></div>
            <div><b>{bagTickets(m)}</b><small>袋装水票</small></div>
            <div><b>¥{Number(m.depositAmount).toFixed(0)}</b><small>押金余额</small></div>
            <div><b>{m.heldBuckets} / {m.heldBags}</b><small>持有桶/袋</small></div>
          </div>
          <div className="drawer-actions">
            <button type="button" className="btn primary" onClick={() => ops.recharge(m.id)}>水费充值</button>
            <button type="button" className="btn" onClick={() => ops.deposit(m.id)}>押金收退</button>
            <button type="button" className="btn" onClick={() => ops.order(m.id)}>点单</button>
            <button type="button" className="btn" onClick={() => ops.movement(m.id)}>登记领还</button>
          </div>
          <div className="detail-card">
            <h4>基础资料</h4>
            <div className="detail-row"><span>联系电话</span><b>{m.phone}</b></div>
            <div className="detail-row"><span>默认收货地址</span><b style={{ textAlign: 'right', maxWidth: 260 }}>{m.defaultAddress || '未设置'}</b></div>
            <div className="detail-row"><span>会员卡号</span><b>{m.memberNo}</b></div>
            {m.remark && <div className="detail-row"><span>备注</span><b style={{ textAlign: 'right', maxWidth: 260, whiteSpace: 'pre-wrap' }}>{m.remark}</b></div>}
            <button type="button" className="btn sm" style={{ marginTop: 8 }} onClick={() => dialogs.open(close => <CredentialsDialog subjectType="MEMBER" id={m.id} onClose={close} />)}>设置登录账号</button>
          </div>
          <div className="detail-card">
            <AddressBook key={m.id} owner={m} onChanged={refresh} compact />
          </div>
          <div className="detail-card">
            <h4>四类水票与押金明细</h4>
            <div className="detail-row"><span>自提桶票 / 配送桶票</span><b>{m.bucketPickupTickets} 桶 / {m.bucketDeliveryTickets} 桶（预占 {m.reservedBucketDeliveryTickets + m.reservedBucketPickupTickets}）</b></div>
            <div className="detail-row"><span>自提袋票 / 配送袋票</span><b>{m.bagPickupTickets} 袋 / {m.bagDeliveryTickets} 袋（预占 {m.reservedBagPickupTickets + m.reservedBagDeliveryTickets}）</b></div>
            <div className="detail-row"><span>实际持有桶 / 袋</span><b>{m.heldBuckets} 桶 / {m.heldBags} 袋</b></div>
            <div className="detail-row"><span>在池押金 / 当前可退</span><b style={{ color: 'var(--brand-600)' }}>¥{money(m.depositAmount)} / {refundable === null ? '可退金额查询中' : `可退 ¥${money(refundable)}`}</b></div>
          </div>
          <div className="detail-card">
            <h4>最近充值流水</h4>
            {recent.length ? recent.map(r => <p key={r.rechargeNo} style={{ fontSize: 12.5, margin: '6px 0' }}>{r.planName} · 实收 ¥{money(r.paidAmount)} · 付费 {r.buyQty} + 赠票 {r.giftQty}</p>) : <p className="membership-note">暂无充值记录</p>}
          </div>
          <button type="button" className="btn primary block" onClick={() => ops.assets(m)}>水票批次 / 优惠券 / 退款</button>
        </div>
      </div>
    </div>
  );
}
