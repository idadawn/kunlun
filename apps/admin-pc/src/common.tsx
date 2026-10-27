import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  KUNLUN_PERMISSIONS as P, pageCount, pageWindow, pathFor, stationDay,
  type DateFilter, type ExportDataset, type LedgerQuery, type MemberProfile, type Paged, type WaterOrder, type WaterProduct,
} from '@kunlun/shared';
import {
  CounterOrder, DepositDialog, Dialog, FulfillDialog, IssueCouponDialog, MemberAssetsDialog, MovementDialog, NewMemberDialog, RechargeDialog,
  Icon, saveBlob, useApi, useAuth, useDialogs, useLoader, useRun, useToast, type DepositAction, type IconName,
} from '@kunlun/ui';
import { useAdminData } from './data';

export const PAGE_NAMES: Record<string, string> = {
  dashboard: '经营总览', members: '会员管理', orders: '水单管理', recharges: '水费充值', deposits: '押金管理', refunds: '退款审核', inventory: '袋桶库存', assets: '袋桶台账',
  products: '水品与押金标准', plans: '充值套餐', coupons: '优惠券', 'staff-accounts': '员工账号',
};

export function useGo() {
  const navigate = useNavigate();
  return (page: string) => navigate(pathFor('admin', page));
}

export function useExport() {
  const api = useApi();
  const toast = useToast();
  const run = useRun();
  return (dataset: ExportDataset) => run(async () => {
    saveBlob(await api.exportCsv(dataset), `绿麒麟水站_导出_${stationDay()}.csv`);
    toast('报表已导出');
  })();
}

/**
 * Opens the shared staff-operation dialogs and refreshes afterwards. They preselect the member last opened in the
 * 360° drawer; staff can search for any other member inside the dialog.
 */
export function useOperations() {
  const data = useAdminData();
  const dialogs = useDialogs();
  const memberId = data.selectedMemberId ?? undefined;
  const { refresh } = data;
  const run = useRun();
  return {
    recharge: (id = memberId) => run(() => dialogs.open(close => <RechargeDialog memberId={id} onClose={close} onDone={refresh} />))(),
    issueCoupon: (id?: string, templateId?: string) => run(() => dialogs.open(close => <IssueCouponDialog memberId={id ?? memberId} templateId={templateId} onClose={close} onDone={refresh} />))(),
    deposit: (action?: DepositAction, id = memberId) => run(() => dialogs.open(close => <DepositDialog containers={data.containers} memberId={id} action={action} onClose={close} onDone={refresh} />))(),
    // Opened from a member row it starts with that customer; elsewhere it starts by finding the customer at the counter.
    order: (id?: string) => run(() => dialogs.open(close => <CounterOrderDialog products={data.products} memberId={id} onClose={close} onDone={refresh} />))(),
    movement: (id = memberId) => run(() => dialogs.open(close => <MovementDialog memberId={id} onClose={close} onDone={refresh} />))(),
    fulfill: (order?: WaterOrder) => run(() => dialogs.open(close => <FulfillDialog order={order} onClose={close} onDone={refresh} />))(),
    assets: (member: Pick<MemberProfile, 'id' | 'name'>) => run(() => dialogs.open(close => <MemberAssetsDialog memberId={member.id} memberName={member.name} onClose={close} onDone={refresh} />))(),
    newMember: () => run(async () => {
      const created = await dialogs.open<{ id: string }>(close => <NewMemberDialog onClose={close} onDone={refresh} />);
      if (created) data.setSelectedMemberId(created.id);
    })(),
  };
}

/** 门店点单：与员工 H5 共用同一份点单菜单，顾客在店自提即当场交付。 */
function CounterOrderDialog({ products, memberId: initial, onClose, onDone }: { products: WaterProduct[]; memberId?: string; onClose: () => void; onDone: () => Promise<void> }) {
  const dialogs = useDialogs();
  const [memberId, setMemberId] = useState(initial);
  const recharge = (member: MemberProfile) => dialogs.open(close => <RechargeDialog memberId={member.id} onClose={close} onDone={onDone} />);
  const createMember = async () => (await dialogs.open<{ id: string }>(close => <NewMemberDialog onClose={close} onDone={onDone} />))?.id;
  return (
    <Dialog title="门店点单" description="选好水品后选择到店取水或送水上门" className="counter-order-dialog" onClose={onClose}>
      <CounterOrder products={products} memberId={memberId} onMemberChange={setMemberId} onRecharge={recharge} onNewMember={createMember} onPlaced={onDone} />
    </Dialog>
  );
}

