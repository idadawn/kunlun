import Foundation

/// The server the staff app talks to: scheme, host and port, nothing else.
///
/// Release builds accept HTTPS only. Debug builds may also use plain HTTP on this Mac (`127.0.0.1` or
/// `localhost`), which the iOS simulator reaches directly, without any port forwarding.
public struct StaffOrigin: Equatable, Sendable {
    public let scheme: String
    public let host: String
    public let port: Int

    public init?(_ text: String, allowLoopbackHTTP: Bool) {
        guard let parts = URLComponents(string: text.trimmingCharacters(in: .whitespaces)),
              let scheme = parts.scheme?.lowercased(), let host = parts.host?.lowercased(), !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/" else { return nil }
        switch scheme {
        case "https": break
        case "http" where allowLoopbackHTTP && (host == "127.0.0.1" || host == "localhost"): break
        default: return nil
        }
        self.scheme = scheme
        self.host = host
        self.port = parts.port ?? (scheme == "https" ? 443 : 80)
    }

    public var url: URL {
        let standardPort = scheme == "https" ? 443 : 80
        return URL(string: "\(scheme)://\(host)\(port == standardPort ? "" : ":\(port)")")!
    }

    /// The origin to use at launch. Release builds take the HTTPS origin baked into Info.plist at build time;
    /// Debug builds take `-StaffOrigin <origin>` from the launch arguments when given, else the Info.plist value.
    public static func resolve(arguments: [String], configured: String, debug: Bool) -> StaffOrigin? {
        if debug, let flag = arguments.firstIndex(of: "-StaffOrigin"), arguments.indices.contains(flag + 1) {
            return StaffOrigin(arguments[flag + 1], allowLoopbackHTTP: true)
        }
        return StaffOrigin(configured, allowLoopbackHTTP: debug)
    }
}
