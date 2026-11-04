import SwiftUI
import KunlunCore

enum Brand {
    static let green = Color(red: 0.05, green: 0.48, blue: 0.41)
    static let background = Color(uiColor: .systemGroupedBackground)
    static let gradient = LinearGradient(colors: [green, Color(red: 0.02, green: 0.36, blue: 0.44)], startPoint: .topLeading, endPoint: .bottomTrailing)
}

extension Decimal {
    var yuan: String { formatted(.currency(code: "CNY").locale(Locale(identifier: "zh_CN"))) }
}
func displayDate(_ raw: String) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    var date = formatter.date(from: raw)
    if date == nil { formatter.formatOptions = [.withInternetDateTime]; date = formatter.date(from: raw) }
    guard let date else { return raw }
    return date.formatted(.dateTime.year().month().day().hour().minute().locale(Locale(identifier: "zh_CN")))
}

struct BrandMark: View {
    var body: some View {
        Image(systemName: "drop.fill").font(.system(size: 28, weight: .medium))
            .foregroundStyle(.white).frame(width: 56, height: 56)
            .background(Brand.gradient, in: RoundedRectangle(cornerRadius: 18))
            .accessibilityHidden(true)
    }
}
struct StoreHint: View {
    var body: some View {
        Label("订水、充值、交退押金，请到店或找送水员办理。店员登记后，记录在这里随时可查。", systemImage: "info.circle")
            .font(.footnote).foregroundStyle(.secondary).lineSpacing(4).padding()
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Brand.green.opacity(0.07), in: RoundedRectangle(cornerRadius: 16))
    }
}
struct Card<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 14) { content }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 22))
    }
}
struct StateView<Value, Content: View>: View {
    let state: LoadState<Value>
    let retry: () async -> Void
    @ViewBuilder var content: (Value) -> Content
    var body: some View {
        switch state {
        case .idle, .loading: ProgressView("正在加载…").frame(maxWidth: .infinity).padding(36)
        case .loaded(let value): content(value)
        case .failed(let message):
            ContentUnavailableView {
                Label("暂时无法加载", systemImage: "wifi.exclamationmark")
            } description: { Text(message) } actions: { Button("重试") { Task { await retry() } }.buttonStyle(.bordered) }
        }
    }
}
struct DetailLine: View {
    let title: String
    let value: String
    var body: some View {
        LabeledContent(title, value: value).font(.subheadline)
    }
}
struct OrderCard: View {
    let order: WaterOrder
    var body: some View {
        Card {
            HStack { Label(modeTitle(order.fulfillMode), systemImage: order.fulfillMode == "DELIVERY" ? "truck.box" : "storefront"); Spacer(); Text(order.statusTitle).foregroundStyle(Brand.green) }.font(.subheadline.weight(.medium))
            HStack(alignment: .firstTextBaseline) {
                Text(order.waterName).font(.headline)
                Spacer()
                Text("\(order.actualQty ?? order.orderQty) \(order.unit)").font(.title3.weight(.semibold)).monospacedDigit()
            }
            Text(displayDate(order.createdAt)).font(.caption).foregroundStyle(.secondary)
            if let code = order.pickupCode, order.status == "PENDING" {
                Label("取水码  \(code)", systemImage: "qrcode").font(.headline).textSelection(.enabled)
            }
            if let address = order.addressSnapshot.address, !address.isEmpty { Text(address).font(.footnote).foregroundStyle(.secondary) }
            if let remark = order.remark, !remark.isEmpty { Text("备注：\(remark)").font(.footnote) }
            if let reason = order.cancelReason, !reason.isEmpty { Text("取消原因：\(reason)").font(.footnote).foregroundStyle(.secondary) }
            Text(order.orderNo).font(.caption2.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
        }
    }
}
