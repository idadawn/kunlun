import { useCallback, useEffect, useState } from 'react';
import { PHONE_PATTERN, fullAddress, type MemberAddress } from '@kunlun/shared';
import { useApi } from './auth';
import { ConfirmDialog, FormDialog, useDialogs, useRun, useToast } from './feedback';
import { Icon } from './icons';

export const MAX_MEMBER_ADDRESSES = 20;

/** The member whose address book is being maintained; their name and phone pre-fill new contacts. */
export interface AddressOwner {
  id: string;
  name: string;
  phone: string;
}

/** Adds or edits one address. 联系人和手机号默认带出会员本人信息，可改为实际收货人。 */
export function AddressFormDialog({ owner, address, isFirst = false, onClose }: {
  owner: AddressOwner;
  address?: MemberAddress;
  isFirst?: boolean;
  onClose: (saved?: MemberAddress) => void;
}) {
  const api = useApi();
  const toast = useToast();
  const [location, setLocation] = useState(address?.location ?? '');
  const [doorNo, setDoorNo] = useState(address?.doorNo ?? '');
  const [contactName, setContactName] = useState(address?.contactName ?? owner.name);
  const [contactPhone, setContactPhone] = useState(address?.contactPhone ?? owner.phone);
  const [isDefault, setIsDefault] = useState(address?.isDefault ?? isFirst);
  // The current default can only be replaced by choosing another default, never unset in place.
  const defaultLocked = isFirst || !!address?.isDefault;
  const usesOwner = contactName === owner.name && contactPhone === owner.phone;
  const preview = fullAddress(location, doorNo);

  const save = async () => {
    const body = { location: location.trim(), doorNo: doorNo.trim(), contactName: contactName.trim(), contactPhone: contactPhone.trim(), isDefault };
    const saved = address ? await api.updateAddress(owner.id, address.id, body) : await api.createAddress(owner.id, body);
    toast(address ? '收货地址已更新' : '收货地址已添加');
    onClose(saved);
  };

  return (
    <FormDialog title={address ? '编辑收货地址' : '新增收货地址'} className="address-dialog" submitLabel="保存地址" onClose={() => onClose()} onSubmit={save}>
      <div className="address-form-grid">
        <div className="address-wide">
          <label htmlFor="addressLocation">收货地址</label>
          <input id="addressLocation" className="input" required maxLength={200} autoComplete="street-address" placeholder="小区 / 街道 / 楼栋，如：幸福里小区 3 栋" value={location} onChange={e => setLocation(e.target.value)} />
        </div>
        <div className="address-wide">
          <label htmlFor="addressDoorNo">门牌号</label>
          <input id="addressDoorNo" className="input" required maxLength={64} placeholder="单元、楼层及房号，如：2 单元 501 室" value={doorNo} onChange={e => setDoorNo(e.target.value)} />
        </div>
        <div>
          <label htmlFor="addressContact">联系人</label>
          <input id="addressContact" className="input" required maxLength={32} autoComplete="name" value={contactName} onChange={e => setContactName(e.target.value)} />
        </div>
        <div>
          <label htmlFor="addressPhone">手机号</label>
          <input id="addressPhone" className="input" type="tel" required pattern={PHONE_PATTERN} maxLength={11} inputMode="numeric" autoComplete="tel" value={contactPhone} onChange={e => setContactPhone(e.target.value)} />
        </div>
      </div>
      <p className="membership-note">
        {usesOwner ? `已默认带出会员本人「${owner.name} ${owner.phone}」，代收时可改为实际收货人。` : '已改为其他收货人，送水员将联系此号码。'}
        {!usesOwner && <> <button type="button" className="link" onClick={() => { setContactName(owner.name); setContactPhone(owner.phone); }}>恢复为会员本人</button></>}
      </p>
      <label className="address-default-check">
        <input type="checkbox" checked={isDefault} disabled={defaultLocked} onChange={e => setIsDefault(e.target.checked)} />
        设为默认收货地址{defaultLocked && (isFirst ? '（首个地址自动设为默认）' : '（当前默认地址）')}
      </label>
      {preview && <div className="membership-summary">送水地址预览：{preview}</div>}
    </FormDialog>
  );
}

