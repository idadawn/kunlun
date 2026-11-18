import { useState } from 'react';
import { expenseCategoryLabel, money, type OperatingPeriod, type OperatingReport } from '@kunlun/shared';
import { Icon, useAuth, useLoader } from '@kunlun/ui';
import { useAdminData } from '../data';
import { useGo } from '../common';

const periods: Record<OperatingPeriod, string> = {
  today: '当日', week: '本周', 'last-week': '上周', month: '本月', 'last-month': '上月', year: '本年', 'last-year': '上年',
};

type Metric = 'receipts' | 'water';
type MetricSelection = { metric: Metric; setMetric(metric: Metric): void };

const yuan = (amount: number) => amount.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function PeriodOverview() {
  const [metric, setMetric] = useState<Metric>('receipts');
  const [period, setPeriod] = useState<OperatingPeriod>('today');
  return <section aria-label="分时段经营统计">
    <div className="period-picker" role="group" aria-label="经营统计周期">
      {(Object.keys(periods) as OperatingPeriod[]).map(id =>
        <button key={id} type="button" aria-pressed={id === period} onClick={() => setPeriod(id)}>{periods[id]}</button>)}
    </div>
    <PeriodFigures key={period} period={period} metric={metric} setMetric={setMetric} />
  </section>;
}

function PeriodFigures({ period, metric, setMetric }: { period: OperatingPeriod } & MetricSelection) {
  const { api } = useAuth();
  const { version } = useAdminData();
  const { data, error, reload } = useLoader(() => api.operatingPeriod(period), [api, period, version]);
  const go = useGo();
  if (error) return <div role="alert" className="period-status">{error} <button type="button" className="text-btn" onClick={reload}>重新加载</button></div>;
  if (!data) return <div role="status" className="period-status">正在统计{periods[period]}经营情况…</div>;
  const { cash, start, end, activity } = data;
  const range = start === end ? start : `${start} 至 ${end}`;
  return <>
    <div className="period-dateline"><span><Icon name="clock" size="sm" />{range}</span>北京时间</div>
    <div className="cash-overview">
      <section className="cash-balance">
        <h3>{periods[period]}收支结余</h3>
        <strong><small>¥</small> {yuan(cash.balance)}</strong>
        <p>水费净收减去已登记费用，含会员预付水费。</p>
        <dl><div><dt>水费净收</dt><dd>¥ {yuan(cash.rechargeNet)}</dd></div><div><dt>费用支出</dt><dd>¥ {yuan(cash.expenseTotal)}</dd></div></dl>
      </section>
      <section className="card cash-breakdown">
        <div className="card-head"><h3 className="card-title">收支构成</h3><button type="button" className="text-btn" onClick={() => go('expenses')}>费用支出台账 ›</button></div>
        <dl>
          <div><dt>水费实收</dt><dd>¥ {yuan(cash.rechargeRevenue)}</dd></div>
          <div><dt>水费退款</dt><dd>¥ {yuan(cash.rechargeRefunded)}</dd></div>
          <div><dt>水费转押金</dt><dd>¥ {yuan(cash.transferred)}</dd></div>
          <div><dt>费用支出 <small>{cash.expenseCount} 笔</small></dt><dd>¥ {yuan(cash.expenseTotal)}</dd></div>
        </dl>
        {cash.categories.length > 0 && <p>{cash.categories.map(c => `${expenseCategoryLabel(c.category)} ¥${yuan(c.total)}`).join(' · ')}</p>}
      </section>
    </div>
    {activity && <Activity {...activity} grain={data.grain} metric={metric} setMetric={setMetric} />}
  </>;
}

function Activity({ trend, redeemedValue, grain, metric, setMetric }: NonNullable<OperatingReport['activity']> & { grain: OperatingReport['grain'] } & MetricSelection) {
  const totals = trend.reduce((sum, p) => ({
    buckets: sum.buckets + p.buckets, bags: sum.bags + p.bags, deliveries: sum.deliveries + p.deliveries,
    pickups: sum.pickups + p.pickups, newMembers: sum.newMembers + p.newMembers,
  }), { buckets: 0, bags: 0, deliveries: 0, pickups: 0, newMembers: 0 });
  const water = metric === 'water';
  const values = trend.map(p => water ? p.buckets + p.bags : p.receipts);
  const max = Math.max(0, ...values);
  const unit = water ? '件' : '元';
  const step = Math.max(1, Math.ceil(trend.length / 6));
  return <div className="activity-overview">
    <section className="card trend-card">
      <div className="card-head"><h3 className="card-title">经营趋势 <small>按{{ hour: '小时', day: '日', month: '月' }[grain]}</small></h3>
        <div className="metric-picker" role="group" aria-label="趋势指标">
          <button type="button" aria-pressed={!water} onClick={() => setMetric('receipts')}>水费实收</button>
          <button type="button" aria-pressed={water} onClick={() => setMetric('water')}>核销水量</button>
        </div>
      </div>
      {max === 0 ? <p className="trend-empty">该时段暂无{water ? '核销用水' : '水费收款'}记录</p> :
        <figure className={`period-plot${water ? ' water' : ''}`} aria-label={water ? '核销水量（件）' : '水费实收（元）'}>
          <div className="plot-scale" aria-hidden="true"><span>{max.toLocaleString('zh-CN')} {unit}</span><span>0</span></div>
          <div className="plot-bars">{trend.map((point, i) =>
            <div className="plot-column" key={point.label} tabIndex={0} aria-label={`${point.label}，${values[i]} ${unit}`}>
              <i style={{ height: `${100 * values[i] / max}%` }} />
              <span className="plot-tip" aria-hidden="true">{point.label} · {water ? values[i] : money(values[i])} {unit}</span>
              {(i % step === 0 && i < trend.length - Math.max(1, step / 2) || i === trend.length - 1) && <small>{point.label}</small>}
            </div>)}</div>
        </figure>}
    </section>
    <section className="card activity-totals">
      <div className="card-head"><h3 className="card-title">履约与会员</h3></div>
      <dl>
        <div><dt>已核销水费（折算）</dt><dd>¥ {yuan(redeemedValue)}</dd></div>
        <div><dt>已完成水单</dt><dd>{totals.deliveries + totals.pickups} <small>单</small></dd></div>
        <div><dt>配送 / 自提</dt><dd>{totals.deliveries} / {totals.pickups} <small>单</small></dd></div>
        <div><dt>实际核销水量</dt><dd>{totals.buckets} <small>桶</small> · {totals.bags} <small>袋</small></dd></div>
        <div><dt>新增会员</dt><dd>{totals.newMembers} <small>人</small></dd></div>
      </dl>
      <p className="redeemed-note">按已用付费票的套餐单价折算，赠票和无原价的历史票只计水量。</p>
    </section>
  </div>;
}
