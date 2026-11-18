import { KUNLUN_PERMISSIONS as P, containerLabel, money, shortDateTime, type MemberProfile, type OpeningEntry, type OpeningItem } from '@kunlun/shared';
import { OpeningDialog, useAuth, useDialogs, useLoader, useRun } from '@kunlun/ui';
import { useAdminData } from './data';

/** What one opening item changed, in plain words. */
export function describeOpeningItem(item: OpeningItem) {
  switch (item.kind) {
    case 'CARD_DATE': return `开卡日期 ${item.before ?? '未补录'} → ${item.after ?? '未补录'}`;
    case 'TICKETS':
      return item.action === 'CREATE' ? `补录「${item.name}」，还剩 ${item.after}${item.unit}`
        : item.action === 'REMOVE' ? `删除「${item.name}」（原来还剩 ${item.before}${item.unit}）`
        : `「${item.name}」还剩 ${item.before} → ${item.after}${item.unit}`;
    case 'DEPOSIT_TOTAL': return `上系统前押金 ¥${money(item.before)} → ¥${money(item.after)}`;
    case 'DEPOSIT': {
      const amount = (a: { quantity: number; amount: number }) => `${a.quantity} 个，共 ¥${money(a.amount)}`;
      return item.action === 'CREATE' ? `${containerLabel(item.containerType)}上系统前的押金 ${amount(item.after!)}`
        : item.action === 'REMOVE' ? `删除${containerLabel(item.containerType)}上系统前的押金（${amount(item.before!)}）`
        : `${containerLabel(item.containerType)}上系统前的押金 ${amount(item.before!)} → ${amount(item.after!)}`;
    }
    default:
      return `${containerLabel(item.containerType)}手里 ${item.before} → ${item.after} 个`;
  }
}

/**
 * 会员档案里的「上系统前的数据」：历次补录（谁、什么时候、改了什么），有权限的可以继续补录或修改。
 * 补录的套餐余量、押金和桶袋本身照常显示在水票批次和押金卡片里。
 */
export function OpeningCard({ member }: { member: MemberProfile }) {
  const { api, can } = useAuth();
  const { version, refresh } = useAdminData();
  const dialogs = useDialogs();
  const run = useRun();
  const record = useLoader(() => api.memberOpening(member.id), [api, member.id, version]);
  const entries: OpeningEntry[] = record.data?.entries ?? [];
  const canRecord = can(P.MemberOpening);
  if (!canRecord && record.data && !entries.length) return null;
  const open = run(() => dialogs.open(close => <OpeningDialog member={member} onClose={close} onDone={refresh} />));
  return (
    <section className="card">
      <div className="card-head">
        <div className="card-title">上系统前的数据 <small>老会员用系统之前的套餐、押金和桶</small></div>
        {canRecord && <button type="button" className="text-btn" onClick={() => open()}>{entries.length ? '补录 / 修改' : '去补录'}</button>}
      </div>
      <div className="profile-card-body">
        {record.error ? <p className="account-error" role="alert">{record.error}</p>
          : !record.data ? <p className="membership-note">正在读取补录记录…</p>
          : !entries.length ? <p className="membership-note">还没有补录过。老会员第一次来时，把之前买的套餐还剩多少、交过的押金和手里的桶补录进来，之后的点单和退款就都对得上。</p>
          : <ol className="opening-entries">{entries.map(e => (
            <li key={e.id}>
              <div className="opening-entry-head"><b>{shortDateTime(e.createdAt)}</b><small>{e.operatorName} · {e.entryNo}</small></div>
              <ul>{e.items.map((item, i) => <li key={i}>{describeOpeningItem(item)}</li>)}</ul>
              {e.note && <small className="opening-entry-note">备注：{e.note}</small>}
            </li>
          ))}</ol>}
      </div>
    </section>
  );
}
