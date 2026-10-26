import React, { useEffect, useState } from 'react';
import {
  AuthSession,
  KUNLUN_BRAND,
  KunlunApiClient,
  MemberProfile,
  WaterOrder,
} from '@kunlun/shared';

const api = new KunlunApiClient(
  import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:5180'
);

export function App() {
  const [appMode, setAppMode] = useState<'MEMBER' | 'STAFF'>('MEMBER');
  const [session, setSession] = useState<AuthSession | null>(null);
  const [profile, setProfile] = useState<MemberProfile | null>(null);
  const [orders, setOrders] = useState<WaterOrder[]>([]);
  const [toast, setToast] = useState<{ text: string; err?: boolean } | null>(null);

  // Member ordering inputs
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [orderQty, setOrderQty] = useState(1);

  // Staff verification inputs
  const [pickupCode, setPickupCode] = useState('');
  const [actualQty, setActualQty] = useState(1);
  const [fullOutN, setFullOutN] = useState(1);
  const [emptyInM, setEmptyInM] = useState(1);
  const [diffReason, setDiffReason] = useState('');

  const notify = (text: string, err = false) => {
    setToast({ text, err });
    setTimeout(() => setToast(null), 4500);
  };

  const loginAsMember = async () => {
    try {
      const s = await api.memberLogin(account, password);
      setSession(s);
      setAppMode('MEMBER');
      const [p, ordList] = await Promise.all([
        api.getMemberProfile(s.subjectId),
        api.listOrders({ memberId: s.subjectId }),
      ]);
      setProfile(p);
      setOrders(ordList);
      notify(`登录成功：已绑定会员 ${p.name} (${p.memberNo})`);
    } catch (e: any) {
      notify(e.message, true);
    }
  };

  const loginAsStaff = async () => {
    try {
      const s = await api.staffLogin(account, password);
      setSession(s);
      setAppMode('STAFF');
      const ordList = await api.listOrders();
      setOrders(ordList);
      notify(`员工小程序登录成功：${s.displayName} (${s.role})`);
    } catch (e: any) {
      notify(e.message, true);
    }
  };

  const refreshData = async () => {
    if (!session) return;
    if (session.subjectType === 'MEMBER') {
      const [p, ordList] = await Promise.all([
        api.getMemberProfile(session.subjectId),
        api.listOrders({ memberId: session.subjectId }),
      ]);
      setProfile(p);
      setOrders(ordList);
    } else {
      const ordList = await api.listOrders();
      setOrders(ordList);
    }
  };

  if (!session) return <form onSubmit={e => { e.preventDefault(); appMode === 'MEMBER' ? loginAsMember() : loginAsStaff(); }}>
    <h1>绿麒麟水站登录</h1><select value={appMode} onChange={e => setAppMode(e.target.value as 'MEMBER' | 'STAFF')}><option value="MEMBER">会员</option><option value="STAFF">员工</option></select>
    <label>用户名<input autoComplete="username" required value={account} onChange={e => setAccount(e.target.value)} /></label>
    <label>密码<input type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} /></label>
    {toast && <p role="alert">{toast.text}</p>}<button type="submit">登录</button></form>;

  return (
    <div className="stage">
      <div className="mode-bar">
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--brand-primary-dark)' }}>
          {KUNLUN_BRAND.signage} · 微信小程序实库联调
        </span>
        <button onClick={() => { api.setToken(null); setSession(null); setPassword(''); }}>退出登录</button>
      </div>

      <div className="phone-frame">
        <div className="wx-header">
          <div>
            <div className="wx-title">
              {appMode === 'MEMBER' ? '绿麒麟水站 · 会员中心' : '绿麒麟水站 · 员工工作台'}
            </div>
            <div style={{ fontSize: 11, opacity: 0.9 }}>{KUNLUN_BRAND.slogan}</div>
          </div>
          <div className="wx-capsule">
            <span>•••</span>
            <span style={{ opacity: 0.4 }}>|</span>
            <span>◎</span>
          </div>
        </div>

        <div className="phone-body">
          {toast && <div className={`mp-toast ${toast.err ? 'err' : ''}`}>{toast.text}</div>}

          {appMode === 'MEMBER' && profile && (
            <>
              <div className="mp-card" style={{ background: 'linear-gradient(135deg, #0b8f6a, #076c50)', color: '#fff' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontSize: 16, fontWeight: 700 }}>{profile.name}</div>
                    <div style={{ fontSize: 12, opacity: 0.85 }}>会员卡号：{profile.memberNo} · {profile.phone}</div>
                  </div>
                  <span style={{ fontSize: 11, background: 'rgba(255,255,255,0.2)', padding: '3px 8px', borderRadius: 999 }}>
                    已登录
                  </span>
                </div>
                <div style={{ marginTop: 10, fontSize: 12, opacity: 0.9 }}>
                  默认地址：{profile.defaultAddress || '门店自提'}
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10, paddingTop: 10, borderTop: '1px solid rgba(255,255,255,0.2)', fontSize: 12 }}>
                  <span>在用水桶：{profile.heldBuckets} 个</span>
                  <span>在用水袋：{profile.heldBags} 个</span>
                  <span>押金总额：¥{profile.depositAmount.toFixed(2)}</span>
                </div>
              </div>

              <div className="mp-card">
                <div style={{ fontSize: 14, fontWeight: 700 }}>我的 4 类专属水票余量 (实库实时)</div>
                <div className="ticket-grid">
                  <div className="ticket-box">
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>15L 桶装配送票</div>
                    <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--brand-primary-dark)' }}>
                      {profile.bucketDeliveryTickets} <span style={{ fontSize: 11 }}>张</span>
                    </div>
                    <div style={{ fontSize: 11, color: '#0369a1' }}>预占中：{profile.reservedBucketDeliveryTickets} 张</div>
                  </div>
                  <div className="ticket-box">
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>15L 桶装自提票</div>
                    <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--brand-primary-dark)' }}>
                      {profile.bucketPickupTickets} <span style={{ fontSize: 11 }}>张</span>
                    </div>
                    <div style={{ fontSize: 11, color: '#0369a1' }}>预占中：{profile.reservedBucketPickupTickets} 张</div>
                  </div>
                  <div className="ticket-box">
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>5L 袋装自提票</div>
                    <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--brand-primary-dark)' }}>
                      {profile.bagPickupTickets} <span style={{ fontSize: 11 }}>张</span>
                    </div>
                  </div>
                  <div className="ticket-box">
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>5L 袋装配送票</div>
                    <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--brand-primary-dark)' }}>
                      {profile.bagDeliveryTickets} <span style={{ fontSize: 11 }}>张</span>
                    </div>
                  </div>
                </div>
              </div>

              <div className="mp-card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: 14, fontWeight: 700 }}>一键预约送水 / 门店自提 (AC-04 防透支)</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 12 }}>预约数量：</span>
                  <input
                    className="mp-input"
                    type="number"
                    min={1}
                    style={{ width: 80 }}
                    value={orderQty}
                    onChange={(e) => setOrderQty(Number(e.target.value))}
                  />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <button
                    className="mp-btn"
                    onClick={async () => {
                      try {
                        const o = await api.createOrder({
                          memberId: profile.id,
                          waterType: 'BUCKET_18_9L',
                          fulfillMode: 'DELIVERY',
                          orderQty,
                          idempotencyKey: `mp-del-${Date.now()}`,
                        });
                        notify(`预约送水成功！单号 ${o.orderNo}`);
                        await refreshData();
                      } catch (e: any) {
                        notify(e.message, true);
                      }
                    }}
                  >
                    预约桶装送水上门
                  </button>
                  <button
                    className="mp-btn mp-btn-outline"
                    onClick={async () => {
                      try {
                        const o = await api.createOrder({
                          memberId: profile.id,
                          waterType: 'BUCKET_18_9L',
                          fulfillMode: 'PICKUP',
                          orderQty,
                          idempotencyKey: `mp-pkp-${Date.now()}`,
                        });
                        notify(`自提单已生成！6位核销码：${o.pickupCode}`);
                        await refreshData();
                      } catch (e: any) {
                        notify(e.message, true);
                      }
                    }}
                  >
                    生成门店 6 位自提码
                  </button>
                </div>
              </div>

              <div className="mp-card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: 14, fontWeight: 700 }}>我的订单与 6 位自提核销码 ({orders.length})</div>
                {orders.slice(0, 5).map((o) => (
                  <div
                    key={o.id}
                    style={{
                      padding: 10,
                      borderRadius: 10,
                      background: '#f8fcfb',
                      border: '1px solid var(--border-light)',
                      fontSize: 12,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4,
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 600 }}>
                      <span>{o.orderNo}</span>
                      <span style={{ color: 'var(--brand-primary)' }}>{o.status}</span>
                    </div>
                    <div>
                      {o.fulfillMode === 'PICKUP' ? '门店自提' : '送水上门'} · {o.orderQty} 桶
                      {o.pickupCode && (
                        <strong style={{ marginLeft: 8, color: '#0369a1' }}>
                          自提码: {o.pickupCode}
                        </strong>
                      )}
                    </div>
                    {o.status === 'PENDING' && (
                      <button
                        className="mp-btn mp-btn-outline"
                        style={{ padding: '5px 8px', fontSize: 11, marginTop: 4 }}
                        onClick={async () => {
                          try {
                            await api.cancelOrder(o.id, '会员小程序自主取消');
                            notify('订单已取消，预占水票已原路退回 (AC-06)');
                            await refreshData();
                          } catch (e: any) {
                            notify(e.message, true);
                          }
                        }}
                      >
                        取消订单并释放预占水票
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}

          {appMode === 'STAFF' && session && (
            <>
              <div className="mp-card" style={{ background: '#0b3b2f', color: '#fff' }}>
                <div style={{ fontSize: 15, fontWeight: 700 }}>
                  {session.displayName} ({session.codeOrNo})
                </div>
                <div style={{ fontSize: 12, color: '#9ce6cd', marginTop: 2 }}>
                  当前岗位：{session.role} · 已授权 {session.permissions.length} 项权限
                </div>
              </div>

              <div className="mp-card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: 14, fontWeight: 700 }}>6 位自提码快速核销 (AC-07 / AC-14)</div>
                <input
                  className="mp-input"
                  placeholder="输入客户出示的 6 位自提码"
                  value={pickupCode}
                  onChange={(e) => setPickupCode(e.target.value)}
                />
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
                  <div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>实提数量</div>
                    <input className="mp-input" type="number" value={actualQty} onChange={(e) => setActualQty(Number(e.target.value))} />
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>发出重桶 N</div>
                    <input className="mp-input" type="number" value={fullOutN} onChange={(e) => setFullOutN(Number(e.target.value))} />
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>收回空桶 M</div>
                    <input className="mp-input" type="number" value={emptyInM} onChange={(e) => setEmptyInM(Number(e.target.value))} />
                  </div>
                </div>
                <input
                  className="mp-input"
                  placeholder="若实提与下单数不一致，必填差异原因 (AC-14)"
                  value={diffReason}
                  onChange={(e) => setDiffReason(e.target.value)}
                />
                <button
                  className="mp-btn"
                  onClick={async () => {
                    try {
                      const res = await api.verifyPickupCode({
                        pickupCode: pickupCode.trim(),
                        actualQty,
                        fullOutN,
                        emptyInM,
                        diffReason: diffReason || undefined,
                      });
                      notify(`核销成功！单号 ${res.orderNo}，会员当前占桶 ${res.heldAfter}`);
                      await refreshData();
                    } catch (e: any) {
                      notify(e.message, true);
                    }
                  }}
                >
                  确认核销并登记容器 N/M
                </button>
              </div>

              <div className="mp-card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: 14, fontWeight: 700 }}>待履约配送 / 自提队列 (AC-08 等量换桶)</div>
                {orders.filter((o) => o.status === 'PENDING').map((o) => (
                  <div
                    key={o.id}
                    style={{
                      padding: 10,
                      borderRadius: 10,
                      background: '#f8fcfb',
                      border: '1px solid var(--border-light)',
                      fontSize: 12,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 6,
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 600 }}>
                      <span>{o.orderNo}</span>
                      <span>{o.fulfillMode === 'PICKUP' ? `自提码: ${o.pickupCode}` : '送水上门'}</span>
                    </div>
                    <div>
                      客户：{o.addressSnapshot.contactName} ({o.addressSnapshot.contactPhone}) · {o.orderQty} 桶
                    </div>
                    <div style={{ color: 'var(--text-muted)' }}>地址：{o.addressSnapshot.address}</div>
                    <button
                      className="mp-btn"
                      style={{ padding: '6px 10px', fontSize: 12 }}
                      onClick={async () => {
                        try {
                          await api.fulfillOrder(o.id, {
                            actualQty: o.orderQty,
                            fullOutN: o.orderQty,
                            emptyInM: o.orderQty,
                          });
                          notify(`订单 ${o.orderNo} 已按等量换桶 (N=${o.orderQty}, M=${o.orderQty}) 签收完成！`);
                          await refreshData();
                        } catch (e: any) {
                          notify(e.message, true);
                        }
                      }}
                    >
                      等量换桶一键签收 (N={o.orderQty} / M={o.orderQty})
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