function useAddresses(memberId: string) {
  const api = useApi();
  const [addresses, setAddresses] = useState<MemberAddress[] | null>(null);
  const [error, setError] = useState('');
  const reload = useCallback(async () => {
    try { setAddresses(await api.listAddresses(memberId)); setError(''); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [api, memberId]);
  useEffect(() => { setAddresses(null); void reload(); }, [reload]);
  return { addresses, error, reload };
}

function AddressText({ address }: { address: MemberAddress }) {
  return (
    <div className="address-card-text">
      {address.fullAddress}
      {!address.doorNo && <small>未填写门牌号，建议编辑补充，方便送水员上门</small>}
    </div>
  );
}

/**
 * Maintains a member's delivery addresses: add, edit, delete and choose the default.
 * `onChanged` runs after every change so callers can refresh the member's default address.
 */
export function AddressBook({ owner, onChanged, compact = false }: { owner: AddressOwner; onChanged?: () => void | Promise<void>; compact?: boolean }) {
  const api = useApi();
  const dialogs = useDialogs();
  const toast = useToast();
  const run = useRun();
  const { addresses, error, reload } = useAddresses(owner.id);
  const changed = async () => { await reload(); await onChanged?.(); };

  const edit = run(async (address?: MemberAddress) => {
    const saved = await dialogs.open<MemberAddress>(close => <AddressFormDialog owner={owner} address={address} isFirst={!address && !addresses?.length} onClose={close} />);
    if (saved) await changed();
  });
  const makeDefault = run(async (address: MemberAddress) => {
    await api.setDefaultAddress(owner.id, address.id);
    toast('已设为默认收货地址');
    await changed();
  });
  const remove = run(async (address: MemberAddress) => {
    const confirmed = await dialogs.open<boolean>(close => (
      <ConfirmDialog title="删除收货地址" confirmLabel="确认删除" onClose={close}
        message={<>确定删除「{address.fullAddress}」吗？{address.isDefault && addresses && addresses.length > 1 ? '删除后将自动把最近使用的地址设为默认。' : ''}已下单的水单保留下单时的地址快照，不受影响。</>}
        onConfirm={() => api.deleteAddress(owner.id, address.id)} />
    ));
    if (confirmed) { toast('收货地址已删除'); await changed(); }
  });

  const full = (addresses?.length ?? 0) >= MAX_MEMBER_ADDRESSES;
  return (
    <section className="address-book" aria-label="收货地址">
      <div className="h5-section-head membership-heading" style={{ margin: compact ? '0 0 10px' : undefined }}>
        <h3>收货地址{addresses ? `（${addresses.length}）` : ''}</h3>
        <button type="button" className="btn primary sm" disabled={!addresses || full} title={full ? `最多保存 ${MAX_MEMBER_ADDRESSES} 个地址` : undefined} onClick={() => edit()}>
          <Icon name="plus" size="sm" />新增地址
        </button>
      </div>
      {error && <p className="account-error" role="alert">{error}</p>}
      {!addresses ? <p className="membership-note">正在加载收货地址…</p> : addresses.length === 0 ? (
        <div className="address-empty">还没有收货地址。添加后，下单送水时会自动带出默认地址。</div>
      ) : (
        <div className="address-list">
          {addresses.map(address => (
            <article key={address.id} className={`address-card${address.isDefault ? ' is-default' : ''}`}>
              <div className="address-card-head">
                <b>{address.contactName}</b><span>{address.contactPhone}</span>
                {address.isDefault && <span className="tag green">默认</span>}
              </div>
              <AddressText address={address} />
              <div className="address-card-actions">
                {!address.isDefault && <button type="button" className="btn sm" onClick={() => makeDefault(address)}>设为默认</button>}
                <button type="button" className="btn sm" onClick={() => edit(address)}><Icon name="edit" size="sm" />编辑</button>
                <button type="button" className="btn sm danger" onClick={() => remove(address)}><Icon name="trash" size="sm" />删除</button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * Delivery address chooser for order forms. Selects the default address automatically and lets the
 * operator add a new one inline; the chosen id is sent with the order so the server snapshots it.
 */
export function AddressPicker({ owner, value, onChange }: { owner: AddressOwner; value: string | null; onChange: (addressId: string | null) => void }) {
  const dialogs = useDialogs();
  const run = useRun();
  const { addresses, error, reload } = useAddresses(owner.id);

  useEffect(() => {
    if (!addresses) return;
    if (!addresses.some(a => a.id === value)) onChange(addresses.find(a => a.isDefault)?.id ?? addresses[0]?.id ?? null);
  }, [addresses, onChange, value]);

  const add = run(async () => {
    const saved = await dialogs.open<MemberAddress>(close => <AddressFormDialog owner={owner} isFirst={!addresses?.length} onClose={close} />);
    if (saved) { await reload(); onChange(saved.id); }
  });

  if (error) return <p className="account-error" role="alert">{error}</p>;
  if (!addresses) return <p className="membership-note">正在加载收货地址…</p>;
  return (
    <div className="address-select" role="radiogroup" aria-label="选择收货地址">
      {addresses.length === 0 && <div className="address-empty">该会员还没有收货地址，请先新增。</div>}
      {addresses.map(address => (
        <button key={address.id} type="button" role="radio" className="address-option" aria-pressed={address.id === value} aria-checked={address.id === value} onClick={() => onChange(address.id)}>
          <Icon name="location" />
          <span>
            <b>{address.contactName} {address.contactPhone}</b>{address.isDefault && <span className="tag green" style={{ marginLeft: 6 }}>默认</span>}<br />
            {address.fullAddress}
          </span>
        </button>
      ))}
      {addresses.length < MAX_MEMBER_ADDRESSES && <button type="button" className="btn sm" onClick={add}><Icon name="plus" size="sm" />新增收货地址</button>}
    </div>
  );
}
