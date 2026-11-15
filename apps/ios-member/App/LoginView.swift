import SwiftUI
import KunlunCore

struct LoginView: View {
    @Environment(MemberStore.self) private var store
    @Environment(\.demoMode) private var demo
    let onDemo: () -> Void
    let onLive: () -> Void
    @State private var account = ""
    @State private var password = ""
    @State private var showEnvironment = false
    @FocusState private var focused: Field?
    private enum Field { case account, password }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    VStack(alignment: .leading, spacing: 16) {
                        BrandMark()
                        Text("鲜活每一滴，\n好水到你家。").font(.system(.largeTitle, design: .rounded, weight: .bold)).lineSpacing(5)
                        Text("绿麒麟水站 · 会员中心").font(.subheadline).foregroundStyle(.secondary)
                    }.padding(.top, 28)
                    if let error = store.restoreError {
                        Card {
                            Text(error).font(.subheadline)
                            Button("重新验证登录") { Task { await store.restore() } }.buttonStyle(.borderedProminent)
                            Button("清除本机登录状态") { store.forgetLocalSession() }.font(.footnote)
                        }
                    } else {
                        VStack(alignment: .leading, spacing: 18) {
                            Text("会员登录").font(.title2.bold())
                            VStack(alignment: .leading, spacing: 8) {
                                Text("用户名").font(.subheadline)
                                TextField("门店为你设置的用户名", text: $account)
                                    .textContentType(.username).textInputAutocapitalization(.never).autocorrectionDisabled()
                                    .focused($focused, equals: .account).submitLabel(.next)
                                    .accessibilityIdentifier("login.account")
                                    .onSubmit { focused = .password }
                                    .padding(15).background(Brand.background, in: RoundedRectangle(cornerRadius: 12))
                            }
                            VStack(alignment: .leading, spacing: 8) {
                                Text("密码").font(.subheadline)
                                SecureField("请输入密码", text: $password).textContentType(.password)
                                    .focused($focused, equals: .password).submitLabel(.go)
                                    .accessibilityIdentifier("login.password")
                                    .onSubmit { signIn() }
                                    .padding(15).background(Brand.background, in: RoundedRectangle(cornerRadius: 12))
                            }
                            if let notice = store.notice { Text(notice).font(.footnote).foregroundStyle(Brand.green).accessibilityIdentifier("login.notice") }
                            Button(action: signIn) {
                                HStack { Spacer(); if store.busy { ProgressView().tint(.white) }; Text("登录").fontWeight(.semibold); Spacer() }.padding(.vertical, 10)
                            }.buttonStyle(.borderedProminent).controlSize(.large)
                                .disabled(store.busy || account.trimmingCharacters(in: .whitespaces).isEmpty || password.isEmpty)
                                .accessibilityIdentifier("login.submit")
                            Text("首次登录或忘记密码，请联系门店设置会员账号。").font(.footnote).foregroundStyle(.secondary).lineSpacing(3)
                        }.padding(22).background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 24))
                    }
                    StoreHint()
                    #if DEBUG
                    if demo { Button("返回真实登录", action: onLive).frame(maxWidth: .infinity) }
                    else { Button("体验演示（不连接服务器）", action: onDemo).font(.footnote).frame(maxWidth: .infinity).accessibilityIdentifier("login.demo") }
                    #endif
                }.padding(24).frame(maxWidth: 560)
                    .frame(maxWidth: .infinity)
            }.background(Brand.background).scrollDismissesKeyboard(.interactively)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button(demo ? "演示数据" : store.environment.title) { showEnvironment = true }
                            .font(.caption).disabled(store.busy || demo)
                    }
                }
                .confirmationDialog("选择登录环境", isPresented: $showEnvironment, titleVisibility: .visible) {
                    ForEach(ServiceEnvironment.allCases) { environment in
                        Button(environment.title) {
                            password = ""; account = ""
                            store.switchEnvironment(environment)
                            UserDefaults.standard.set(environment.rawValue, forKey: "service-environment")
                            Task { await store.restore() }
                        }
                    }
                }
        }
    }
    private func signIn() {
        guard !store.busy, !account.trimmingCharacters(in: .whitespaces).isEmpty, !password.isEmpty else { return }
        focused = nil
        let submitted = password
        Task { await store.login(account: account, password: submitted); password = "" }
    }
}
