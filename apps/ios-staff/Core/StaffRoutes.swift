import Foundation

/// What a request from the staff WebView resolves to.
public enum StaffResource: Equatable, Sendable {
    /// The React entry document; every staff page route renders it.
    case page
    /// A hashed build file, as a path inside the app bundle (`www/static/h5/…`).
    case asset(String)
    /// An API call, forwarded to the configured server with its path and query unchanged.
    case api(path: String, query: String?)
}

/// Decides what the staff WebView may load, like `StaffUrls` in the Android staff app.
///
/// The pages live in the app bundle and are served under `kunlun-staff://localhost`, so the React app keeps calling
/// `/api/…` on its own origin; those calls are forwarded to the server. Every other address is refused.
/// The host must stay `localhost`: WebKit only treats a custom-scheme page as a secure context on that host, and the
/// pages need one for `crypto.randomUUID()` (idempotency keys).
public enum StaffRoutes {
    public static let scheme = "kunlun-staff"
    public static let host = "localhost"
    public static let pages: Set<String> = ["/staff", "/staff/home", "/staff/order", "/staff/orders", "/staff/members", "/staff/inventory", "/staff/profile"]
    public static let start = URL(string: "kunlun-staff://localhost/staff")!

    public static func resource(for url: URL) -> StaffResource? {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme?.lowercased() == scheme, parts.host?.lowercased() == host,
              parts.user == nil, parts.password == nil, parts.port == nil else { return nil }
        let raw = parts.percentEncodedPath
        guard !raw.contains(".."), !raw.contains("//"), !parts.path.contains(".."), !parts.path.contains("//") else { return nil }
        if pages.contains(raw) { return .page }
        if raw.hasPrefix("/static/h5/"), raw.range(of: #"^[A-Za-z0-9_./-]+$"#, options: .regularExpression) != nil {
            return .asset("www" + raw)
        }
        if raw.hasPrefix("/api/") { return .api(path: raw, query: parts.percentEncodedQuery) }
        return nil
    }

    /// Only staff pages may be opened in the WebView: no other sites, apps or parts of the system.
    public static func allowsNavigation(to url: URL) -> Bool { resource(for: url) == .page }

    /// The server address of an API call.
    public static func upstream(path: String, query: String?, origin: StaffOrigin) -> URL? {
        guard var parts = URLComponents(url: origin.url, resolvingAgainstBaseURL: false) else { return nil }
        parts.percentEncodedPath = path
        parts.percentEncodedQuery = query
        return parts.url
    }
}
