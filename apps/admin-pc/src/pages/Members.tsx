import { useEffect, useLayoutEffect, useRef } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { KUNLUN_PERMISSIONS as P, money, pageCount, ticketGroups, type MemberTicket } from '@kunlun/shared';
import { Icon, ResetMemberPasswordDialog, useDialogs, useAuth } from '@kunlun/ui';
import { EmptyRow, Pager, useExport, useOperations } from '../common';
import { MEMBER_PAGE_SIZE, useAdminData, type MemberFilter } from '../data';
import { useMemberStatusActions } from '../memberStatus';
import { MemberProfilePage } from './MemberProfile';

const PALETTE = [
  undefined,
  { background: 'var(--aqua-50)', color: 'var(--aqua-600)' },
  { background: 'var(--gold-50)', color: 'var(--gold-600)' },
  { background: 'var(--violet-50)', color: 'var(--violet-500)' },
  { background: 'var(--orange-50)', color: 'var(--orange-500)' },
];

/** Each water product on its own line: 自提 / 配送 balances, plus tickets held by open orders. */
function TicketCell({ tickets }: { tickets: MemberTicket[] }) {
  const groups = ticketGroups(tickets);
  if (!groups.length) return <span style={{ color: 'var(--muted)' }}>暂无水票</span>;
  return <>{groups.map(g => (
    <div key={g.waterType} className="ticket-line"><small>{g.name}</small><b>{g.pickup}</b> / <b>{g.delivery}</b> {g.unit}{g.reserved > 0 && <> <span className="tag orange">预占 {g.reserved}</span></>}</div>
  ))}</>;
}

const scroller = () => document.querySelector<HTMLElement>('.main-wrap');

/**
 * 会员管理：会员列表，或 `?id=` 指定会员的 360° 档案整页。档案页放在查询参数里，浏览器前进后退、刷新都停在原处；
 * 回到列表时保留原来的搜索、筛选、页码和滚动位置。
 */
export function Members() {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const openId = params.get('id');
  const listScroll = useRef(0);
  useLayoutEffect(() => { scroller()?.scrollTo(0, openId ? 0 : listScroll.current); }, [openId]);
  const open = (id: string) => {
    listScroll.current = scroller()?.scrollTop ?? 0;
    setParams({ id }, { state: { fromList: true } });
  };
  // Opened from the list: step back so the browser history stays list → profile; opened by link: replace it with the list.
  const back = () => (location.state as { fromList?: boolean } | null)?.fromList ? navigate(-1) : setParams({}, { replace: true });
  return openId ? <MemberProfilePage memberId={openId} onBack={back} /> : <MemberList onOpen={open} />;
}

function MemberList({ onOpen }: { onOpen: (id: string) => void }) {
  const { members: rows, memberTotal, loaded, overview, memberQuery, setMemberQuery, memberFilter, setMemberFilter, memberPage, setMemberPage } = useAdminData();
  const ops = useOperations();
  const exportCsv = useExport();
  const { can } = useAuth();
  const dialogs = useDialogs();
  // 停用 / 启用 and 删除 sit in each row's 操作 column for accounts with 「停用和删除会员」.
  const manage = can(P.MemberManage);
  const status = useMemberStatusActions();
  const withTickets = rows.filter(m => m.tickets.some(t => t.available > 0)).length;
  const withContainers = rows.filter(m => m.heldBuckets + m.heldBags > 0).length;
  const filtered = !!(memberQuery.trim() || memberFilter.status || memberFilter.water);
  const filter = (key: keyof MemberFilter, value: string) => setMemberFilter({ ...memberFilter, [key]: value || undefined });
  // The list can shrink under the current page (e.g. a member was disabled while filtering for 正常).
  useEffect(() => {
    if (loaded && memberPage > 1 && rows.length === 0) setMemberPage(pageCount(memberTotal, MEMBER_PAGE_SIZE));
  }, [loaded, memberPage, rows.length, memberTotal, setMemberPage]);

  return <>
    <div className="page-head">
      <div><h2>会员管理</h2><p>集中查询会员各水品水票、押金余额、实际持有桶袋、收货地址与历史变动流水</p></div>
      <div className="head-actions">
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
      <select className="select" aria-label="水票" value={memberFilter.water ?? ''} onChange={e => filter('water', e.target.value)}>
        <option value="">全部水票</option><option value="BUCKET">有桶装水票</option><option value="BAG">有袋装水票</option>
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
          <thead><tr><th>会员</th><th>联系电话</th><th>默认收货地址</th><th>水票（自提 / 配送）</th><th>押金余额</th><th>持有桶 / 袋</th><th>建档时间</th><th>操作</th></tr></thead>
          <tbody>
            {rows.length === 0 ? <EmptyRow colSpan={8}>{loaded ? '没有符合条件的会员' : '正在加载会员…'}</EmptyRow> : rows.map((m, i) => (
              <tr key={m.id}>
                <td><div className="member-cell"><div className="member-avatar" style={PALETTE[i % PALETTE.length]}>{m.name[0]}</div><div><b>{m.name}</b>{m.status === 'DISABLED' && <span className="tag gray" style={{ marginLeft: 6 }} title={m.disableReason ?? undefined}>已停用</span>}<small>{m.memberNo}</small></div></div></td>
                <td>{m.phone}</td>
                <td style={{ whiteSpace: 'normal', minWidth: 180, maxWidth: 260 }}>{m.defaultAddress || <span style={{ color: 'var(--muted)' }}>未设置</span>}</td>
                <td><TicketCell tickets={m.tickets} /></td>
                <td>¥ {money(m.depositAmount)}</td>
                <td>{m.heldBuckets} 桶 / {m.heldBags} 袋</td>
                <td>{(m.createdAt || '').slice(0, 10) || '—'}</td>
                <td className="row-actions">
                  <button type="button" className="link" onClick={() => onOpen(m.id)}>360° 档案</button>
                  {m.status === 'ACTIVE' && can(P.MemberWrite) && <button type="button" className="link" aria-label={`重置密码 ${m.name}`}
                    onClick={() => void dialogs.open(close => <ResetMemberPasswordDialog member={m} onClose={close} />)}>重置密码</button>}
                  {manage && (m.status === 'DISABLED'
                    ? <button type="button" className="link" aria-label={`重新启用会员 ${m.name}`} onClick={() => status.enable(m)}>启用</button>
                    : <button type="button" className="link" aria-label={`停用会员 ${m.name}`} title="不再来的会员：停用后办不了业务，会员端也登录不了，记录和余额都留着" onClick={() => status.disable(m)}>停用</button>)}
                  {manage && <button type="button" className="link danger" aria-label={`删除会员 ${m.name}`} title="只能删除一条记录都没有的会员，比如建错了的档案" onClick={() => status.remove(m)}>删除</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="table-footer"><span>共 {memberTotal} 条记录 · 每页 {MEMBER_PAGE_SIZE} 条</span><Pager page={memberPage} total={memberTotal} pageSize={MEMBER_PAGE_SIZE} onChange={setMemberPage} /></div>
    </div>
  </>;
}
