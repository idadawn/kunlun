import SwiftUI
import KunlunCore

struct AccountView: View {
    @Environment(MemberStore.self) private var store
    @State private var passwordSheet: AccountSheet?
    @State private var confirmLogout = false
    @State private var offlineLogout = false
    private enum AccountSheet: String, Identifiable { case password; var id: String { rawValue } }
    var body: some View {
        List {
            Section {
                HStack(spacing: 16) {
                    BrandMark()
                    VStack(alignment: .leading, spacing: 6) {
                        Text(store.identity?.displayName ?? "会员").font(.title3.bold())
                        Text(store.identity?.phone ?? "").foregroundStyle(.secondary)
                        Text(store.identity?.codeOrNo ?? "").font(.caption.monospaced()).foregroundStyle(.secondary)
                    }
                }.padding(.vertical, 12)
            }
            Section("我的记录") {
                NavigationLink { RechargeView() } label: { Label("充值记录", systemImage: "ticket") }
                NavigationLink { AddressView() } label: { Label("收货地址", systemImage: "mappin.and.ellipse") }
            }
            Section("账户") {
                Button { passwordSheet = .password } label: { Label("修改密码", systemImage: "lock.rotation") }.disabled(store.busy)
                LabeledContent("当前服务", value: store.environment.title)
                Button(role: .destructive) { confirmLogout = true } label: { Label("退出登录", systemImage: "rectangle.portrait.and.arrow.right") }
                    .disabled(store.busy).accessibilityIdentifier("account.logout")
            }
            Section {
                StoreHint().listRowInsets(EdgeInsets())
            }
        }.navigationTitle("我的")
            .sheet(item: $passwordSheet) { _ in PasswordView() }
            .confirmationDialog("退出当前会员账号？", isPresented: $confirmLogout, titleVisibility: .visible) {
                Button("退出登录", role: .destructive) { Task { if !(await store.logout()) { offlineLogout = true } } }
            } message: { Text("退出会使当前账号已有登录失效。") }
            .alert("服务器退出未完成", isPresented: $offlineLogout) {
                Button("稍后重试", role: .cancel) {}
                Button("仅清除本机登录", role: .destructive) { store.forgetLocalSession() }
            } message: { Text("\(store.notice ?? "网络暂时不可用")。仅清除本机会删除此设备的令牌，无法确认服务器端令牌已撤销。") }
    }
}

struct AddressView: View {
    @Environment(MemberStore.self) private var store
    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                StateView(state: store.addresses, retry: { await store.loadAddresses() }) { addresses in
                    if addresses.isEmpty { ContentUnavailableView("暂无收货地址", systemImage: "mappin.slash", description: Text("请联系门店添加收货地址。")) }
                    ForEach(addresses) { address in
                        Card {
                            HStack { Text(address.contactName).font(.headline); Text(address.contactPhone).font(.subheadline); Spacer(); if address.isDefault { Text("默认").font(.caption).foregroundStyle(Brand.green) } }
                            Text(address.fullAddress).font(.subheadline)
                        }
                    }
                    Text("地址由门店维护，如需修改请联系店员。").font(.footnote).foregroundStyle(.secondary)
                }
            }.padding(20).frame(maxWidth: 700).frame(maxWidth: .infinity)
        }.background(Brand.background).navigationTitle("收货地址")
            .task { await store.loadAddresses() }.refreshable { await store.loadAddresses() }
    }
}

struct PasswordView: View {
    @Environment(MemberStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var current = ""
    @State private var new = ""
    @State private var confirmation = ""
    @State private var error: String?
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    SecureField("当前密码", text: $current).textContentType(.password)
                    SecureField("新密码（8–128 位）", text: $new).textContentType(.newPassword)
                    SecureField("再次输入新密码", text: $confirmation).textContentType(.newPassword)
                } footer: { Text("修改成功后需要重新登录。") }
                if let error { Section { Text(error).foregroundStyle(.red).font(.footnote) } }
                Section {
                    Button {
                        guard new == confirmation else { error = "两次新密码不一致"; return }
                        Task {
                            if await store.changePassword(current: current, new: new) { dismiss() }
                            else { error = store.notice }
                        }
                    } label: { HStack { Text("保存新密码"); if store.busy { Spacer(); ProgressView() } } }
                        .disabled(store.busy || current.isEmpty || new.count < 8 || new.count > 128 || confirmation.isEmpty)
                }
            }.navigationTitle("修改密码").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() }.disabled(store.busy) } }
                .interactiveDismissDisabled(store.busy)
        }
    }
}
