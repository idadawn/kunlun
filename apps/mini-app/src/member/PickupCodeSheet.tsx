import { Sheet } from '../shared/H5Shell';

export function PickupCodeSheet({ orderNo, code, onClose }: { orderNo: string; code: string; onClose: () => void }) {
  return (
    <Sheet title="到店自提 · 取水凭证" onClose={onClose} footer={<button type="button" className="btn primary" onClick={onClose}>我知道了</button>}>
      <div className="qr-box">
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 4 }}>请向绿麒麟水站店员出示此取水码</div>
        <div className="qr-code">{code}</div>
        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>关联水单：{orderNo}</div>
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)', textAlign: 'center' }}>店员核验取水码并交付水品后，预占水票将自动核销</div>
    </Sheet>
  );
}
