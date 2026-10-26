import React, { useEffect, useState } from 'react';
import {
  AuthSession,
  ContainerSummaryItem,
  FinanceSummaryReport,
  KUNLUN_BRAND,
  KUNLUN_PERMISSIONS,
  KunlunApiClient,
  MemberProfile,
  RechargePlan,
  WaterOrder,
  hasPermission,
} from '@kunlun/shared';

const api = new KunlunApiClient(
  import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:5180'
);

type TabKey = 'dashboard' | 'members' | 'orders' | 'containers' | 'plans' | 'exports';

export function App() {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [activeTab, setActiveTab] = useState<TabKey>('dashboard');
  const [toast, setToast] = useState<{ text: string; isError?: boolean } | null>(null);

  // Data states from k3s PostgreSQL
  const [finance, setFinance] = useState<FinanceSummaryReport | null>(null);
  const [containers, setContainers] = useState<ContainerSummaryItem[]>([]);
  const [members, setMembers] = useState<MemberProfile[]>([]);
  const [plans, setPlans] = useState<RechargePlan[]>([]);
  const [orders, setOrders] = useState<WaterOrder[]>([]);
  const [memberSearch, setMemberSearch] = useState('');

  // Form states
  const [newMemName, setNewMemName] = useState('');
  const [newMemPhone, setNewMemPhone] = useState('');
  const [newMemAddr, setNewMemAddr] = useState('');

  const [selectedMemberId, setSelectedMemberId] = useState('');
  const [selectedPlanId, setSelectedPlanId] = useState('');
  const [depositQty, setDepositQty] = useState(1);
  const [refundQty, setRefundQty] = useState(1);

  const [pickupCodeInput, setPickupCodeInput] = useState('');
  const [pickupActualQty, setPickupActualQty] = useState(1);
  const [pickupFullOut, setPickupFullOut] = useState(1);
  const [pickupEmptyIn, setPickupEmptyIn] = useState(1);
  const [pickupDiffReason, setPickupDiffReason] = useState('');

  const notify = (text: string, isError = false) => {
    setToast({ text, isError });
    setTimeout(() => setToast(null), 5000);
  };

  const refreshAll = async (sess: AuthSession | null = session) => {
    if (!sess) return;
    try {
      const [memList, planList, ordList, contList] = await Promise.all([
        api.listMembers(memberSearch),
        api.listPlans(),
        api.listOrders(),
        api.getContainerSummary(),
      ]);
      setMembers(memList);
      setPlans(planList);
      setOrders(ordList);
      setContainers(contList);
      if (!selectedMemberId && memList.length > 0) setSelectedMemberId(memList[0].id);
      if (!selectedPlanId && planList.length > 0) setSelectedPlanId(planList[0].id);

      if (hasPermission(sess, KUNLUN_PERMISSIONS.ReportExport)) {
        const fin = await api.getFinanceSummary();
        setFinance(fin);
      } else {
        setFinance(null);
      }
    } catch (e: any) {
      notify(e.message || '加载数据失败', true);
    }
  };

  const handleLogin = async (acc = account, pwd = password) => {
    try {
      const s = await api.staffLogin(acc, pwd, true);
      setSession(s);
      notify(`欢迎回来，${s.displayName}（${s.role}）！已连接 k3s PostgreSQL 实库`);
      await refreshAll(s);
    } catch (e: any) {
      notify(e.message || '登录失败', true);
    }
  };



  if (!session) {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
        <div className="card" style={{ width: 420, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <span className="badge badge-green">{KUNLUN_BRAND.signage}</span>
            <h2 style={{ marginTop: 8 }}>{KUNLUN_BRAND.system}</h2>
            <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>{KUNLUN_BRAND.slogan} · 管理端 PC 实库工作台</p>
          </div>
          {toast && <div className={`toast ${toast.isError ? 'toast-error' : ''}`}>{toast.text}</div>}
          <label style={{ fontSize: 13, fontWeight: 600 }}>用户名</label>
          <input className="input" value={account} onChange={(e) => setAccount(e.target.value)} />
          <label style={{ fontSize: 13, fontWeight: 600 }}>登录密码</label>
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <button className="btn" onClick={() => handleLogin()}>登录实库管理台</button>

        </div>
      </div>
    );
  }

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand-box">
          <div className="brand-title">{KUNLUN_BRAND.store} · 管理端</div>
          <div className="brand-sub">{KUNLUN_BRAND.product}</div>
          <div style={{ fontSize: 11, color: '#6ee7b7', marginTop: 6 }}>k3s PostgreSQL 16.14 在线</div>
        </div>

        <nav style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <button className={`nav-btn ${activeTab === 'dashboard' ? 'active' : ''}`} onClick={() => setActiveTab('dashboard')}>
            1. 经营总览与财务对账 (AC-17)
          </button>
          <button className={`nav-btn ${activeTab === 'members' ? 'active' : ''}`} onClick={() => setActiveTab('members')}>
            2. 会员建档与充值/押金 (M2)
          </button>
          <button className={`nav-btn ${activeTab === 'orders' ? 'active' : ''}`} onClick={() => setActiveTab('orders')}>
            3. 订水调度与自提核销 (M3)
          </button>
          <button className={`nav-btn ${activeTab === 'containers' ? 'active' : ''}`} onClick={() => setActiveTab('containers')}>
            4. 五维容器库存恒等式 (AC-20)
          </button>
          <button className={`nav-btn ${activeTab === 'plans' ? 'active' : ''}`} onClick={() => setActiveTab('plans')}>
            5. 水票套餐与快照策略 (AC-13)
          </button>
          <button className={`nav-btn ${activeTab === 'exports' ? 'active' : ''}`} onClick={() => setActiveTab('exports')}>
            6. 四大台账 CSV 导出 (AC-18)
          </button>
        </nav>

        <div style={{ marginTop: 'auto', fontSize: 12, color: '#a7f3d0', borderTop: '1px solid rgba(255,255,255,0.12)', paddingTop: 12 }}>
          <div>当前登录：{session.displayName} ({session.codeOrNo})</div>
          <div>角色：{session.role}（权限 {session.permissions.length} 项）</div>
          <button onClick={() => { api.setToken(null); setSession(null); setPassword(''); }}>退出登录</button>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div>
            <strong>{KUNLUN_BRAND.signage}</strong>
            <span style={{ marginLeft: 12, fontSize: 13, color: 'var(--text-muted)' }}>{KUNLUN_BRAND.slogan}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="badge badge-green">当前身份: {session.displayName} ({session.role})</span>
            <button className="btn btn-outline" onClick={() => refreshAll()}>刷新实库数据</button>
          </div>
        </header>

        <main className="content">
          {toast && <div className={`toast ${toast.isError ? 'toast-error' : ''}`}>{toast.text}</div>}

          {activeTab === 'dashboard' && (
            <>
              <div className="kpi-grid">
                <div className="card">
                  <div className="kpi-label">水票充值累计营收 (AC-03/17)</div>
                  <div className="kpi-val">¥{finance ? finance.rechargeRevenueTotal.toFixed(2) : '--'}</div>
                  <div className="kpi-foot">共 {finance?.rechargeOrderCount ?? '--'} 笔充值 · 售票 {finance?.ticketsSoldBuyQty ?? 0} + 赠票 {finance?.ticketsGiftedQty ?? 0}</div>
                </div>
                <div className="card">
                  <div className="kpi-label">未退押金池总额 (AC-11/17)</div>
                  <div className="kpi-val">¥{finance ? finance.unrefundedDepositPoolTotal.toFixed(2) : '--'}</div>
                  <div className="kpi-foot">收押 ¥{finance?.depositCollectedTotal.toFixed(2) ?? '--'} - 退押 ¥{finance?.depositRefundedTotal.toFixed(2) ?? '--'}</div>
                </div>
                <div className="card">
                  <div className="kpi-label">未退押金池零误差对账 (AC-17)</div>
                  <div className="kpi-val" style={{ color: finance?.reconciledZeroDiff ? 'var(--success)' : 'var(--warning)' }}>
                    {finance ? (finance.reconciledZeroDiff ? '100% 零误差对齐' : '存在差异') : '需站长权限 (AC-16)'}
                  </div>
                  <div className="kpi-foot">批次剩余汇总 == 押金收款 - 押金退款</div>
                </div>
                <div className="card">
                  <div className="kpi-label">累计完结送水/自提 (M3)</div>
                  <div className="kpi-val">{finance?.waterFulfilledTotalQty ?? orders.filter(o => o.status === 'COMPLETED').length} 桶/袋</div>
                  <div className="kpi-foot">已完成订单 {finance?.completedOrderCount ?? '--'} 单</div>
                </div>
              </div>

              <div className="grid-2">
                <div className="card">
                  <h3 style={{ marginBottom: 12 }}>五维容器资产实时监控 (AC-19/20)</h3>
                  <table>
                    <thead>
                      <tr>
                        <th>容器类型</th>
                        <th>单价押金</th>
                        <th>资产总量</th>
                        <th>在库可用</th>
                        <th>会员持有</th>
                        <th>恒等式校验</th>
                      </tr>
                    </thead>
                    <tbody>
                      {containers.map((c) => (
                        <tr key={c.containerType}>
                          <td><strong>{c.containerType === 'BUCKET' ? '18.9L PC水桶' : '7.5L 一次性/周转袋'}</strong></td>
                          <td>¥{c.unitDeposit.toFixed(2)}</td>
                          <td>{c.totalQty}</td>
                          <td>
                            {c.inStationQty}{' '}
                            {c.lowStockWarning && <span className="badge badge-amber">低于预警线 {c.warnThreshold}</span>}
                          </td>
                          <td>{c.memberHeldQty}</td>
                          <td>
                            <span className="badge badge-green">{c.identityValid ? '恒等通过' : '异常'}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="card">
                  <h3 style={{ marginBottom: 12 }}>最新用水订单动态</h3>
                  <table>
                    <thead>
                      <tr>
                        <th>单号</th>
                        <th>方式</th>
                        <th>数量</th>
                        <th>自提码</th>
                        <th>状态</th>
                      </tr>
                    </thead>
                    <tbody>
                      {orders.slice(0, 5).map((o) => (
                        <tr key={o.id}>
                          <td>{o.orderNo}</td>
                          <td>{o.fulfillMode === 'PICKUP' ? '门店自提' : '送水上门'}</td>
                          <td>{o.orderQty} (实发 {o.actualQty ?? '-'})</td>
                          <td><code>{o.pickupCode || '-'}</code></td>
                          <td>
                            <span className={`badge ${o.status === 'COMPLETED' ? 'badge-green' : 'badge-blue'}`}>{o.status}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}

          {activeTab === 'members' && (
            <>
              <div className="grid-2">
                <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <h3>快速新建会员档案 (AC-01)</h3>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1.5fr auto', gap: 8 }}>
                    <input className="input" placeholder="会员姓名" value={newMemName} onChange={(e) => setNewMemName(e.target.value)} />
                    <input className="input" placeholder="11位手机号" value={newMemPhone} onChange={(e) => setNewMemPhone(e.target.value)} />
                    <input className="input" placeholder="默认送水地址" value={newMemAddr} onChange={(e) => setNewMemAddr(e.target.value)} />
                    <button
                      className="btn"
                      onClick={async () => {
                        try {
                          const res = await api.createMember(newMemName, newMemPhone, newMemAddr);
                          notify(`会员创建成功：${res.name} (${res.memberNo})`);
                          setNewMemName('');
                          setNewMemPhone('');
                          setNewMemAddr('');
                          await refreshAll();
                          setSelectedMemberId(res.id);
                        } catch (e: any) {
                          notify(e.message, true);
                        }
                      }}
                    >
                      新建会员
                    </button>
                  </div>
                </div>

                <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <h3>水票套餐充值 & 独立押金收退 (AC-02/03/11/12)</h3>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <select className="select" value={selectedMemberId} onChange={(e) => setSelectedMemberId(e.target.value)}>
                      {members.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.memberNo} · {m.name} ({m.phone})
                        </option>
                      ))}
                    </select>
                    <select className="select" value={selectedPlanId} onChange={(e) => setSelectedPlanId(e.target.value)}>
                      {plans.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} (¥{p.price} · 购{p.buyQty}赠{p.giftQty})
                        </option>
                      ))}
                    </select>
                    <button
                      className="btn"
                      onClick={async () => {
                        try {
                          const r = await api.createRecharge(selectedMemberId, selectedPlanId, 'WECHAT', `pc-rcg-${Date.now()}`);
                          notify(`充值入账成功：单号 ${r.rechargeNo}，购 ${r.buyQty} + 赠 ${r.giftQty} = ${r.totalTickets} 张水票`);
                          await refreshAll();
                        } catch (e: any) {
                          notify(e.message, true);
                        }
                      }}
                    >
                      办理水票充值
                    </button>
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
                    <input className="input" type="number" min={1} style={{ width: 80 }} value={depositQty} onChange={(e) => setDepositQty(Number(e.target.value))} />
                    <button
                      className="btn btn-outline"
                      onClick={async () => {
                        try {
                          const d = await api.collectDeposit(selectedMemberId, 'BUCKET', depositQty, 'WECHAT', `pc-dep-${Date.now()}`);
                          notify(`收取水桶押金成功：${d.quantity} 桶 × ¥${d.unitPrice} = ¥${d.totalAmount}`);
                          await refreshAll();
                        } catch (e: any) {
                          notify(e.message, true);
                        }
                      }}
                    >
                      + 收取水桶押金
                    </button>
                    <input className="input" type="number" min={1} style={{ width: 80 }} value={refundQty} onChange={(e) => setRefundQty(Number(e.target.value))} />
                    <button
                      className="btn btn-danger"
                      onClick={async () => {
                        try {
                          const rf = await api.refundDeposit(selectedMemberId, 'BUCKET', refundQty, `pc-ref-${Date.now()}`);
                          notify(`按历史原单价退押成功：退还 ${rf.refundQty} 桶，共计 ¥${rf.refundAmount.toFixed(2)} (AC-12)`);
                          await refreshAll();
                        } catch (e: any) {
                          notify(e.message, true);
                        }
                      }}
                    >
                      - 原单价退水桶押金 (AC-11/12)
                    </button>
                  </div>
                </div>
              </div>

              <div className="card">
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
                  <h3>实库会员列表 ({members.length} 人)</h3>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input className="input" placeholder="搜卡号/姓名/手机号..." value={memberSearch} onChange={(e) => setMemberSearch(e.target.value)} />
                    <button className="btn btn-outline" onClick={() => refreshAll()}>搜索</button>
                  </div>
                </div>
                <table>
                  <thead>
                    <tr>
                      <th>会员卡号</th>
                      <th>姓名</th>
                      <th>手机号</th>
                      <th>桶装配送票 (预占)</th>
                      <th>桶装自提票 (预占)</th>
                      <th>袋装自提票</th>
                      <th>在用水桶</th>
                      <th>押金余额</th>
                      <th>默认地址</th>
                    </tr>
                  </thead>
                  <tbody>
                    {members.map((m) => (
                      <tr key={m.id}>
                        <td><strong>{m.memberNo}</strong></td>
                        <td>{m.name}</td>
                        <td>{m.phone}</td>
                        <td><strong>{m.bucketDeliveryTickets}</strong> ({m.reservedBucketDeliveryTickets})</td>
                        <td><strong>{m.bucketPickupTickets}</strong> ({m.reservedBucketPickupTickets})</td>
                        <td>{m.bagPickupTickets}</td>
                        <td>{m.heldBuckets} 桶</td>
                        <td>¥{m.depositAmount.toFixed(2)}</td>
                        <td>{m.defaultAddress}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {activeTab === 'orders' && (
            <>
              <div className="grid-2">
                <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <h3>门店 6 位自提码核销工作台 (AC-07 / AC-14)</h3>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 8 }}>
                    <input className="input" placeholder="6位自提码" value={pickupCodeInput} onChange={(e) => setPickupCodeInput(e.target.value)} />
                    <input className="input" type="number" placeholder="实提数" value={pickupActualQty} onChange={(e) => setPickupActualQty(Number(e.target.value))} />
                    <input className="input" type="number" placeholder="发出重桶N" value={pickupFullOut} onChange={(e) => setPickupFullOut(Number(e.target.value))} />
                    <input className="input" type="number" placeholder="收回空桶M" value={pickupEmptyIn} onChange={(e) => setPickupEmptyIn(Number(e.target.value))} />
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input className="input" style={{ flex: 1 }} placeholder="若实提数量与下单不一致，请填写差异原因 (AC-14)" value={pickupDiffReason} onChange={(e) => setPickupDiffReason(e.target.value)} />
                    <button
                      className="btn"
                      onClick={async () => {
                        try {
                          const res = await api.verifyPickupCode({
                            pickupCode: pickupCodeInput.trim(),
                            actualQty: pickupActualQty,
                            fullOutN: pickupFullOut,
                            emptyInM: pickupEmptyIn,
                            diffReason: pickupDiffReason || undefined,
                          });
                          notify(`自提核销成功！单号 ${res.orderNo}，实提 ${res.actualQty}，剩余可用票 ${res.availableTicketsAfter}`);
                          await refreshAll();
                        } catch (e: any) {
                          notify(e.message, true);
                        }
                      }}
                    >
                      立即核销自提码
                    </button>
                  </div>
                </div>

                <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <h3>代客快速建单 (预占水票 & 生成 6 位自提码)</h3>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <select className="select" value={selectedMemberId} onChange={(e) => setSelectedMemberId(e.target.value)}>
                      {members.map((m) => (
                        <option key={m.id} value={m.id}>{m.memberNo} · {m.name}</option>
                      ))}
                    </select>
                    <button
                      className="btn"
                      onClick={async () => {
                        try {
                          const o = await api.createOrder({
                            memberId: selectedMemberId,
                            waterType: 'BUCKET_18_9L',
                            fulfillMode: 'DELIVERY',
                            orderQty: 1,
                            idempotencyKey: `pc-ord-del-${Date.now()}`,
                          });
                          notify(`已创建 1 桶配送订单：${o.orderNo}（预占 1 张配送票）`);
                          await refreshAll();
                        } catch (e: any) {
                          notify(e.message, true);
                        }
                      }}
                    >
                      + 下单 1 桶上门配送
                    </button>
                    <button
                      className="btn btn-outline"
                      onClick={async () => {
                        try {
                          const o = await api.createOrder({
                            memberId: selectedMemberId,
                            waterType: 'BUCKET_18_9L',
                            fulfillMode: 'PICKUP',
                            orderQty: 2,
                            idempotencyKey: `pc-ord-pkp-${Date.now()}`,
                          });
                          setPickupCodeInput(o.pickupCode || '');
                          setPickupActualQty(2);
                          setPickupFullOut(2);
                          setPickupEmptyIn(2);
                          notify(`已创建 2 桶门店自提单：6位自提码 【${o.pickupCode}】`);
                          await refreshAll();
                        } catch (e: any) {
                          notify(e.message, true);
                        }
                      }}
                    >
                      + 下单 2 桶门店自提 (生成核销码)
                    </button>
                  </div>
                </div>
              </div>

              <div className="card">
                <h3 style={{ marginBottom: 12 }}>用水订单台账 (支持等量换桶签收 AC-08 / 取消退回预占 AC-06)</h3>
                <table>
                  <thead>
                    <tr>
                      <th>订单号</th>
                      <th>客户</th>
                      <th>水种 / 方式</th>
                      <th>下单/实发</th>
                      <th>容器 N出/M入</th>
                      <th>自提码</th>
                      <th>状态</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orders.map((o) => (
                      <tr key={o.id}>
                        <td><strong>{o.orderNo}</strong></td>
                        <td>{o.addressSnapshot.contactName} ({o.addressSnapshot.contactPhone})</td>
                        <td>{o.waterType} · {o.fulfillMode}</td>
                        <td>{o.orderQty} / {o.actualQty ?? '-'}</td>
                        <td>{o.fullOutQty ?? '-'} / {o.emptyInQty ?? '-'}</td>
                        <td><code>{o.pickupCode || '-'}</code></td>
                        <td><span className={`badge ${o.status === 'COMPLETED' ? 'badge-green' : 'badge-blue'}`}>{o.status}</span></td>
                        <td style={{ display: 'flex', gap: 6 }}>
                          {o.status === 'PENDING' && (
                            <>
                              <button
                                className="btn"
                                style={{ padding: '4px 10px', fontSize: 12 }}
                                onClick={async () => {
                                  try {
                                    await api.fulfillOrder(o.id, {
                                      actualQty: o.orderQty,
                                      fullOutN: o.orderQty,
                                      emptyInM: o.orderQty, // 等量换桶 N=M (AC-08)
                                    });
                                    notify(`订单 ${o.orderNo} 已按等量换桶 (N=${o.orderQty}, M=${o.orderQty}) 签收完成！`);
                                    await refreshAll();
                                  } catch (e: any) {
                                    notify(e.message, true);
                                  }
                                }}
                              >
                                等量换桶签收 (N=M)
                              </button>
                              <button
                                className="btn btn-danger"
                                style={{ padding: '4px 10px', fontSize: 12 }}
                                onClick={async () => {
                                  try {
                                    await api.cancelOrder(o.id, '后台调度取消并退回预占水票');
                                    notify(`订单 ${o.orderNo} 已取消，预占水票已原路释放 (AC-06)`);
                                    await refreshAll();
                                  } catch (e: any) {
                                    notify(e.message, true);
                                  }
                                }}
                              >
                                取消并释放水票
                              </button>
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {activeTab === 'containers' && (
            <div className="card">
              <h3 style={{ marginBottom: 12 }}>五维容器资产恒等式看板 (AC-19 / AC-20: 总量 = 在库 + 在途 + 会员持有 + 待检 + 异常)</h3>
              <table>
                <thead>
                  <tr>
                    <th>容器编码</th>
                    <th>标准押金单价</th>
                    <th>资产总量</th>
                    <th>在库可用</th>
                    <th>配送在途</th>
                    <th>会员持有</th>
                    <th>待清洗/待检</th>
                    <th>异常报损</th>
                    <th>恒等式校验</th>
                  </tr>
                </thead>
                <tbody>
                  {containers.map((c) => (
                    <tr key={c.containerType}>
                      <td><strong>{c.containerType}</strong></td>
                      <td>¥{c.unitDeposit.toFixed(2)}</td>
                      <td><strong>{c.totalQty}</strong></td>
                      <td>{c.inStationQty}</td>
                      <td>{c.inTransitQty}</td>
                      <td>{c.memberHeldQty}</td>
                      <td>{c.inspectingQty}</td>
                      <td>{c.abnormalQty}</td>
                      <td><span className="badge badge-green">{c.identityValid ? '总量恒等通过' : '不平衡'}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {activeTab === 'plans' && (
            <div className="card">
              <h3 style={{ marginBottom: 12 }}>水票充值套餐配置 (AC-02 同价不同领取方式享不同赠送 / AC-13 修改套餐不影响历史快照)</h3>
              <table>
                <thead>
                  <tr>
                    <th>套餐名称</th>
                    <th>适用水种</th>
                    <th>履约方式</th>
                    <th>套餐售价</th>
                    <th>购票张数</th>
                    <th>赠送张数</th>
                    <th>合计得票</th>
                    <th>状态</th>
                  </tr>
                </thead>
                <tbody>
                  {plans.map((p) => (
                    <tr key={p.id}>
                      <td><strong>{p.name}</strong></td>
                      <td>{p.waterType}</td>
                      <td>{p.fulfillMode === 'DELIVERY' ? '送水上门' : '门店自提'}</td>
                      <td>¥{p.price.toFixed(2)}</td>
                      <td>{p.buyQty} 张</td>
                      <td>+{p.giftQty} 张</td>
                      <td><strong>{p.buyQty + p.giftQty} 张</strong></td>
                      <td><span className="badge badge-green">{p.status}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {activeTab === 'exports' && (
            <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <h3>四大核心台账 UTF-8 CSV 导出 (AC-16 权限控制 / AC-18 口径一致)</h3>
              <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                仅拥有 <code>kunlun.waterstation:report:export</code> 权限的角色（如林站长 ADMIN）可导出；切换至“店员小林 (CLERK)”点击将触发服务端 403 权限拦截演示。
              </p>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                {(['members', 'ticket-ledgers', 'deposit-ledgers', 'orders'] as const).map((ds) => (
                  <button
                    key={ds}
                    className="btn"
                    onClick={async () => {
                      try {
                        const csv = await api.downloadExportCsv(ds);
                        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = `kunlun-${ds}.csv`;
                        a.click();
                        URL.revokeObjectURL(url);
                        notify(`成功从实库导出 ${ds}.csv（共 ${csv.split('\n').length - 1} 行）`);
                      } catch (e: any) {
                        notify(e.message, true);
                      }
                    }}
                  >
                    导出 {ds}.csv
                  </button>
                ))}
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
