import { useState } from 'react';
import { containerLabel, money, shortDateTime } from '@kunlun/shared';
import { useApi } from '../auth';
import { useLoader } from '../hooks';

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
            r.status === 'APPROVED' ? '退款结算免收' : r.status === 'REJECTED' ? '退款时待处理' : '等待审核结果'}</p>
          <small>{shortDateTime(r.createdAt)} · {r.orderNo || r.requestNo} · {r.reason}</small>
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
