import { useNavigate } from 'react-router-dom';
import { pathFor, stationDay, type DateFilter, type ExportDataset, type WaterOrder } from '@kunlun/shared';
import {
  DepositDialog, FulfillDialog, IssueCouponDialog, MemberAssetsDialog, MovementDialog, NewMemberDialog, RechargeDialog, StaffOrderDialog,
  saveBlob, useApi, useDialogs, useRun, useToast,
} from '@kunlun/ui';
import { useAdminData, useSelectedMemberId } from './data';

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

/** Opens the shared staff-operation dialogs with the console's current data and refreshes afterwards. */
export function useOperations() {
  const data = useAdminData();
  const dialogs = useDialogs();
  const memberId = useSelectedMemberId();
  const { members, refresh } = data;
  const run = useRun();
  return {
    recharge: (id = memberId) => run(() => dialogs.open(close => <RechargeDialog members={members} memberId={id} onClose={close} onDone={refresh} />))(),
    issueCoupon: (id?: string, templateId?: string) => run(() => dialogs.open(close => <IssueCouponDialog members={members} memberId={id ?? memberId} templateId={templateId} onClose={close} onDone={refresh} />))(),
    deposit: (id = memberId) => run(() => dialogs.open(close => <DepositDialog members={members} containers={data.containers} memberId={id} onClose={close} onDone={refresh} />))(),
    order: (id = memberId) => run(() => dialogs.open(close => <StaffOrderDialog members={members} products={data.products} memberId={id} onClose={close} onDone={refresh} />))(),
    movement: (id = memberId) => run(() => dialogs.open(close => <MovementDialog members={members} memberId={id} onClose={close} onDone={refresh} />))(),
    fulfill: (order?: WaterOrder) => run(() => dialogs.open(close => <FulfillDialog order={order} onClose={close} onDone={refresh} />))(),
    assets: (id: string) => run(() => dialogs.open(close => <MemberAssetsDialog memberId={id} members={members} onClose={close} onDone={refresh} />))(),
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

export const textMatch = (query: string, ...values: Array<string | number | null | undefined>) =>
  !query.trim() || values.join(' ').toLowerCase().includes(query.trim().toLowerCase());

export function EmptyRow({ colSpan, children }: { colSpan: number; children: string }) {
  return <tr><td colSpan={colSpan} style={{ textAlign: 'center', color: 'var(--muted)', padding: 26 }}>{children}</td></tr>;
}