export const DATE_FILTERS: Array<[DateFilter, string]> = [['ALL', '全部时间'], ['TODAY', '今天'], ['WEEK', '近 7 天'], ['MONTH', '本月']];

export function DateFilterSelect({ value, onChange, label }: { value: DateFilter; onChange: (value: DateFilter) => void; label: string }) {
  return (
    <select className="select" aria-label={label} value={value} onChange={e => onChange(e.target.value as DateFilter)}>
      {DATE_FILTERS.map(([id, text]) => <option key={id} value={id}>{text}</option>)}
    </select>
  );
}

/** `value` once it has stopped changing for `delay` ms, so search boxes do not query on every keystroke. */
export function useDebounced<T>(value: T, delay = 250) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

export const PAGE_SIZE = 20;
export const emptyPage = <T,>(): Paged<T> => ({ rows: [], total: 0, page: 1, pageSize: PAGE_SIZE });

/**
 * One server-side page of a table: back to page 1 whenever `filters` change, reloaded after every console
 * refresh, and moved to the last page when the current one empties (its last rows left the filter).
 */
export function usePagedTable<T>(load: (page: number) => Promise<Paged<T>>, filters: unknown[]) {
  const { version } = useAdminData();
  const key = JSON.stringify(filters);
  const [current, setCurrent] = useState({ key, page: 1 });
  const page = current.key === key ? current.page : 1;
  const setPage = useCallback((next: number) => setCurrent({ key, page: next }), [key]);
  const table = useLoader(() => load(page), [key, page, version]);
  const { data } = table;
  useEffect(() => {
    if (data && data.page === page && page > 1 && data.rows.length === 0) setPage(pageCount(data.total, data.pageSize));
  }, [data, page, setPage]);
  return { ...table, page, setPage, total: data?.total ?? 0 };
}

export function Pager({ page, total, pageSize = PAGE_SIZE, onChange }: { page: number; total: number; pageSize?: number; onChange: (page: number) => void }) {
  const pages = pageCount(total, pageSize);
  if (pages <= 1) return <div className="pagination" />;
  return (
    <nav className="pagination" aria-label="分页">
      <button type="button" className="page-btn" aria-label="上一页" disabled={page <= 1} onClick={() => onChange(page - 1)}>‹</button>
      {pageWindow(page, pages).map((p, i) => p === null ? <span key={`gap-${i}`} className="page-gap">…</span> : (
        <button key={p} type="button" className={`page-btn${p === page ? ' active' : ''}`} aria-current={p === page ? 'page' : undefined} onClick={() => onChange(p)}>{p}</button>
      ))}
      <button type="button" className="page-btn" aria-label="下一页" disabled={page >= pages} onClick={() => onChange(page + 1)}>›</button>
    </nav>
  );
}

/** A finance ledger page; like the summary cards, it needs the report permission. */
export function useLedger<T, Q extends LedgerQuery>(load: (query: Q) => Promise<Paged<T>>, filter: Q) {
  const { can } = useAuth();
  const reports = can(P.ReportExport);
  return usePagedTable(page => reports ? load({ ...filter, page, pageSize: PAGE_SIZE }) : Promise.resolve(emptyPage<T>()), [filter, reports]);
}

/** Empty-table text: the load error, loading, nothing matching the filters, or `none` when nothing exists yet. */
export function ledgerEmptyText(table: { data: unknown; error: string }, filtered: boolean, none: string, kind: string) {
  return table.error || (!table.data ? '正在加载…' : filtered ? `没有符合条件的${kind}` : none);
}

export function StatCard({ label, icon, tone, value, foot }: { label: string; icon: IconName; tone?: 'blue' | 'orange' | 'gold'; value: ReactNode; foot: ReactNode }) {
  return (
    <div className="stat-card">
      <div className="stat-top"><span>{label}</span><span className={`stat-icon ${tone ?? ''}`.trim()}><Icon name={icon} /></span></div>
      <div className="stat-value">{value}</div>
      <div className="stat-foot">{foot}</div>
    </div>
  );
}

export function EmptyRow({ colSpan, children }: { colSpan: number; children: string }) {
  return <tr><td colSpan={colSpan} style={{ textAlign: 'center', color: 'var(--muted)', padding: 26 }}>{children}</td></tr>;
}
