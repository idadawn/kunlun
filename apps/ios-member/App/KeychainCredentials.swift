import Foundation
import Security
import KunlunCore

@MainActor final class KeychainCredentials: CredentialStore {
    private let service: String
    init(service: String = "cn.idalee.kunlun.member") { self.service = service }
    private func query(_ environment: ServiceEnvironment) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: environment.rawValue]
    }
    func read(for environment: ServiceEnvironment) throws -> String? {
        var query = query(environment)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data, let token = String(data: data, encoding: .utf8) else { throw KeychainError(status: status) }
        return token
    }
    func save(_ token: String?, for environment: ServiceEnvironment) throws {
        let query = query(environment)
        let deleted = SecItemDelete(query as CFDictionary)
        guard deleted == errSecSuccess || deleted == errSecItemNotFound else { throw KeychainError(status: deleted) }
        guard let token else { return }
        var item = query
        item[kSecValueData as String] = Data(token.utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let status = SecItemAdd(item as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }
}
private struct KeychainError: LocalizedError {
    let status: OSStatus
    var errorDescription: String? { "无法访问安全登录存储（\(status)）" }
}
