import { useState } from 'react';
import { containerLabel, money, shortDateTime, type DepositSummaryRow } from '@kunlun/shared';
import { useApi } from '../auth';
import { useLoader } from '../hooks';

export function MemberDamageBreakdown({ counts }: { counts: DepositSummaryRow['damageBreakdown'] }) {
  if (!counts?.total) return null;
  return <div className="member-damage-breakdown" aria-label="破损处理明细">
    <span>已免赔 <b>{counts.waived} 个</b></span>
    <span>已赔付 <b>{counts.paid} 个</b></span>
    <span className={counts.pending > 0 ? 'outstanding' : undefined}>待处理 <b>{counts.pending} 个</b></span>
    {counts.returned > 0 && <span>已退回会员 <b>{counts.returned} 个</b></span>}
    {counts.awaitingReview > 0 && <span>免赔待审核 <b>{counts.awaitingReview} 个</b></span>}
    {counts.awaitingScrap > 0 && <span>待确认报废 <b>{counts.awaitingScrap} 个</b></span>}
    {counts.unverified > 0 && <span>历史待核实 <b>{counts.unverified} 个</b></span>}
  </div>;
}

export function MemberDamageReviews({ memberId, version }: { memberId: string; version?: number }) {
  const api = useApi();
  const [page, setPage] = useState(1);
  const history = useLoader(() => api.refundRequests({ memberId, kind: 'DAMAGE', page, pageSize: 5 }), [api, memberId, version, page]);
  const data = history.data?.page === page ? history.data : null;
  if (data?.total === 0 && !history.error) return null;
  return <section className="card damage-reviews" aria-label="破损免赔记录">
    <h3>破损免赔记录</h3>
    {history.error ? <p className="account-error" role="alert">{history.error}</p>
      : !data ? <p className="membership-note">正在读取审核记录…</p> : <>
        {data.rows.map(r => <article key={r.id}>
          <div><b>{containerLabel(r.containerType!)} × {r.quantity}</b>
            <strong>{r.status === 'PENDING' ? '待审核' : r.status === 'APPROVED' ? '已同意免赔' : '未同意免赔'}</strong></div>
          <p>{r.settlementNo ? `${r.settlementNo} · ${r.settlementCharged ? `已收 ¥${money(r.settlementAmount ?? 0)}` : '结算时免收'}` :
            r.damageStatus === 'RETURNED' ? '已计回持有数量，结算按持有桶袋处理' : r.status === 'APPROVED' ? '退款结算免收' : r.status === 'REJECTED' ? '退款时待处理' : '等待审核结果'}</p>
          <small>{shortDateTime(r.createdAt)} · {r.orderNo || r.movementNo || r.requestNo} · {r.reason}</small>
          {r.reviewedAt && <small>{shortDateTime(r.reviewedAt)} · {r.reviewerName}{r.reviewNote && ` · ${r.reviewNote}`}</small>}
        </article>)}
        {data.total > data.pageSize && <div className="membership-actions">
          <button className="btn sm" disabled={page === 1} onClick={() => setPage(page - 1)}>上一页</button>
          <span>{page} / {Math.ceil(data.total / data.pageSize)}</span>
          <button className="btn sm" disabled={page * data.pageSize >= data.total} onClick={() => setPage(page + 1)}>下一页</button>
        </div>}
      </>}
  </section>;
}
