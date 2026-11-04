import Foundation

public enum ServiceEnvironment: String, CaseIterable, Identifiable, Sendable {
    case production, test
    public var id: String { rawValue }
    public var title: String { self == .production ? "绿麒麟水站" : "测试环境" }
    public var baseURL: URL {
        URL(string: self == .production ? "https://kunlun.idalee.cn" : "https://kunlun-test.idalee.cn")!
    }
}

public struct MemberIdentity: Codable, Sendable {
    public let subjectId: String
    public let subjectType: String
    public let displayName: String
    public let codeOrNo: String
    public let phone: String
    public let role: String
    public var isMember: Bool { subjectType == "MEMBER" && role == "MEMBER" && UUID(uuidString: subjectId) != nil }
}

public struct LoginResponse: Decodable, Sendable {
    public let accessToken: String
    public let identity: MemberIdentity
    public init(from decoder: any Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        accessToken = try values.decode(String.self, forKey: .accessToken)
        identity = try MemberIdentity(from: decoder)
    }
    private enum CodingKeys: String, CodingKey { case accessToken }
}

public struct MemberProfile: Decodable, Sendable {
    public let id: String
    public let memberNo: String
    public let name: String
    public let phone: String
    public let defaultAddress: String?
    public let tickets: [MemberTicket]
    public let depositAmount: Decimal
    public let heldBuckets: Int
    public let heldBags: Int
}

public struct MemberTicket: Decodable, Identifiable, Sendable {
    public let waterType: String
    public let name: String
    public let containerType: String
    public let unit: String
    public let fulfillMode: String
    public let available: Int
    public let reserved: Int
    public var id: String { waterType + ":" + fulfillMode }
}

public struct Page<Row: Decodable & Sendable>: Decodable, Sendable {
    public let rows: [Row]
    public let total: Int
    public let page: Int
    public let pageSize: Int
    public var hasMore: Bool { page * pageSize < total }
}

public struct WaterOrder: Decodable, Identifiable, Sendable {
    public let id: String
    public let orderNo: String
    public let waterType: String
    public let fulfillMode: String
    public let orderQty: Int
    public let actualQty: Int?
    public let pickupCode: String?
    public let addressSnapshot: OrderAddress
    public let productSnapshot: OrderProduct?
    public let status: String
    public let createdAt: String
    public let remark: String?
    public let cancelReason: String?
    public var waterName: String { productSnapshot?.waterLabel ?? waterType }
    public var unit: String {
        switch productSnapshot?.containerType { case "BAG": "袋"; case "BUCKET": "桶"; default: "份" }
    }
    public var statusTitle: String {
        switch status {
        case "PENDING": "待办理"
        case "DISPATCHED": "配送中"
        case "COMPLETED": "已完成"
        case "CANCELLED": "已取消"
        default: status
        }
    }
}

public struct OrderAddress: Decodable, Sendable {
    public let contactName: String?
    public let contactPhone: String?
    public let address: String?
}

public struct OrderProduct: Decodable, Sendable {
    public let waterLabel: String
    public let containerType: String?
}

public struct TicketBatch: Decodable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let source: String
    public let waterLabel: String
    public let fulfillMode: String
    public let paidAmount: Decimal
    public let fixedQty: Int
    public let giftQty: Int
    public let remainingBuy: Int
    public let remainingGift: Int
    public let reservedBuy: Int
    public let reservedGift: Int
    public let status: String
    public let createdAt: String
    public let rechargeNo: String
    public let refundedAmount: Decimal
    public let pendingRequestNo: String?
    public let pendingGiftQty: Int?
}

public struct DepositSummary: Decodable, Identifiable, Sendable {
    public let containerType: String
    public let paidQty: Int
    public let paidAmount: Decimal
    public let heldQty: Int
    public let pendingDamageQty: Int
    public let pendingDamageAmount: Decimal
    public let refundableQty: Int
    public let refundableAmount: Decimal
    public let pendingRefundQty: Int
    public var id: String { containerType }
    public var title: String { containerType == "BUCKET" ? "周转桶" : "周转水袋" }
}

public struct MemberAddress: Decodable, Identifiable, Sendable {
    public let id: String
    public let contactName: String
    public let contactPhone: String
    public let fullAddress: String
    public let isDefault: Bool
}

public enum LoadState<Value> {
    case idle, loading, loaded(Value), failed(String)
    public var value: Value? { if case .loaded(let value) = self { value } else { nil } }
}

public func modeTitle(_ value: String) -> String {
    switch value { case "DELIVERY": "送水上门"; case "PICKUP": "到店取水"; default: value }
}
