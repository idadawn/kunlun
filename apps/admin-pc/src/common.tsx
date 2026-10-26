import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { pageCount, pageWindow, pathFor, stationDay, type DateFilter, type ExportDataset, type MemberProfile, type Paged, type WaterOrder } from '@kunlun/shared';
import {
  DepositDialog, FulfillDialog, IssueCouponDialog, MemberAssetsDialog, MovementDialog, NewMemberDialog, RechargeDialog, StaffOrderDialog,
  saveBlob, useApi, useDialogs, useLoader, useRun, useToast,
} from '@kunlun/ui';
import { useAdminData } from './data';

export const PAGE_NAMES: Record<string, string> = {
  dashboard: '经营总览', members: '会员管理', orders: '水单管理', finance: '充值与押金', inventory: '袋桶库存', assets: '袋桶台账',
  products: '水品与押金', plans: '充值套餐', coupons: '优惠券', 'staff-accounts': '员工账号',
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
    deposit: (id = memberId) => run(() => dialogs.open(close => <DepositDialog containers={data.containers} memberId={id} onClose={close} onDone={refresh} />))(),
    order: (id = memberId) => run(() => dialogs.open(close => <StaffOrderDialog products={data.products} memberId={id} onClose={close} onDone={refresh} />))(),
    movement: (id = memberId) => run(() => dialogs.open(close => <MovementDialog memberId={id} onClose={close} onDone={refresh} />))(),
    fulfill: (order?: WaterOrder) => run(() => dialogs.open(close => <FulfillDialog order={order} onClose={close} onDone={refresh} />))(),
    assets: (member: Pick<MemberProfile, 'id' | 'name'>) => run(() => dialogs.open(close => <MemberAssetsDialog memberId={member.id} memberName={member.name} onClose={close} onDone={refresh} />))(),
    newMember: () => run(async () => {
      const created = await dialogs.open<{ id: string }>(close => <NewMemberDialog onClose={close} onDone={refresh} />);
      if (created) data.setSelectedMemberId(created.id);
    })(),
  };
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

export function EmptyRow({ colSpan, children }: { colSpan: number; children: string }) {
  return <tr><td colSpan={colSpan} style={{ textAlign: 'center', color: 'var(--muted)', padding: 26 }}>{children}</td></tr>;
}
